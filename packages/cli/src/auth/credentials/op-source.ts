/**
 * op-source — the lazy 1Password seam BEHIND the credential authority.
 *
 * This is the single place that knows how to pull a provider's API key out of
 * 1Password ON DEMAND. The authority calls `resolveOpKeyForEnvVars(wanted)` only
 * when env/config/oauth-file have all missed for a provider — so a non-op user,
 * or an op user whose key is already in the shell env, never reaches the SDK.
 *
 * LAZINESS GATE: `hasOpSources()` is a cheap SYNC sniff (one readFileSync of
 * config.json + an argv scan for --op/--op-env). It returns false — WITHOUT
 * importing `@1password/sdk` or its ~10MB WASM — when there is no 1Password
 * source at all. The authority calls it before ever attempting an op resolve.
 *
 * SERIALIZATION: every SDK touch goes through the resolver functions in
 * onepassword.ts, which already wrap calls in `runSdkExclusive` (the -4 IPC
 * fix). This module adds no new concurrency.
 *
 * GLOB SINGLE-FLIGHT: a configured glob (op://Vault/Item/**) is resolved ONCE
 * per process — the first resolve discovers the item and batch-resolves ALL
 * matching env vars into `resolvedCache`; every other provider's resolve is a
 * cache pick, not a re-discovery (see resolveGlobShared). Without this, the
 * 26-provider config-TUI startup re-ran the full discovery per provider,
 * serialized — ~34s of redundant SDK work on a 36s launch.
 *
 * AUTH POLICY: a multi-account / no-auth failure is surfaced as a thrown
 * `OpAuthError`. The caller chooses what to do via `onAuthFailure`:
 *   - "throw"  (default for explicit --op/--op-env flags) → propagate, hard-fail.
 *   - "skip"   (config-driven routing) → the authority catches it and the
 *     provider resolves as "not available", so the MCP/serve server keeps
 *     running instead of dying at startup.
 *
 * This module replaces the per-entry-point PUSH-into-process.env machinery that
 * used to live in index.ts (loadStoredApiKeys / applyCustomEndpointOpKeys /
 * getSdkAuth). There is no "resolve everything" pass here — resolution is
 * strictly scoped to the env-var names a caller asks for.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeGlobalConfigFile } from "../../config-override.js";
import {
  readAllOnepasswordEnvironmentEntries,
  readAllOnepasswordImportEntries,
  readOnepasswordAccount,
  saveOnepasswordAccount as saveOpConfigAccount,
} from "../../providers/onepassword-config.js";
import type { AccountInfo, SdkAuth, SdkClientFactory } from "../../providers/onepassword.js";
import { type OpSourceEntry, groupEntriesByAccount } from "../../providers/op-source-entry.js";
import { type SpanMeta, addSpanMeta, beginQueuedSpan, traceSpan } from "../../startup-trace.js";

/**
 * Warn ONCE per process for each distinct op failure message.
 *
 * A bare model name credential-filters a routing CHAIN, so one child process
 * asks the authority about several candidate providers. When 1Password is
 * failing (e.g. the desktop app denied this process's SDK client), every one of
 * those asks fails identically and used to print its own line — a single child
 * emitted four consecutive
 *
 *   "[claudish] 1Password environment skipped: ... Denied authorization ..."
 *
 * lines. Repetition reads as a cascade of distinct failures and it showed up in
 * the error logs of models that ultimately SUCCEEDED (the candidate that got
 * used had its key in env all along), which is a large part of why this bug
 * looked like "claudish ignores my 1Password config". One line per distinct
 * failure is the whole signal; the rest is noise.
 *
 * Message text only — no key material is ever part of these strings.
 */
const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.error(message);
}

/** Test-only: forget which warnings have been emitted. */
export function __resetWarnOnceForTests(): void {
  warnedMessages.clear();
}

// ── The parent→child "1Password does not have this" skip-list ───────────────

/**
 * Env vars this process asked 1Password for and 1Password answered it does not
 * hold. Run-scoped, names only — the negative counterpart to
 * `recordOpHydratedVars`.
 *
 * WHY: a bare model name credential-filters a CHAIN of candidate providers. The
 * parent short-circuits at the first credentialed candidate, but each spawned
 * child walks its own chain from the top — so it misses e.g. ZHIPU_API_KEY in
 * env and opens its OWN SDK client for it, concurrently with its siblings.
 * That is precisely the handshake race (onepassword-handshake-lock.ts). The
 * keys 1Password CAN supply are already handled: pre-hydration puts them in
 * env and the child never asks. It is the keys 1Password does NOT have that
 * keep sending children to the SDK for a value that was never going to be
 * there.
 *
 * `prehydrateCredentialsForSpawn` publishes this set to children through
 * CLAUDISH_OP_UNAVAILABLE so they can skip those vars outright.
 */
const opUnavailableVars = new Set<string>();

/** Env var carrying the skip-list from a parent claudish to its children. */
export const OP_UNAVAILABLE_ENV = "CLAUDISH_OP_UNAVAILABLE";

/** Record env vars that a CLEAN 1Password resolve came back empty for. */
export function recordOpUnavailableVars(names: Iterable<string>): void {
  for (const n of names) {
    if (typeof n === "string" && n.length > 0) opUnavailableVars.add(n);
  }
}

/** The names 1Password answered it does not hold, this run. */
export function getOpUnavailableVars(): readonly string[] {
  return [...opUnavailableVars].sort();
}

/** Test-only: forget this run's unavailable-var record. */
export function __resetOpUnavailableForTests(): void {
  opUnavailableVars.clear();
}

/**
 * The skip-list INHERITED from a parent process — never this process's own
 * record.
 *
 * The distinction is deliberate. Within a process a miss is intentionally NOT
 * cached (`api-key-credential.ts`): it may be a transient auth failure, and
 * caching it would mark a provider permanently unavailable off one blip. The
 * inherited list is different in kind — the parent only publishes it after
 * confirming 1Password answered with NO failures recorded, so "absent" there
 * means genuinely absent, not "we were denied".
 */
function inheritedUnavailable(): Set<string> {
  const raw = process.env[OP_UNAVAILABLE_ENV];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

/** Thrown when no usable 1Password SDK auth can be resolved. */
export class OpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpAuthError";
  }
}

/** What to do when SDK auth resolution fails. */
export type OnAuthFailure = "throw" | "skip";

// ── Lazy SDK-auth resolution (memoized once per process) ────────────────────

let cachedSdkAuth: SdkAuth | undefined;
let sdkAuthResolved = false;
let authInFlight: Promise<SdkAuth | undefined> | undefined;

/**
 * Persist a picked account URL as `onepasswordAccount`. Best-effort: a save
 * failure only means the user is re-prompted next run.
 */
function saveAccount(accountUrl: string, scope: "global" | "project"): void {
  try {
    saveOpConfigAccount(accountUrl, scope);
  } catch {
    // Non-fatal — the account is still used for THIS run via the returned auth.
  }
}

/** Ask whether to save the picked account globally or for this project only. */
async function pickSaveScope(): Promise<"global" | "project"> {
  const { createInterface } = await import("node:readline");
  process.stderr.write(
    "\n[claudish] Remember this account for:\n" +
      "  1) all projects (global ~/.claudish/config.json)  [default]\n" +
      "  2) this project only (./.claudish.json)\n"
  );
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Scope [1-2]: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  return answer === "2" ? "project" : "global";
}

/** Interactive multi-account picker (only invoked when stdout is a TTY). */
async function pickOnepasswordAccount(accounts: AccountInfo[]): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  process.stderr.write("\n[claudish] Multiple 1Password accounts found. Choose one:\n");
  accounts.forEach((a, i) => {
    process.stderr.write(`  ${i + 1}) ${a.url}${a.email ? `  (${a.email})` : ""}\n`);
  });
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Account [1-${accounts.length}]: `, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  const idx = Number.parseInt(answer, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > accounts.length) {
    process.stderr.write("[claudish] No valid selection — aborting 1Password account picker.\n");
    return undefined;
  }
  return accounts[idx - 1].url;
}

/**
 * Resolve SDK auth at most once per process. Multi-account users are prompted at
 * most once (and the choice is saved to config). The interactive picker is only
 * offered when `allowPrompt` is set AND stdout is a TTY AND we're not in --stdin
 * mode — so MCP/serve (non-TTY) never block on a prompt.
 *
 * On failure: throws OpAuthError. The caller decides whether that's fatal
 * (explicit flag) or a soft "provider unavailable" (config-driven routing).
 */
async function getSdkAuth(allowPrompt: boolean): Promise<SdkAuth | undefined> {
  if (sdkAuthResolved) return cachedSdkAuth;
  // In-flight dedup: concurrent callers (e.g. the model selector resolving 16
  // providers at once) share ONE auth resolution. Without this, a second caller
  // arriving while the first awaits would see a half-set latch and get undefined
  // auth → spurious "no account" failures. The Promise is the single source of
  // truth until it settles.
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    const { resolveSdkAuth } = await import("../../providers/onepassword.js");
    const interactive =
      allowPrompt && Boolean(process.stdout.isTTY) && !process.argv.includes("--stdin");
    try {
      // Startup-trace: auth resolution may run `op account list` and, for a
      // multi-account user, an INTERACTIVE picker — hence mayIncludeUserPrompt.
      const auth = await traceSpan(
        "op:auth-resolve",
        () =>
          resolveSdkAuth({
            configAccount: readOnepasswordAccount(),
            interactive,
            onNeedsPicker: async (accounts) => {
              const chosen = await pickOnepasswordAccount(accounts);
              if (chosen) {
                const scope = await pickSaveScope();
                saveAccount(chosen, scope);
              }
              return chosen;
            },
          }),
        { mayIncludeUserPrompt: true, interactive }
      );
      cachedSdkAuth = auth;
      sdkAuthResolved = true;
      return auth;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpAuthError(message);
    } finally {
      authInFlight = undefined;
    }
  })();

  return authInFlight;
}

/**
 * The auth to use for ONE source, honouring an account declared on the entry.
 *
 * Precedence, and why:
 *
 *  1. `OP_SERVICE_ACCOUNT_TOKEN` — a service-account token is authorized by its
 *     value and is already bound to one account, so a declared account has
 *     nothing left to select. Token users get the token for every source.
 *  2. `entry.account` — a declaration written next to the source. Beats the
 *     ambient rules deliberately: it is a stronger statement of intent than an
 *     env var that happens to be set, and it is the only thing that can express
 *     "these keys are in account A, those in B".
 *  3. the ambient auth (`OP_ACCOUNT` → `onepasswordAccount` → single account →
 *     interactive picker), for entries that declare nothing.
 *
 * No extra caching is needed to make this one-dialog-per-account:
 * `defaultSdkClientFactory` already keys its client cache on the auth, and
 * `withHandshakeLock` already serializes handshakes machine-wide. Two accounts
 * produce two cache entries and two authorizations; ten sources in one account
 * produce one.
 */
async function authForEntry(
  entry: OpSourceEntry,
  allowPrompt: boolean
): Promise<SdkAuth | undefined> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (token) return { kind: "token", token };
  if (entry.account) return { kind: "desktop", accountName: entry.account };
  return getSdkAuth(allowPrompt);
}

/** Test-only: reset the memoized auth latch. */
export function __resetSdkAuthForTests(): void {
  cachedSdkAuth = undefined;
  sdkAuthResolved = false;
  authInFlight = undefined;
}

/**
 * Public auth accessor for the EXPLICIT-flag callers (--op / --op-env) in
 * index.ts. These are direct user intent, so they prompt (allowPrompt=true) and
 * a failure throws OpAuthError (hard-fail). Memoized once per process.
 */
export function resolveExplicitFlagAuth(): Promise<SdkAuth | undefined> {
  return getSdkAuth(true);
}

// ── Sync sniff: is there ANY 1Password source? ──────────────────────────────

interface SniffedConfig {
  apiKeys?: Record<string, string>;
  onepassword?: string[];
  onepasswordEnvironments?: string[];
  customEndpoints?: Record<string, unknown>;
}

/**
 * Hermetic test seams (no mock.module — Bun's module mocks are process-global
 * and bleed across sibling test files). When set, the config read, the SDK
 * client construction, and the auth resolution are all answered in-memory so
 * the resolve pipeline (single-flight glob memoization included) is testable
 * without the real ~/.claudish/config.json, the op binary, or the SDK/WASM.
 */
interface OpSourceTestSeams {
  /** Replaces the ~/.claudish/config.json read. */
  config?: SniffedConfig;
  /** Threaded into every onepassword.ts resolution call (fake SDK client). */
  sdkFactory?: SdkClientFactory;
  /** Skips getSdkAuth() entirely (no account resolution, no prompts). */
  auth?: SdkAuth;
}
let testSeams: OpSourceTestSeams | undefined;

/** Test-only: install (or clear, with undefined) the hermetic seams above. */
export function __setOpSourceSeamsForTests(seams: OpSourceTestSeams | undefined): void {
  testSeams = seams;
}

function readConfigRaw(): SniffedConfig {
  if (testSeams?.config) return testSeams.config;
  try {
    // Honor a `--config` override: the sniff must read the SAME file the rest of
    // the run reads, so an override file that names no op:// source correctly
    // makes hasOpSources() false (no SDK, no auth prompt).
    const configPath = activeGlobalConfigFile(join(homedir(), ".claudish", "config.json"));
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as SniffedConfig;
  } catch {
    return {};
  }
}

/**
 * Cheap SYNC check: does this run have ANY 1Password source? Reads config.json
 * (raw) + scans argv for --op/--op-env + config environments. Returns false
 * WITHOUT importing the SDK — this is the laziness gate. Memoized: the config
 * file doesn't change mid-run.
 */
let sniffed: boolean | undefined;
export function hasOpSources(): boolean {
  if (sniffed !== undefined) return sniffed;
  sniffed = computeHasOpSources();
  return sniffed;
}

function computeHasOpSources(): boolean {
  // Escape hatch: CLAUDISH_DISABLE_OP=1 forces "no op source" without touching
  // the SDK. Used by hermetic tests (so route()/isAvailable never resolve a real
  // op:// key from the host's config) and available to users who want to disable
  // 1Password for a single run. Mock-free → no cross-file test bleed.
  if (process.env.CLAUDISH_DISABLE_OP === "1") return false;

  const argv = process.argv.slice(2);
  if (
    argv.some(
      (a) => a === "--op" || a.startsWith("--op=") || a === "--op-env" || a.startsWith("--op-env=")
    )
  ) {
    return true;
  }
  if (configEnvironmentIds().length > 0) return true;

  const cfg = readConfigRaw();
  // A single op:// ref sitting in apiKeys.
  if (cfg.apiKeys) {
    for (const v of Object.values(cfg.apiKeys)) {
      if (typeof v === "string" && v.startsWith("op://")) return true;
    }
  }
  // The dedicated onepassword[] array (globs + single refs).
  if (
    Array.isArray(cfg.onepassword) &&
    cfg.onepassword.some((e) => typeof e === "string" && e.trim().startsWith("op://"))
  ) {
    return true;
  }
  // A custom endpoint whose apiKey is an op:// ref.
  if (cfg.customEndpoints && typeof cfg.customEndpoints === "object") {
    for (const raw of Object.values(cfg.customEndpoints)) {
      if (raw && typeof raw === "object") {
        const apiKey = (raw as { apiKey?: unknown }).apiKey;
        if (typeof apiKey === "string" && apiKey.startsWith("op://")) return true;
      }
    }
  }
  return false;
}

/** Test-only: reset the sniff cache (config can change between tests). */
export function __resetSniffForTests(): void {
  sniffed = undefined;
}

// ── Per-env-var on-demand resolution ────────────────────────────────────────

// Process-wide serialization of op resolution. The 1Password SDK's WASM↔desktop
// IPC bridge is NOT safe for concurrent calls (overlapping ops corrupt the
// channel → "IPC operation failed: -4"). The model selector / config TUI resolve
// many providers AT ONCE, so we chain every resolution through this queue: at
// most one runs at a time. (Mirrors onepassword.ts's runSdkExclusive, but at the
// op-source orchestration layer so the whole resolve — discovery + secrets — is
// one critical section.)
let opQueue: Promise<unknown> = Promise.resolve();

/** Span-meta hook handed to the op body so it can annotate its own queued span
 *  (e.g. { globCacheHit: true } when the resolve was served from the shared
 *  glob cache with ~0 exec). Merged into the span at end(). */
interface OpSpanCtx {
  addMeta(m: SpanMeta): void;
}

function runOpExclusive<T>(
  op: (span: OpSpanCtx) => Promise<T>,
  label = "op:resolve",
  meta?: SpanMeta
): Promise<T> {
  // Startup-trace: this queue serializes the concurrent per-provider credential
  // resolutions (config TUI / model selector resolve ~16 providers at once), so
  // the waitMs/execMs split here is what reveals a startup queue pile-up.
  const span = beginQueuedSpan(label, meta);
  let extraMeta: SpanMeta = {};
  const ctx: OpSpanCtx = {
    addMeta(m) {
      extraMeta = { ...extraMeta, ...m };
    },
  };
  const timedOp = () => {
    span.start();
    return op(ctx);
  };
  const run = opQueue.then(timedOp, timedOp);
  run.then(
    () => span.end(extraMeta),
    (err) =>
      span.end({ ...extraMeta, error: true, errorMsg: String(err).split("\n")[0].slice(0, 120) })
  );
  // Keep the chain alive even if this op rejects (next op still runs).
  opQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Per-process cache of resolved env-var values. Once a glob is discovered and an
// env var resolved, a later provider asking for the SAME var is served from here
// — no second SDK round-trip. This is what makes the serialized 26-provider
// resolution cheap: the shared config glob is discovered ONCE.
const resolvedCache = new Map<string, string>();

// ── Single-flight + full-result memoization per GLOB ─────────────────────────
// The measured startup pathology: 26 providers each triggered a FULL glob
// resolution (vaults.list + items.list + items.get + secrets.resolveAll, ~1-2s
// exec each) against the SAME configured glob, serialized through the op queue
// → ~34s of redundant re-discovery. Fix: the FIRST resolve of a glob runs ONE
// full resolution (all matching env vars, batched) and memoizes the promise;
// every concurrent/subsequent caller awaits that same promise and picks its
// env vars out of the shared result. A REJECTED resolution is evicted from the
// map so the next request retries (failures are never cached).
const globResolutions = new Map<string, Promise<Record<string, string>>>();
// Env-var names populated by a glob resolution — lets a later cache-served
// resolve annotate its span with { globCacheHit: true } (observability only).
const globResolvedVars = new Set<string>();

// ── Single-flight per 1Password ENVIRONMENT (getVariables is all-or-nothing) ──
// Environments (config `onepasswordEnvironments[]` + the `--op-env` flag) resolve
// POINT-OF-NEED, mirroring globs: the FIRST provider key that misses env/config
// triggers ONE getVariables(id) which loads the WHOLE environment into
// resolvedCache; later keys are cache hits. No-key operations (`--update`,
// `--version`, OAuth-only codex sessions) never resolve a key → the SDK is never
// touched → no DesktopAuth prompt. A REJECTED resolution is evicted so the next
// request retries. This replaces the old eager `applyOpEnvironment()` hydration
// that prompted on every process launch (the "storm").
const environmentResolutions = new Map<string, Promise<Record<string, string>>>();

/** 1Password Environment ids passed via the `--op-env` flag (argv-derived). */
function flagEnvironmentIds(): string[] {
  const argv = process.argv.slice(2);
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--op-env") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) ids.push(v);
    } else if (a.startsWith("--op-env=")) {
      const v = a.slice("--op-env=".length);
      if (v) ids.push(v);
    }
  }
  return ids;
}

/**
 * Config environment ids (`onepasswordEnvironments[]`) — SEAM-AWARE so tests can
 * inject them like every other op source. In production reads local+global config
 * (deduped) via readAllOnepasswordEnvironments; under a test seam reads the
 * injected SniffedConfig. Mirrors how readConfigRaw() gates the other sources.
 */
function configEnvironmentIds(): string[] {
  return configEnvironmentEntries().map((e) => e.value);
}

/**
 * Config environments as ENTRIES, so each carries the account it was declared
 * against. The test seam still injects plain ids; those parse as undeclared and
 * fall back to the ambient auth, which is what every existing test expects.
 */
function configEnvironmentEntries(): OpSourceEntry[] {
  if (testSeams?.config) {
    return (testSeams.config.onepasswordEnvironments ?? []).map((value) => ({ value }));
  }
  return readAllOnepasswordEnvironmentEntries();
}

/**
 * All registered environments as entries: config first, then `--op-env` flags.
 * A flag carries no account by construction — it is an ad-hoc, one-off source
 * with nowhere to put one — so it resolves through the ambient rules
 * (`OP_ACCOUNT` being the intended override there).
 */
function registeredEnvironmentEntries(): OpSourceEntry[] {
  const seen = new Set<string>();
  const out: OpSourceEntry[] = [];
  for (const entry of [
    ...configEnvironmentEntries(),
    ...flagEnvironmentIds().map((value) => ({ value })),
  ]) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    out.push(entry);
  }
  return out;
}

/**
 * Mask a glob for a trace-span label: vault + pattern kept, long item titles
 * mid-truncated. Vault/item TITLES are allowed in spans (they already appear in
 * stderr warnings) — this only bounds the label length; field VALUES never
 * appear anywhere near here.
 */
function maskGlobForTrace(globPath: string): string {
  const body = globPath.startsWith("op://") ? globPath.slice("op://".length) : globPath;
  const segments = body.split("/");
  if (segments.length < 2) return globPath.slice(0, 48);
  const [vault, item, ...rest] = segments;
  const maskedItem = item.length > 20 ? `${item.slice(0, 12)}…${item.slice(-4)}` : item;
  return `op://${vault}/${maskedItem}/${rest.join("/")}`;
}

/**
 * Resolve a glob ONCE per process (single-flight + memoized full result).
 *
 *  - First caller: runs the full pipeline (discover the item ONCE, batch-resolve
 *    ALL matching env vars) inside an `op:glob-resolve(<masked glob>)` span, then
 *    populates `resolvedCache` with EVERY resolved var so later point-of-need
 *    resolves (post-startup, TUI) are pure cache hits.
 *  - Concurrent/subsequent callers: await the SAME promise ({ cacheHit: true }).
 *  - Failure: the promise is evicted from the map → the next request retries.
 *    (An EMPTY result is a success — memoized — matching the old non-throwing
 *    "this glob holds none of the wanted keys" semantics.)
 */
async function resolveGlobShared(
  globPath: string,
  auth: SdkAuth | undefined
): Promise<{ resolved: Record<string, string>; cacheHit: boolean }> {
  const existing = globResolutions.get(globPath);
  if (existing) return { resolved: await existing, cacheHit: true };

  const spanName = `op:glob-resolve(${maskGlobForTrace(globPath)})`;
  const promise = (async () => {
    const { resolveGlobImportAll, recordOpHydratedVars, withSdkRetry } = await import(
      "../../providers/onepassword.js"
    );
    // The warn sink surfaces per-field diagnostics (duplicate titles, an
    // unresolvable field like a `tooManyMatchingFields` duplicate label). The
    // resolution runs ONCE per process, so these print at most once per launch.
    //
    // Wrapped for lock recovery — see resolveEnvironmentShared for why the wrap
    // is here and not inside the onepassword.ts function.
    const resolved = await traceSpan(spanName, () =>
      withSdkRetry(
        () =>
          resolveGlobImportAll(globPath, {
            auth,
            sdkFactory: testSeams?.sdkFactory,
            warn: (m) => console.error(m),
          }),
        spanName
      )
    );
    addSpanMeta(spanName, { vars: Object.keys(resolved).length });
    // Populate the shared value cache with EVERYTHING the glob holds, and record
    // provenance so the TUI/--probe show "From: 1Password" for cache-served vars.
    for (const [k, v] of Object.entries(resolved)) {
      resolvedCache.set(k, v);
      globResolvedVars.add(k);
    }
    recordOpHydratedVars(Object.keys(resolved));
    return resolved;
  })();
  globResolutions.set(globPath, promise);
  // Failed resolutions must NOT be memoized: evict so the next caller retries.
  promise.catch(() => {
    if (globResolutions.get(globPath) === promise) globResolutions.delete(globPath);
  });
  return { resolved: await promise, cacheHit: false };
}

/**
 * Resolve a 1Password Environment ONCE per process (single-flight + memoized),
 * mirroring resolveGlobShared. `getVariables(id)` is all-or-nothing — it returns
 * EVERY variable in the environment — so the first needed key pulls the whole
 * set into `resolvedCache`; every later key (this process, or a child that
 * inherited none) is a cache hit. Failure evicts the memo → the next request
 * retries. Never mutates process.env — the authority owns the write-through.
 */
async function resolveEnvironmentShared(
  envId: string,
  auth: SdkAuth | undefined
): Promise<{ resolved: Record<string, string>; cacheHit: boolean }> {
  const existing = environmentResolutions.get(envId);
  if (existing) return { resolved: await existing, cacheHit: true };

  const spanName = `op:env-resolve(${envId})`;
  const promise = (async () => {
    const { readEnvironment, recordOpHydratedVars, withSdkRetry } = await import(
      "../../providers/onepassword.js"
    );
    // withSdkRetry HERE, not inside readEnvironment: the config TUI already wraps
    // its own calls, and runSdkExclusive is a promise-chain queue — a nested
    // wrap would enqueue behind the op that is waiting for it and deadlock.
    // Wrapping at the credential-path call site keeps the two paths disjoint.
    //
    // This is what makes lock recovery reachable from a NORMAL run. Until now
    // withSdkRetry was called only from tui/App.tsx, so the whole
    // locked-denial countdown existed but could never fire for
    // `claudish --model X` or `team` — exactly where a silent denial costs the
    // most, because it presents as "API key required" for a key that is in
    // 1Password and the run has already been abandoned by then.
    const resolved = await traceSpan(spanName, () =>
      withSdkRetry(
        () => readEnvironment(envId, { auth, sdkFactory: testSeams?.sdkFactory }),
        spanName
      )
    );
    addSpanMeta(spanName, { vars: Object.keys(resolved).length });
    // Populate the shared value cache with EVERYTHING the environment holds, and
    // record provenance so the TUI/--probe show "From: 1Password" for cache-served
    // vars (reuse globResolvedVars as the "came from op" provenance set).
    for (const [k, v] of Object.entries(resolved)) {
      resolvedCache.set(k, v);
      globResolvedVars.add(k);
    }
    recordOpHydratedVars(Object.keys(resolved));
    return resolved;
  })();
  environmentResolutions.set(envId, promise);
  promise.catch(() => {
    if (environmentResolutions.get(envId) === promise) environmentResolutions.delete(envId);
  });
  return { resolved: await promise, cacheHit: false };
}

/**
 * Drop every memoized op resolution (resolved values, per-glob full results,
 * and the op-source sniff). Called by the TUI after a 1Password add/edit
 * (hydrate-on-add) so item edits are re-discovered without restarting claudish.
 * Process-lifetime in-memory caches only — nothing on disk to clear.
 */
export function invalidateOpResolutionCache(): void {
  resolvedCache.clear();
  globResolutions.clear();
  globResolvedVars.clear();
  environmentResolutions.clear();
  // The config just changed (e.g. FIRST-ever glob added) — re-sniff on next use.
  sniffed = undefined;
}

/** Test-only: clear the resolved-value cache, the glob memoization + the queue. */
export function __resetResolveCacheForTests(): void {
  resolvedCache.clear();
  globResolutions.clear();
  globResolvedVars.clear();
  environmentResolutions.clear();
  opQueue = Promise.resolve();
}

/**
 * Resolve ONLY the requested env-var names from 1Password. The authority calls
 * this when a provider's key is missing from env/config/oauth-file. Single refs
 * and custom-endpoint op:// keys are resolved for the WANTED names only; a
 * config GLOB is full-resolved ONCE per process (single-flight, all matching
 * env vars batched) and every caller picks its wanted names from that shared
 * result — see resolveGlobShared.
 *
 * Returns `{ envVar: value }` for whatever was found (possibly empty). Never
 * mutates process.env — the caller (authority) owns the write-through mirror.
 * Resolution is SERIALIZED process-wide (the SDK IPC bridge is not concurrency-
 * safe) and CACHED per env var (so the shared config glob is discovered once).
 *
 * `onAuthFailure`:
 *   - "throw": propagate OpAuthError (explicit-flag callers).
 *   - "skip":  swallow OpAuthError → return {} (config-driven routing: the
 *     provider just resolves as unavailable, server stays up).
 */
export async function resolveOpKeyForEnvVars(
  wanted: Set<string>,
  opts: { onAuthFailure?: OnAuthFailure; allowPrompt?: boolean } = {}
): Promise<Record<string, string>> {
  if (wanted.size === 0) return {};

  // Serve any already-resolved wanted vars from cache; only the rest need the SDK.
  const cached: Record<string, string> = {};
  const stillWanted = new Set<string>();
  for (const w of wanted) {
    const hit = resolvedCache.get(w);
    if (hit !== undefined) cached[w] = hit;
    else stillWanted.add(w);
  }

  // Drop names our PARENT already established 1Password does not hold. Asking
  // again cannot produce a value; it can only build an SDK client that races
  // this process's siblings for the machine-wide DesktopAuth handshake.
  for (const skip of inheritedUnavailable()) stillWanted.delete(skip);

  if (stillWanted.size === 0) return cached;

  // Everything below runs inside the serialized critical section. The span
  // label carries the wanted env-var NAMES (names only — never values).
  const label = `op:resolve(${[...stillWanted].sort().join(",")})`;
  return runOpExclusive(async (span) => {
    // Re-check the cache inside the lock: a prior queued op may have resolved our
    // var while we waited (the shared-glob case — the whole point of caching).
    const out: Record<string, string> = { ...cached };
    const wantNow = new Set<string>();
    let servedFromGlob = false;
    for (const w of stillWanted) {
      const hit = resolvedCache.get(w);
      if (hit !== undefined) {
        out[w] = hit;
        if (globResolvedVars.has(w)) servedFromGlob = true;
      } else {
        wantNow.add(w);
      }
    }
    // Observability: this resolve was satisfied by a PRIOR caller's shared glob
    // resolution — the span shows ~0 exec with { globCacheHit: true }.
    if (servedFromGlob) span.addMeta({ globCacheHit: true });
    if (wantNow.size === 0) return out;
    const resolved = await resolveOpKeyForEnvVarsInner(wantNow, opts, span);
    for (const [k, v] of Object.entries(resolved)) {
      resolvedCache.set(k, v);
      out[k] = v;
    }
    // Names we asked about and got nothing back for. Recorded, NOT acted on
    // here — a miss may still be a swallowed auth failure, and this process
    // must keep retrying it. Only `prehydrateCredentialsForSpawn` acts on the
    // record, and only after confirming the run logged no op failures at all.
    recordOpUnavailableVars([...wantNow].filter((w) => !(w in resolved)));
    return out;
  }, label);
}

/**
 * Does this run have an op source that is NOT an environment — an `op://` ref in
 * `apiKeys`, an `onepassword[]` entry, or a custom-endpoint key?
 *
 * These are the only sources that still need the AMBIENT account, so resolving
 * ambient auth when none of them exist is pure cost: on a machine with several
 * accounts and no global one it also emits a false "1Password auth unavailable"
 * warning about work nothing requested.
 */
function hasNonEnvironmentOpSources(): boolean {
  const cfg = testSeams?.config ?? readConfigRaw();
  if (cfg.apiKeys) {
    for (const v of Object.values(cfg.apiKeys)) {
      if (typeof v === "string" && v.startsWith("op://")) return true;
    }
  }
  if (Array.isArray(cfg.onepassword) && cfg.onepassword.length > 0) return true;
  if (cfg.customEndpoints && typeof cfg.customEndpoints === "object") {
    for (const raw of Object.values(cfg.customEndpoints)) {
      if (raw && typeof raw === "object") {
        const apiKey = (raw as { apiKey?: unknown }).apiKey;
        if (typeof apiKey === "string" && apiKey.startsWith("op://")) return true;
      }
    }
  }
  return false;
}

/**
 * Account declared for an `onepassword[]` entry, by its ref/glob value.
 *
 * `apiKeys` op:// refs are deliberately absent from this map: they are keyed by
 * env-var name and have nowhere to put an account, so they resolve through the
 * ambient rules. Looking up by the ref VALUE means a single ref and a glob are
 * handled by the same lookup.
 */
function importAccountLookup(): Map<string, string | undefined> {
  if (testSeams?.config) return new Map();
  const out = new Map<string, string | undefined>();
  for (const e of readAllOnepasswordImportEntries()) out.set(e.value, e.account);
  return out;
}

/** The actual resolution body (runs inside runOpExclusive). */
async function resolveOpKeyForEnvVarsInner(
  wanted: Set<string>,
  opts: { onAuthFailure?: OnAuthFailure; allowPrompt?: boolean } = {},
  span?: OpSpanCtx
): Promise<Record<string, string>> {
  if (wanted.size === 0) return {};
  if (!hasOpSources()) return {};

  const onAuthFailure = opts.onAuthFailure ?? "skip";
  const allowPrompt = opts.allowPrompt ?? false;

  // AMBIENT auth is resolved LAZILY, not as an upfront gate.
  //
  // It used to be resolved here and a failure returned immediately. That made
  // ambient auth a precondition for EVERY source — including ones that declare
  // their own account and need nothing ambient at all. On a multi-account
  // machine with no global account, a perfectly well-declared
  // `{ id, account }` environment still failed, because the gate tripped before
  // its account was ever looked at.
  //
  // Now: sources that declare an account use it directly; only an UNDECLARED
  // source pays for ambient resolution, and only at the moment it needs it. A
  // run whose every source is declared never resolves ambient auth at all.
  let ambientFailure: OpAuthError | undefined;
  const ambientAuth = async (): Promise<SdkAuth | undefined> => {
    if (testSeams?.auth) return testSeams.auth;
    if (ambientFailure) throw ambientFailure;
    try {
      return await getSdkAuth(allowPrompt);
    } catch (err) {
      if (err instanceof OpAuthError) ambientFailure = err;
      throw err;
    }
  };

  /** Report an auth failure the way the old upfront gate did, or rethrow. */
  const reportAuthFailure = async (err: unknown): Promise<void> => {
    if (!(err instanceof OpAuthError) || onAuthFailure !== "skip") throw err;
    warnOnce(`[claudish] 1Password auth unavailable, skipping op:// keys: ${err.message}`);
    // Record before returning: this run's keys may live in 1Password, and the
    // missing-key error downstream must not tell the user to `export` a
    // credential they already store there.
    //
    // warnOnce de-duplicates the USER-FACING line (a bare model name asks the
    // authority about several candidate providers, so one failure used to print
    // several identical lines). The RECORD is not de-duplicated — provenance
    // must see every failure.
    const { recordOpFailure } = await import("../../providers/onepassword.js");
    recordOpFailure({ kind: "auth", message: err.message });
  };

  // The non-environment sources below still share one ambient auth. They are
  // keyed by env-var name (`apiKeys`) or by a bare `onepassword[]` entry, and
  // gain per-entry accounts in the same way once those readers are threaded
  // through; until then an ambient failure simply skips them, exactly as before,
  // instead of aborting the environments that CAN resolve.
  //
  // Resolved ONLY IF such a source actually exists. Attempting it
  // unconditionally warned "1Password auth unavailable" on a run whose every
  // source declared an account and resolved perfectly — a scary, wrong message
  // about work nothing had asked for.
  let auth: SdkAuth | undefined;
  if (hasNonEnvironmentOpSources()) {
    try {
      auth = await ambientAuth();
    } catch (err) {
      await reportAuthFailure(err);
    }
  }

  const {
    collectConfigImports,
    resolveSecrets,
    recordOpHydratedVars,
    recordOpFailure,
    withSdkRetry,
  } = await import("../../providers/onepassword.js");

  const cfg = readConfigRaw();
  const out: Record<string, string> = {};

  try {
    // 1. config single op:// refs + globs (apiKeys + onepassword[]).
    const importAccounts = importAccountLookup();
    const collected = collectConfigImports(
      { apiKeys: cfg.apiKeys, onepassword: cfg.onepassword },
      process.env
    );
    for (const w of collected.warnings) console.error(w);

    // Single refs whose derived env name is wanted.
    const wantedRefs: Record<string, string> = {};
    for (const [envVar, ref] of Object.entries(collected.opRefs)) {
      if (wanted.has(envVar)) wantedRefs[envVar] = ref;
    }
    if (Object.keys(wantedRefs).length > 0) {
      // Group by declared account: `resolveSecrets` takes ONE auth for the whole
      // batch, so refs spanning two accounts must be two batches. Undeclared
      // refs fall into the ambient bucket and behave exactly as before.
      const refEntries = Object.entries(wantedRefs).map(([envVar, ref]) => ({
        value: envVar,
        ...(importAccounts.get(ref) ? { account: importAccounts.get(ref) as string } : {}),
      }));
      const { byAccount, undeclared } = groupEntriesByAccount(refEntries, (e) => e.account);
      const batches: { auth: SdkAuth | undefined; names: string[] }[] = [];
      for (const [account, entries] of byAccount) {
        batches.push({
          auth: { kind: "desktop", accountName: account },
          names: entries.map((e) => e.value),
        });
      }
      if (undeclared.length > 0) batches.push({ auth, names: undeclared.map((e) => e.value) });

      for (const batch of batches) {
        const refs: Record<string, string> = {};
        for (const n of batch.names) refs[n] = wantedRefs[n];
        // Wrapped for lock recovery — see the note at resolveEnvironmentShared
        // for why the wrap lives at the call site rather than inside resolveSecrets.
        const resolved = await withSdkRetry(
          () => resolveSecrets(refs, { auth: batch.auth, sdkFactory: testSeams?.sdkFactory }),
          "op:resolve-refs"
        );
        Object.assign(out, resolved);
      }
    }

    // Globs: each glob resolves ONCE per process (single-flight + memoized full
    // result — resolveGlobShared). The first caller discovers the item ONCE and
    // batch-resolves ALL matching env vars; this caller (and every later one)
    // just picks its wanted names out of the shared result. 26 providers →
    // 1 discovery + 1 batched resolveAll instead of 26 full re-discoveries.
    const stillWanted = new Set([...wanted].filter((w) => !(w in out)));
    for (const globPath of collected.globImports) {
      if (stillWanted.size === 0) break;
      try {
        // A glob declared against account B is read with a client for B.
        const globAuth = await authForEntry(
          {
            value: globPath,
            ...(importAccounts.get(globPath)
              ? { account: importAccounts.get(globPath) as string }
              : {}),
          },
          allowPrompt
        );
        const { resolved, cacheHit } = await resolveGlobShared(globPath, globAuth);
        if (cacheHit) span?.addMeta({ globCacheHit: true });
        for (const w of [...stillWanted]) {
          const v = resolved[w];
          if (v !== undefined) {
            out[w] = v;
            stillWanted.delete(w);
          }
        }
      } catch (globErr) {
        // NON-FATAL (startup contract): warn + skip — a bad glob must never lock
        // the user out. The failed resolution was evicted from the memo map, so
        // the NEXT resolve retries it.
        const m = globErr instanceof Error ? globErr.message : String(globErr);
        warnOnce(`[claudish] 1Password import skipped: ${m}`);
        recordOpFailure({ kind: "import", source: globPath, message: m });
      }
    }

    // 2. custom-endpoint op:// apiKeys → CUSTOM_<NAME>_KEY.
    if (cfg.customEndpoints && typeof cfg.customEndpoints === "object") {
      const customRefs: Record<string, string> = {};
      for (const [name, raw] of Object.entries(cfg.customEndpoints)) {
        if (!raw || typeof raw !== "object") continue;
        const apiKey = (raw as { apiKey?: unknown }).apiKey;
        // Use a plain op:// prefix check (NOT isOpReference, whose anchored regex
        // rejects whitespace) — real 1Password item/section titles contain spaces.
        if (typeof apiKey !== "string" || !apiKey.startsWith("op://")) continue;
        const envVar = `CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
        if (wanted.has(envVar) && !(envVar in out)) customRefs[envVar] = apiKey;
      }
      if (Object.keys(customRefs).length > 0) {
        const resolved = await withSdkRetry(
          () => resolveSecrets(customRefs, { auth, sdkFactory: testSeams?.sdkFactory }),
          "op:resolve-custom-endpoint-refs"
        );
        Object.assign(out, resolved);
      }
    }

    // 3. 1Password Environments (config `onepasswordEnvironments[]` + `--op-env`).
    //    getVariables(id) is all-or-nothing, so each environment is fetched ONCE
    //    (single-flight → whole set into resolvedCache) the first time a wanted key
    //    still misses every more-specific source above; later keys are cache hits.
    //    Environments are the broadest/lowest-priority op source → resolved LAST.
    const stillWantedEnv = new Set([...wanted].filter((w) => !(w in out)));
    if (stillWantedEnv.size > 0) {
      for (const envEntry of registeredEnvironmentEntries()) {
        if (stillWantedEnv.size === 0) break;
        const envId = envEntry.value;
        try {
          // Per-entry auth: an environment declared against account B is read
          // with a client for B, even when another source in this same run used
          // account A. The loop exits as soon as every wanted key is satisfied,
          // so an account whose sources this run does not need is never
          // authorized at all.
          const envAuth = await authForEntry(envEntry, allowPrompt);
          const { resolved, cacheHit } = await resolveEnvironmentShared(envId, envAuth);
          if (cacheHit) span?.addMeta({ globCacheHit: true });
          for (const w of [...stillWantedEnv]) {
            const v = resolved[w];
            if (v !== undefined) {
              out[w] = v;
              stillWantedEnv.delete(w);
            }
          }
        } catch (envErr) {
          // NON-FATAL (startup contract): warn + skip — a bad environment must
          // never lock the user out. The failed resolution was evicted, so the
          // next resolve retries it.
          const m = envErr instanceof Error ? envErr.message : String(envErr);
          warnOnce(`[claudish] 1Password environment skipped: ${m}`);
          recordOpFailure({ kind: "environment", source: envId, message: m });
        }
      }
    }
  } catch (err) {
    if (err instanceof OpAuthError && onAuthFailure === "skip") {
      warnOnce(`[claudish] 1Password resolution skipped: ${err.message}`);
      recordOpFailure({ kind: "auth", message: err.message });
      return out;
    }
    const message = err instanceof Error ? err.message : String(err);
    warnOnce(`[claudish] 1Password secret resolution failed: ${message}`);
    recordOpFailure({ kind: "reference", message });
    if (onAuthFailure === "throw") throw err;
  }

  // Provenance: record which env vars came from 1Password so the config TUI /
  // --probe display "From: 1Password" instead of mislabeling them "From: env".
  if (Object.keys(out).length > 0) recordOpHydratedVars(Object.keys(out));

  return out;
}
