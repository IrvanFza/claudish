/**
 * Advisor-tool transformer for NativeHandler (monitor mode).
 *
 * PURPOSE — experimental
 * ======================
 * When the client sends `{type: "advisor_20260301", name: "advisor", model: ...}`
 * in `tools[]`, optionally replace it with a regular tool definition named
 * "advisor" so we can observe whether Sonnet still calls it as a normal tool.
 *
 * This is Stage 1 of the advisor-replacement experiment: detection only.
 * No tool loop, no third-party model routing. We just want to see whether
 * the executor still emits `tool_use` for `advisor` when the server-tool
 * version is gone.
 *
 * ENABLING
 * ========
 * Opt-in via env var:
 *
 *   export CLAUDISH_SWAP_ADVISOR=1         # swap tool + strip beta header
 *   export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.log  # optional log path
 *
 * When unset, this module is a no-op and the proxy behaves as before.
 *
 * STATE AND PROVENANCE (P2, P7, P8)
 * =================================
 * - Pending advisor calls are keyed by Claude Code session, then by tool-use
 *   id, and are RETAINED after their advice is delivered (see
 *   `NO_SESSION_BUCKET` and `markAdvisorCallConsumed`).
 * - Every tool_result that does not carry real advice from a named model is
 *   produced through one of the stub paths in `ADVISOR_STUB_PATHS`, and the
 *   advisor log records which one (`advisor_call`, `advisor_rewrite`).
 * - Failures reach the model as plain text naming the model and the reason,
 *   with `is_error: true`, and raise one warning per call via `logStderr`.
 */

import { appendFileSync } from "node:fs";
import { credentials } from "../auth/credentials/authority.js";
import { getLogFilePath, log, logStderr } from "../logger.js";
import { resolveModelNameSync } from "../providers/catalog-client.js";
import { findEntryByAlias } from "../providers/catalog-query.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { extractProviderMessage, extractUpstreamStatus } from "./shared/anthropic-error.js";

const ADVISOR_SERVER_TOOL_TYPE = "advisor_20260301";
const ADVISOR_BETA_FLAG = "advisor-tool-2026-03-01";

export interface AdvisorSwapConfig {
  enabled: boolean;
  logPath?: string;
  /** When true, include entire request bodies in the log — large but useful for debugging the tool_result round-trip. */
  dumpBodies?: boolean;
  models?: string[];
  collector?: string | null;
}

export function loadAdvisorSwapConfig(
  cliModels?: string[],
  cliCollector?: string | null
): AdvisorSwapConfig {
  return {
    enabled: process.env.CLAUDISH_SWAP_ADVISOR === "1" || (cliModels?.length ?? 0) > 0,
    logPath: process.env.CLAUDISH_SWAP_ADVISOR_LOG,
    dumpBodies: process.env.CLAUDISH_SWAP_ADVISOR_DUMP === "1",
    models: cliModels,
    collector: cliCollector ?? undefined,
  };
}

interface AdvisorInfo {
  /** The original server-tool definition we removed. */
  originalTool: Record<string, unknown>;
  /** The regular-tool definition we replaced it with. */
  regularTool: Record<string, unknown>;
  /** Original value of the anthropic-beta header (for possible restoration). */
  originalBetaHeader?: string;
  /** Beta header after stripping advisor-tool-2026-03-01. */
  strippedBetaHeader?: string;
}

/**
 * Mutates `payload.tools` in place: finds `advisor_20260301` and replaces it
 * with a regular tool of the same name. Also returns metadata describing
 * what we changed (for logging).
 *
 * Returns `null` if the payload had no advisor server tool (nothing to do).
 */
export function swapAdvisorToolInBody(payload: Record<string, unknown>): AdvisorInfo | null {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return null;

  const idx = tools.findIndex(
    (t) => t && typeof t === "object" && (t as any).type === ADVISOR_SERVER_TOOL_TYPE
  );
  if (idx < 0) return null;

  const originalTool = tools[idx] as Record<string, unknown>;
  const originalName = (originalTool.name as string) || "advisor";
  const originalAdvisorModel = (originalTool.model as string) || "unknown";

  // Regular tool definition. We deliberately keep the same name ("advisor")
  // so we can compare behavior before/after the swap.
  //
  // The description is longer than strictly necessary because the native
  // server-tool has trained behavior baked into the model — a regular tool
  // with the same name does NOT inherit that training, so we compensate
  // with more explicit prompting.
  const regularTool: Record<string, unknown> = {
    name: originalName,
    description:
      "Consult a stronger advisor model for strategic guidance on complex decisions. " +
      "Call this tool when: (a) facing an architectural or design decision with " +
      "multiple valid approaches, (b) stuck after 2+ failed attempts, (c) about to " +
      "make an irreversible change, or (d) when you believe the task is complete " +
      "and want verification. Takes no arguments; the advisor will read the full " +
      "conversation history.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };

  tools[idx] = regularTool;

  return {
    originalTool,
    regularTool,
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    ...{ _note: `replaced advisor_20260301 (advisor model: ${originalAdvisorModel})` },
  } as AdvisorInfo;
}

/**
 * Removes `advisor-tool-2026-03-01` from a comma-separated anthropic-beta
 * header value. Returns `undefined` if the header had no advisor beta flag.
 */
export function stripAdvisorBeta(betaHeader: string | undefined): {
  stripped: string | undefined;
  changed: boolean;
} {
  if (!betaHeader) return { stripped: betaHeader, changed: false };
  const parts = betaHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const filtered = parts.filter((p) => p !== ADVISOR_BETA_FLAG);
  if (filtered.length === parts.length) {
    return { stripped: betaHeader, changed: false };
  }
  return {
    stripped: filtered.length > 0 ? filtered.join(",") : undefined,
    changed: true,
  };
}

/** Prefix of the debug-log line that mirrors each advice-origin record. */
export const ADVISOR_ORIGIN_LOG_PREFIX = "[advisor-origin]";

/** The P7 records that also go to the debug log (`--debug-claudish`). */
const ORIGIN_RECORD_KINDS: ReadonlySet<string> = new Set([
  "advisor_call",
  "advisor_collector_call",
  "advisor_rewrite",
]);

/**
 * Defence in depth for EVERY sink a record reaches — the advisor log file and
 * the debug-log mirror. The records carry no key or header field by
 * construction; `reason` quotes the provider's own error body, and some
 * providers echo the key they rejected. The file outlives the session, so it
 * is the sink that most needs this (it was previously written raw).
 *
 * The replacements only ever shorten a run of key characters inside a JSON
 * string value — none of `"`, `\` or a structural character is produced — so
 * the scrubbed line is still valid JSON.
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, "[redacted]");
}

/**
 * Appends a structured log entry to the configured advisor-swap log file
 * (`CLAUDISH_SWAP_ADVISOR_LOG`); a no-op for the file when no path is set.
 *
 * The origin records (`advisor_call`, `advisor_collector_call`,
 * `advisor_rewrite`) are ALSO written, one compact JSON line each after
 * `[advisor-origin]`, to claudish's debug log whenever it is on
 * (`--debug-claudish`), so a real run can be checked from the debug log alone.
 *
 * The record is serialized and scrubbed ONCE, and the same scrubbed line goes
 * to both sinks. The file used to get the raw record while only the debug
 * mirror was scrubbed, so a provider error body that echoed a key landed in
 * clear text in a file that outlives the session.
 */
export function logAdvisorEvent(cfg: AdvisorSwapConfig, event: Record<string, unknown>): void {
  const record = { ts: new Date().toISOString(), ...event };
  let line: string;
  try {
    line = scrubSecrets(JSON.stringify(record));
  } catch {
    // a record that will not serialize is a logging problem only
    return;
  }
  if (
    typeof event.kind === "string" &&
    ORIGIN_RECORD_KINDS.has(event.kind) &&
    getLogFilePath() !== null
  ) {
    log(`${ADVISOR_ORIGIN_LOG_PREFIX} ${line}`);
  }
  if (!cfg.logPath) return;
  try {
    appendFileSync(cfg.logPath, `${line}\n`);
  } catch {
    // silent — don't break the proxy if the log file is unwritable
  }
}

/**
 * Scans a chunk of raw SSE bytes for advisor-related activity and records
 * any hits to the log file. Call this once per streamed chunk.
 *
 * NOT stateless: SSE frames are reassembled across chunk boundaries (see
 * `SseFrameBuffer`) before they are parsed. This entry point shares ONE
 * module-level buffer; a caller that owns a stream should prefer
 * `createAdvisorStreamScanner`, which gives the stream its own.
 *
 * Also extracts advisor `tool_use.id`s and records them as pending calls in
 * `sessionId`'s bucket (or `NO_SESSION_BUCKET` when it is absent) so that
 * subsequent inbound requests containing tool_result blocks for those ids can
 * be recognized and rewritten (Stage 2).
 */
export function recordAdvisorEventsFromChunk(
  cfg: AdvisorSwapConfig,
  chunkText: string,
  sessionId?: string
): void {
  // Regardless of logPath, always try to extract advisor tool_use ids —
  // Stage 2 rewrite depends on them even when no log file is configured.
  extractAdvisorToolUseIds(chunkText, streamFrameBuffer, sessionId);
  logAdvisorMarkers(cfg, chunkText);
}

/**
 * Advisor tap for a NON-STREAMING response: the parsed JSON body, whose
 * `content[]` carries `{type:"tool_use", name:"advisor", id:...}` blocks.
 * A non-stream response is NOT a `content_block_start`, so the SSE path
 * above would never see it.
 *
 * Prefer this over `recordAdvisorEventsFromChunk(cfg, JSON.stringify(body))`:
 * it reads the object structurally instead of re-serializing and grepping.
 */
export function recordAdvisorEventsFromResponseBody(
  cfg: AdvisorSwapConfig,
  body: unknown,
  sessionId?: string
): void {
  collectAdvisorIdsFromValue(body, 0, sessionId);
  if (!cfg.logPath) return;
  try {
    logAdvisorMarkers(cfg, JSON.stringify(body));
  } catch {
    // ignore — a body that will not serialize is a logging problem only
  }
}

/**
 * Byte-grep for markers worth flagging in the log. Stage 1 cares about
 * whether the executor emits a regular tool_use for "advisor" (which proves
 * the model still reaches for the advisor when the tool_type is regular).
 *
 * Logging only — id capture never depends on this.
 */
function logAdvisorMarkers(cfg: AdvisorSwapConfig, text: string): void {
  if (!cfg.logPath) return;
  const markers: Array<[string, string]> = [
    ['"name":"advisor"', "tool_use_for_advisor"],
    ['"type":"tool_use"', "any_tool_use"],
    ['"type":"server_tool_use"', "server_tool_use_unexpected"],
    ['"type":"advisor_tool_result"', "advisor_tool_result_unexpected"],
    ['"stop_reason":"tool_use"', "stop_reason_tool_use"],
    ['"stop_reason":"end_turn"', "stop_reason_end_turn"],
  ];
  for (const [needle, kind] of markers) {
    let i = 0;
    while (true) {
      i = text.indexOf(needle, i);
      if (i < 0) break;
      const ctx = text.slice(Math.max(0, i - 40), i + 160);
      logAdvisorEvent(cfg, { kind, needle, ctx });
      i += needle.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Stub paths and provenance vocabulary (P7)
// ---------------------------------------------------------------------------

/**
 * Every path by which an advisor tool_result can reach the model WITHOUT real
 * advice from the named model. Numbering follows research.md §4, so a log
 * record's `stubPath` can be read against that table.
 *
 * S1 and S3 are the feature-off answer (legacy env-var mode, no panel) and
 * keep `is_error: false`. S2 and S4 to S9 are genuine failures and carry
 * `is_error: true` plus a textual reason. S10 is a call that was never
 * rewritten at all; it can only be observed on a later request.
 */
export const ADVISOR_STUB_PATHS = Object.freeze({
  /** Legacy `CLAUDISH_SWAP_ADVISOR=1` with no panel: the canary stub is delivered. */
  LEGACY_STUB: "S1",
  /** A recorded call reached the rewrite with no prepared result (internal error). */
  PREPARED_RESULT_MISSING: "S2",
  /** The canary text itself (`stubAdvisorAdvice`), the advisor-disabled answer. */
  DISABLED_STUB: "S3",
  /** A panel model answered HTTP 2xx with no extractable advice text. */
  PANEL_EMPTY: "S4",
  /** The Anthropic collector answered HTTP 2xx with no text block. */
  ANTHROPIC_COLLECTOR_EMPTY: "S5",
  /** A non-Anthropic collector answered HTTP 2xx with no advice text. */
  COLLECTOR_EMPTY: "S6",
  /** A panel model failed: non-2xx, network error, or timeout. */
  PANEL_ERROR: "S7",
  /** Every panel model failed, so there is no advice to deliver. */
  ALL_PANEL_FAILED: "S8",
  /** The collector failed: non-2xx, network error, or timeout. */
  COLLECTOR_FAILED: "S9",
  /** Claude Code's own `No such tool available: advisor` error was never rewritten. */
  NOT_REWRITTEN: "S10",
} as const);

export type AdvisorStubPath = (typeof ADVISOR_STUB_PATHS)[keyof typeof ADVISOR_STUB_PATHS];

/**
 * `upstream` — real, non-empty advice bytes from the named model.
 * `stub`     — claudish produced the text (a stub path ran).
 * `absent`   — no call was made at all.
 */
export type AdviceOrigin = "upstream" | "stub" | "absent";

/** Which observation `upstreamStatus` came from. */
export type UpstreamStatusSource = "error.upstream_status" | "http_status";

/** The tool_result delivered for one advisor call. */
export interface AdvisorToolResult {
  text: string;
  isError: boolean;
}

/** Marker that opens every failure report the model receives. */
const ADVISOR_ERROR_PREFIX = "[claudish advisor error]";

/** Closing sentence for failure reports: the text is not advice. */
const ADVISOR_ERROR_SUFFIX =
  "This tool result is an error report from the claudish proxy, not advice.";

/** Sends one user-visible advisor warning through the sanctioned diagnostic channel. */
function warnAdvisor(message: string): void {
  // logStderr, never console/stderr directly: while Claude Code owns the TTY,
  // logStderr routes to DiagOutput instead of tearing the TUI
  // (terminal-isolation.ts, logger.ts).
  logStderr(`[advisor] ${message}`);
}

// ---------------------------------------------------------------------------
// Stage 2: pending-call state + tool_result rewrite (P2)
// ---------------------------------------------------------------------------

/**
 * Bucket for advisor calls recorded from a request that carried NO Claude
 * Code session id (`metadata.user_id` absent, or not the JSON blob).
 *
 * The rule, a documented compromise (architecture.md §4 and §11):
 *   - RECORD: a response to a session-less request records into this bucket.
 *   - CONSUME: a request looks in ITS OWN session bucket first, then here. A
 *     session-less request looks only here.
 *   - ADOPT: when a request with a known session id consumes an entry found
 *     here, the entry moves into that session's bucket. So two known,
 *     different session ids can never both resolve the same entry.
 *
 * The fallback exists because the id can be absent on the record request and
 * present on the consume request. Keying strictly on it would split one
 * logical call across two buckets and lose the advice (stub path S10).
 */
export const NO_SESSION_BUCKET = "__no_session__";

/** One observed advisor tool_use, tracked until TTL or eviction. */
export interface PendingAdvisorCall {
  toolUseId: string;
  /** A Claude Code session id, or `NO_SESSION_BUCKET`. */
  sessionKey: string;
  recordedAt: number;
  /** Refreshed on every record or lookup; the TTL is measured from here. */
  lastSeenAt: number;
  /** Set once advice was delivered. The entry is RETAINED after this. */
  consumedAt?: number;
  /** The exact tool_result delivered first, replayed verbatim on later turns. */
  result?: AdvisorToolResult;
}

/**
 * Bounds on the pending-call state. Entries are NOT deleted on consume: the
 * tool-use id stays in the conversation history and Claude Code re-sends it
 * on every later turn, still carrying its own "No such tool" error. Deleting
 * it made turn two lose its advice (plan-review-v2 C4). So state is bounded by
 * eviction only: a per-session LRU cap, a session LRU cap, and a sliding TTL.
 */
export const ADVISOR_PENDING_LIMITS = Object.freeze({
  maxCallsPerSession: 256,
  maxSessions: 64,
  /** Sliding: an entry re-sent by an active conversation never expires. */
  ttlMs: 24 * 60 * 60 * 1000,
});

/** How often a full expiry sweep may run. Lookups check expiry inline anyway. */
const SWEEP_INTERVAL_MS = 60_000;

/** sessionKey → (toolUseId → call). Both maps are kept in LRU order. */
const pendingBySession = new Map<string, Map<string, PendingAdvisorCall>>();

let clock: () => number = Date.now;
let lastSweepAt = Number.NEGATIVE_INFINITY;

/** The tool name we track. Claudish keeps the client's own name on the swap. */
const ADVISOR_TOOL_NAME = "advisor";

/** Guard against a pathological (or hostile) nesting depth while walking JSON. */
const MAX_WALK_DEPTH = 32;

/**
 * Hard cap on the SSE reassembly buffer. A stream that never terminates an
 * event (malformed, or simply not SSE at all) must not grow it without limit;
 * past the cap we keep only the tail, which is where a frame boundary can
 * still appear.
 */
const MAX_SSE_BUFFER_CHARS = 256 * 1024;

function sessionKeyFor(sessionId?: string): string {
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : NO_SESSION_BUCKET;
}

function isExpired(call: PendingAdvisorCall, now: number): boolean {
  return now - call.lastSeenAt > ADVISOR_PENDING_LIMITS.ttlMs;
}

function sweepExpiredIfDue(): void {
  const now = clock();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, bucket] of pendingBySession) {
    for (const [id, call] of bucket) {
      if (isExpired(call, now)) bucket.delete(id);
    }
    if (bucket.size === 0) pendingBySession.delete(key);
  }
}

/** Returns a bucket and marks it most-recently-used. */
function touchBucket(key: string): Map<string, PendingAdvisorCall> | undefined {
  const bucket = pendingBySession.get(key);
  if (!bucket) return undefined;
  pendingBySession.delete(key);
  pendingBySession.set(key, bucket);
  return bucket;
}

/** Returns the bucket for `key`, creating it (and evicting the LRU session) if needed. */
function bucketForWrite(key: string): Map<string, PendingAdvisorCall> {
  const existing = touchBucket(key);
  if (existing) return existing;
  const bucket = new Map<string, PendingAdvisorCall>();
  pendingBySession.set(key, bucket);
  while (pendingBySession.size > ADVISOR_PENDING_LIMITS.maxSessions) {
    const oldest = pendingBySession.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    pendingBySession.delete(oldest);
  }
  return bucket;
}

/** Inserts `call` as most-recently-used, evicting the LRU entry past the cap. */
function putCall(bucket: Map<string, PendingAdvisorCall>, call: PendingAdvisorCall): void {
  bucket.delete(call.toolUseId);
  if (bucket.size >= ADVISOR_PENDING_LIMITS.maxCallsPerSession) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  bucket.set(call.toolUseId, call);
}

function rememberAdvisorToolUseId(id: string, sessionId?: string): void {
  sweepExpiredIfDue();
  const key = sessionKeyFor(sessionId);
  const bucket = bucketForWrite(key);
  const now = clock();
  const existing = bucket.get(id);
  if (existing) {
    // Re-observed: keep its state (a delivered result must survive), refresh LRU.
    existing.lastSeenAt = now;
    putCall(bucket, existing);
    return;
  }
  putCall(bucket, { toolUseId: id, sessionKey: key, recordedAt: now, lastSeenAt: now });
  log(`[advisor] recorded advisor tool_use ${id} (session=${key})`);
}

/**
 * Resolves a tool-use id for a request: its own session bucket first, then
 * `NO_SESSION_BUCKET`. A session-less request consults only the fallback.
 * A hit refreshes the entry's TTL and LRU position.
 */
function lookupAdvisorCall(toolUseId: string, sessionId?: string): PendingAdvisorCall | undefined {
  sweepExpiredIfDue();
  const now = clock();
  const own = sessionKeyFor(sessionId);
  const keys = own === NO_SESSION_BUCKET ? [NO_SESSION_BUCKET] : [own, NO_SESSION_BUCKET];
  for (const key of keys) {
    const bucket = pendingBySession.get(key);
    const call = bucket?.get(toolUseId);
    if (!bucket || !call) continue;
    if (isExpired(call, now)) {
      bucket.delete(toolUseId);
      continue;
    }
    call.lastSeenAt = now;
    putCall(bucket, call);
    touchBucket(key);
    return call;
  }
  return undefined;
}

/**
 * The tracked call for `toolUseId` as seen from `sessionId`'s request, or
 * `undefined`. Follows the `NO_SESSION_BUCKET` lookup rule. A delivered call
 * carries its `result`, which callers replay instead of re-fetching.
 */
export function getAdvisorCall(
  toolUseId: string,
  sessionId?: string
): Readonly<PendingAdvisorCall> | undefined {
  return lookupAdvisorCall(toolUseId, sessionId);
}

/**
 * Marks a tracked call consumed and stores the tool_result delivered for it.
 * The entry is RETAINED so that later turns, which re-send the same id, get
 * the same text back. An entry found in `NO_SESSION_BUCKET` by a request with
 * a known session id is adopted into that session's bucket.
 *
 * Returns false when the id is not tracked for this request.
 */
export function markAdvisorCallConsumed(
  toolUseId: string,
  result: AdvisorToolResult,
  sessionId?: string
): boolean {
  const call = lookupAdvisorCall(toolUseId, sessionId);
  if (!call) return false;
  const own = sessionKeyFor(sessionId);
  if (call.sessionKey === NO_SESSION_BUCKET && own !== NO_SESSION_BUCKET) {
    pendingBySession.get(NO_SESSION_BUCKET)?.delete(toolUseId);
    call.sessionKey = own;
    putCall(bucketForWrite(own), call);
  }
  call.consumedAt ??= clock();
  call.result = result;
  return true;
}

/**
 * Panel calls currently RUNNING, keyed exactly as the pending state is: the
 * request's session key (`NO_SESSION_BUCKET` when it has none) and the
 * tool-use id.
 *
 * WHY: a delivered result is only visible once `markAdvisorCallConsumed` has
 * run, i.e. after the whole panel returned. Claude Code retrying a request
 * that carries the same advisor tool_result (socket reset, harness retry)
 * therefore used to find no cached result and run the ENTIRE panel a second
 * time — every panel model gets the full conversation again and the user pays
 * twice. The loop is awaited before the upstream request is sent, so the
 * window is the whole call: up to the panel timeout plus the collector
 * timeout. The second request now joins the first call instead of starting
 * one; after completion the cached-result path serves later turns as before.
 *
 * Entries are removed in a `finally`, so this map holds only calls actually in
 * flight. It is bounded like the pending state (the same per-session and
 * session caps, multiplied) in case a pathological caller outruns that: past
 * the cap the oldest entries are dropped, which only costs a later retry its
 * de-duplication.
 */
const inFlightAdvisorCalls = new Map<string, Promise<AdvisorToolResult>>();

const MAX_IN_FLIGHT_ADVISOR_CALLS =
  ADVISOR_PENDING_LIMITS.maxSessions * ADVISOR_PENDING_LIMITS.maxCallsPerSession;

/**
 * Runs `start` for (session, toolUseId), or joins the run already in flight
 * for that key.
 *
 * `joined: true` means the returned promise belongs to ANOTHER request: this
 * caller started nothing and pays for nothing. The owner is responsible for
 * `markAdvisorCallConsumed`, so a joiner reads the delivered result from the
 * pending state as any later turn does — or from the promise, which resolves
 * to the same `AdvisorToolResult`.
 *
 * A rejection is not swallowed: it reaches every waiter exactly as it reached
 * the owner. The entry is gone by then, so a caller that would rather run its
 * own call after someone else's failure can simply call this again.
 */
export function joinOrStartAdvisorCall(
  toolUseId: string,
  sessionId: string | undefined,
  start: () => Promise<AdvisorToolResult>
): { promise: Promise<AdvisorToolResult>; joined: boolean } {
  const key = `${sessionKeyFor(sessionId)} ${toolUseId}`;
  const existing = inFlightAdvisorCalls.get(key);
  if (existing) return { promise: existing, joined: true };

  while (inFlightAdvisorCalls.size >= MAX_IN_FLIGHT_ADVISOR_CALLS) {
    const oldest = inFlightAdvisorCalls.keys().next().value;
    if (oldest === undefined) break;
    inFlightAdvisorCalls.delete(oldest);
  }

  // `.finally` (never a `try/finally` inside the IIFE) so the cleanup cannot
  // run before `promise` is assigned: its callback is always a microtask.
  const promise: Promise<AdvisorToolResult> = start().finally(() => {
    if (inFlightAdvisorCalls.get(key) === promise) inFlightAdvisorCalls.delete(key);
  });
  inFlightAdvisorCalls.set(key, promise);
  return { promise, joined: false };
}

/** Test/debug: the keys of the panel calls currently in flight. */
export function _debug_getInFlightAdvisorCallKeys(): string[] {
  return [...inFlightAdvisorCalls.keys()];
}

/**
 * Reassembles SSE events across chunk boundaries.
 *
 * Anthropic splits `content_block_start` across byte boundaries, so a
 * per-chunk `JSON.parse` of `data:` lines misses exactly the frames we care
 * about. Buffer until an event terminator (`\n\n`, or `\r\n\r\n`), then hand
 * the complete event out.
 */
class SseFrameBuffer {
  private buf = "";

  /** Appends a chunk and returns every COMPLETE event now available. */
  take(chunkText: string): string[] {
    this.buf += chunkText;
    const events: string[] = [];
    while (true) {
      const lf = this.buf.indexOf("\n\n");
      const crlf = this.buf.indexOf("\r\n\r\n");
      // Earliest terminator wins; -1 means "not present".
      let idx = -1;
      let width = 2;
      if (crlf >= 0 && (lf < 0 || crlf < lf)) {
        idx = crlf;
        width = 4;
      } else if (lf >= 0) {
        idx = lf;
      }
      if (idx < 0) break;
      events.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + width);
    }
    if (this.buf.length > MAX_SSE_BUFFER_CHARS) {
      this.buf = this.buf.slice(-MAX_SSE_BUFFER_CHARS);
    }
    return events;
  }

  reset(): void {
    this.buf = "";
  }
}

/**
 * One module-level buffer, shared by every stream that reaches the legacy
 * per-chunk entry point `recordAdvisorEventsFromChunk`.
 *
 * Two concurrent streams can interleave here and produce a spliced "event".
 * That degrades gracefully rather than losing the id: a spliced event fails
 * `JSON.parse` and falls through to the regex fallback below, which is the
 * same byte-grep this code used to be. Stream owners use
 * `createAdvisorStreamScanner` instead.
 */
const streamFrameBuffer = new SseFrameBuffer();

/** A per-stream advisor tap: its own SSE buffer, bound to one session. */
export interface AdvisorStreamScanner {
  /** Feed one decoded chunk of the response stream. */
  push(chunkText: string): void;
}

/**
 * Creates an advisor tap for ONE response stream. It owns its SSE reassembly
 * buffer, so concurrent streams cannot splice frames into each other, and it
 * records ids into `sessionId`'s bucket (`NO_SESSION_BUCKET` when absent).
 * Capture logic is identical to `recordAdvisorEventsFromChunk`.
 */
export function createAdvisorStreamScanner(
  cfg: AdvisorSwapConfig,
  sessionId?: string
): AdvisorStreamScanner {
  const frames = new SseFrameBuffer();
  return {
    push(chunkText: string): void {
      extractAdvisorToolUseIds(chunkText, frames, sessionId);
      logAdvisorMarkers(cfg, chunkText);
    },
  };
}

/**
 * Records the id of every advisor tool_use block visible in this chunk.
 *
 * Structural first, regex only as a fallback. The id is captured whatever it
 * looks like: `toolu_*` is an ANTHROPIC spelling, and the advisor swap must
 * work behind every parser. `openai-sse.ts` mints `call_*` from the upstream
 * or synthesizes `tool_<ts>_<idx>`, and it is the DEFAULT stream format
 * (`base-api-format.ts`), so a prefix test silently captures nothing for
 * every foreign main model.
 */
function extractAdvisorToolUseIds(
  chunkText: string,
  frames: SseFrameBuffer,
  sessionId?: string
): void {
  // Whole-body JSON (the non-streaming branch hands us one). If it parses we
  // have read it structurally and there is nothing for the regex to add.
  if (parseAdvisorIdsFromJsonText(chunkText, sessionId)) return;

  // SSE: parse each COMPLETE event; a frame that will not parse falls back to
  // the regex so we never capture less than the byte-grep did.
  let sawCompleteFrame = false;
  for (const event of frames.take(chunkText)) {
    sawCompleteFrame = true;
    if (!scanSseEventForAdvisorIds(event, sessionId)) matchAdvisorIdsByRegex(event, sessionId);
  }

  // No complete frame yet — either a fragment (the rest is still coming and
  // will be parsed then) or text that is not SSE at all, e.g. a bare
  // `"content_block":{...}` snippet. Grep it so neither case is dropped.
  if (!sawCompleteFrame) matchAdvisorIdsByRegex(chunkText, sessionId);
}

/**
 * Reads one complete SSE event structurally: concatenates its `data:` lines
 * per the SSE spec, parses the result and walks it for advisor tool_use
 * blocks. Returns false when the payload did not parse, which is the
 * caller's signal to fall back to the regex.
 */
function scanSseEventForAdvisorIds(rawEvent: string, sessionId?: string): boolean {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return false;
  const payload = dataLines.join("\n").trim();
  // A comment/heartbeat frame or the terminator carries nothing to capture,
  // but it is not a parse FAILURE either — no regex fallback needed.
  if (!payload || payload === "[DONE]") return true;
  return parseAdvisorIdsFromJsonText(payload, sessionId);
}

/** Parses `text` as JSON and walks it. Returns false when it is not JSON. */
function parseAdvisorIdsFromJsonText(text: string, sessionId?: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  collectAdvisorIdsFromValue(parsed, 0, sessionId);
  return true;
}

/**
 * Walks any parsed JSON value and records the id of every object that IS an
 * advisor tool_use block. Key order is irrelevant here, which is the point:
 * the old regex required `type`,`id`,`name` adjacent and in that order.
 *
 * Covers both shapes with one walk: the streamed
 * `content_block_start.content_block` and the non-streamed `content[]` entry.
 */
function collectAdvisorIdsFromValue(value: unknown, depth: number, sessionId?: string): void {
  if (value === null || typeof value !== "object" || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectAdvisorIdsFromValue(item, depth + 1, sessionId);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.type === "tool_use" &&
    obj.name === ADVISOR_TOOL_NAME &&
    typeof obj.id === "string" &&
    obj.id.length > 0
  ) {
    rememberAdvisorToolUseId(obj.id, sessionId);
  }
  for (const nested of Object.values(obj)) collectAdvisorIdsFromValue(nested, depth + 1, sessionId);
}

/**
 * Prefix-agnostic fallback for payloads that do not parse — a truncated
 * frame, a spliced one, or a raw fragment. `[^}]*?` keeps every match inside
 * a single JSON object, so an id belonging to an enclosing object (a
 * `message.id`, say) can never be picked up for the advisor block nested
 * inside it.
 */
const ADVISOR_ID_PATTERNS: RegExp[] = [
  // type → id → name. The canonical fallback from the design doc.
  /"type"\s*:\s*"tool_use"[^}]*?"id"\s*:\s*"([^"]+)"[^}]*?"name"\s*:\s*"advisor"/g,
  // name → id, whatever sits between them (input may be serialized first).
  /"name"\s*:\s*"advisor"[^}]*?"id"\s*:\s*"([^"]+)"/g,
  // id → name with no `type` ahead of them. Adjacency is required precisely
  // because `type` is not there to prove the id belongs to this block.
  /"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"advisor"/g,
];

function matchAdvisorIdsByRegex(text: string, sessionId?: string): void {
  for (const re of ADVISOR_ID_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((m = re.exec(text)) !== null) {
      rememberAdvisorToolUseId(m[1], sessionId);
    }
  }
}

/**
 * Test helper. With `sessionId`, the ids in that session's bucket (pass
 * `NO_SESSION_BUCKET` for the fallback). Without it, every tracked id across
 * all buckets, de-duplicated.
 */
export function _debug_getTrackedAdvisorIds(sessionId?: string): string[] {
  if (sessionId !== undefined) {
    return [...(pendingBySession.get(sessionKeyFor(sessionId))?.keys() ?? [])];
  }
  const all = new Set<string>();
  for (const bucket of pendingBySession.values()) for (const id of bucket.keys()) all.add(id);
  return [...all];
}

/** Test helper — the session bucket keys, least-recently-used first. */
export function _debug_getAdvisorSessionKeys(): string[] {
  return [...pendingBySession.keys()];
}

/** Test helper — replaces the clock used for TTL; `null` restores `Date.now`. */
export function _debug_setAdvisorClock(now: (() => number) | null): void {
  clock = now ?? Date.now;
  lastSweepAt = Number.NEGATIVE_INFINITY;
}

/**
 * Reset ALL advisor state: pending calls in every bucket, the shared SSE
 * reassembly buffer, the S10 report memory and the clock. Intended for tests.
 */
export function _debug_resetTrackedAdvisorIds(): void {
  pendingBySession.clear();
  streamFrameBuffer.reset();
  reportedUnrecorded.clear();
  clock = Date.now;
  lastSweepAt = Number.NEGATIVE_INFINITY;
}

/**
 * Supplies the tool_result for an advisor tool_use_id.
 *
 * - a `string` is delivered as advice and CLEARS `is_error` (the original
 *   contract, kept for the legacy stub and existing callers);
 * - an `AdvisorToolResult` sets `is_error` from `isError`;
 * - `undefined` leaves that block untouched.
 */
export type AdvisorResultSupplier = (toolUseId: string) => string | AdvisorToolResult | undefined;

/**
 * Scans a payload for `tool_result` blocks whose tool_use_id we recorded as
 * an advisor call (for this request's session, see `NO_SESSION_BUCKET`), and
 * rewrites them in place:
 *   - `content` → `[{type:"text", text: <supplied text>}]`
 *   - `is_error` → cleared for a string or `isError:false`, set for `isError:true`
 *
 * Returns the list of rewritten tool_use_ids (empty if nothing changed).
 */
export function rewriteAdvisorToolResults(
  payload: Record<string, unknown>,
  /**
   * Must be synchronous. Callers that need an async model call pre-fetch the
   * result keyed by tool_use_id before invoking this function.
   */
  getAdviceFor: AdvisorResultSupplier,
  sessionId?: string
): string[] {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return [];
  const rewritten: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if ((msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as any).type !== "tool_result") continue;
      const toolUseId = (block as any).tool_use_id;
      if (typeof toolUseId !== "string") continue;
      if (!lookupAdvisorCall(toolUseId, sessionId)) continue;

      const supplied = getAdviceFor(toolUseId);
      if (supplied === undefined) continue;
      const result: AdvisorToolResult =
        typeof supplied === "string" ? { text: supplied, isError: false } : supplied;
      // Rewrite in place.
      (block as any).content = [{ type: "text", text: result.text }];
      if (result.isError) {
        (block as any).is_error = true;
      } else if ((block as any).is_error) {
        // Clear the error flag Claude Code set for "No such tool".
        (block as any).is_error = false;
      }
      rewritten.push(toolUseId);
    }
  }
  return rewritten;
}

/**
 * Stub advisor: returns a canary string. Used during PoC to prove the
 * rewrite reached the executor without yet wiring up a real third-party
 * model. The canary string is intentionally distinctive so we can grep for
 * it in the executor's continuation. Stub path S3.
 */
export function stubAdvisorAdvice(toolUseId: string): string {
  return `CLAUDISH_ADVISOR_STUB_${toolUseId}: Evaluation mode — this advice was supplied by a claudish proxy stub. For the rate-limiter design, consider a hybrid: local token bucket per node for burst tolerance plus a central quota coordinator for cross-region fairness. Use the CAP tradeoff as your framing; expose availability vs accuracy knobs per tenant. The single most important decision is your failure mode: fail-open vs fail-closed.`;
}

/**
 * Legacy env-var mode (stub path S1): prepares the canary result for a call,
 * marks it consumed so later turns replay it, and writes the call's
 * `advisor_rewrite` record. `is_error` stays false — this is the feature-off
 * answer, not a failure.
 */
export function prepareLegacyStubResult(
  cfg: AdvisorSwapConfig,
  toolUseId: string,
  sessionId?: string
): AdvisorToolResult {
  const result: AdvisorToolResult = { text: stubAdvisorAdvice(toolUseId), isError: false };
  markAdvisorCallConsumed(toolUseId, result, sessionId);
  logAdvisorEvent(cfg, {
    kind: "advisor_rewrite",
    event: "advisor_rewrite",
    toolUseId,
    sessionId: sessionId ?? null,
    panel: [],
    originsByModel: {},
    // No model was called, so none failed (see logAdvisorCallOutcome).
    failedModels: [],
    collector: null,
    collectorOrigin: null,
    resultOrigin: "stub" satisfies AdviceOrigin,
    stubPath: ADVISOR_STUB_PATHS.LEGACY_STUB,
    isError: false,
  });
  return result;
}

/**
 * Stub path S2: the rewrite found a recorded call with no prepared result.
 * Unreachable by construction in NativeHandler; if it ever runs, the model is
 * told so in plain text instead of being handed a canary as advice.
 */
export function missingAdvisorResult(toolUseId: string): AdvisorToolResult {
  log(`[advisor] no prepared result for recorded call ${toolUseId} (stub path S2)`);
  warnAdvisor(`advisor call ${toolUseId}: claudish had no prepared result (internal error)`);
  return {
    text: `${ADVISOR_ERROR_PREFIX} claudish recorded advisor call ${toolUseId} but had no result prepared for it (internal error). ${ADVISOR_ERROR_SUFFIX}`,
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Multi-model advisor (--advisor flag)
// ---------------------------------------------------------------------------

/**
 * Scans payload for tool_result blocks whose tool_use_id is tracked as an
 * advisor call for this request (see `NO_SESSION_BUCKET`). Returns the list of
 * matching IDs without modifying the payload. Includes calls already consumed:
 * check `getAdvisorCall(id, sessionId)?.result` to tell a replay from a call
 * that still needs a fetch.
 */
export function findPendingAdvisorToolResults(
  payload: Record<string, unknown>,
  sessionId?: string
): string[] {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return [];
  const found: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if ((msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as any).type !== "tool_result") continue;
      const toolUseId = (block as any).tool_use_id;
      if (typeof toolUseId === "string" && lookupAdvisorCall(toolUseId, sessionId)) {
        found.push(toolUseId);
      }
    }
  }
  return found;
}

/** Claude Code's own error for a tool it does not know. */
const NO_SUCH_ADVISOR_TOOL = /No such tool available:\s*advisor\b/;

/** (sessionKey, toolUseId) pairs already reported as S10, so each warns once. */
const reportedUnrecorded = new Set<string>();
const MAX_REPORTED_UNRECORDED = 1024;

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Stub path S10: finds advisor tool_results still carrying Claude Code's
 * `No such tool available: advisor` error for an id this request's session
 * never recorded — an advisor call that was never rewritten. Run it AFTER the
 * rewrite. Each (session, id) is logged (`advisor_rewrite`, origin `absent`)
 * and warned about once. Returns the ids newly reported.
 */
export function reportUnrecordedAdvisorCalls(
  cfg: AdvisorSwapConfig,
  payload: Record<string, unknown>,
  sessionId?: string
): string[] {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return [];
  const reported: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || (block as any).type !== "tool_result") continue;
      const toolUseId = (block as any).tool_use_id;
      if (typeof toolUseId !== "string") continue;
      if (!NO_SUCH_ADVISOR_TOOL.test(toolResultText((block as any).content))) continue;
      if (lookupAdvisorCall(toolUseId, sessionId)) continue;
      const memo = `${sessionKeyFor(sessionId)}\u0000${toolUseId}`;
      if (reportedUnrecorded.has(memo)) continue;
      if (reportedUnrecorded.size >= MAX_REPORTED_UNRECORDED) {
        const oldest = reportedUnrecorded.values().next().value;
        if (oldest !== undefined) reportedUnrecorded.delete(oldest);
      }
      reportedUnrecorded.add(memo);
      reported.push(toolUseId);

      const panel = cfg.models ?? [];
      logAdvisorEvent(cfg, {
        kind: "advisor_rewrite",
        event: "advisor_rewrite",
        toolUseId,
        sessionId: sessionId ?? null,
        panel,
        originsByModel: Object.fromEntries(panel.map((m) => [m, "absent" satisfies AdviceOrigin])),
        // No model was called — `resultOrigin: "absent"` is the signal here, and
        // counting never-called models as failures would inflate any audit.
        failedModels: [],
        collector: cfg.collector ?? null,
        collectorOrigin: cfg.collector ? ("absent" satisfies AdviceOrigin) : null,
        resultOrigin: "absent" satisfies AdviceOrigin,
        stubPath: ADVISOR_STUB_PATHS.NOT_REWRITTEN,
        isError: true,
      });
      log(`[advisor] call ${toolUseId} was never rewritten (stub path S10)`);
      warnAdvisor(
        `advisor call ${toolUseId} was not answered: claudish never saw the advisor tool call, so the model got "No such tool available: advisor"`
      );
    }
  }
  return reported;
}

export function convertToOpenAIMessages(
  anthropicMessages: any[]
): Array<{ role: string; content: string }> {
  return anthropicMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: extractBlocksAsText(m.content),
    }))
    .filter((m) => m.content.length > 0);
}

export function extractBlocksAsText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") {
        const inputStr = JSON.stringify(b.input ?? {}).slice(0, 500);
        return `[Called tool: ${b.name} with input: ${inputStr}]`;
      }
      if (b.type === "tool_result") {
        const resultText =
          typeof b.content === "string"
            ? b.content.slice(0, 500)
            : Array.isArray(b.content)
              ? b.content
                  .filter((x: any) => x.type === "text")
                  .map((x: any) => x.text)
                  .join("\n")
                  .slice(0, 500)
              : "(binary)";
        return `[Tool result (${b.tool_use_id}): ${resultText}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const ADVISOR_SYSTEM_PROMPT = `You are a strategic advisor to a coding agent. \
You have been given the full conversation history between a user and a Claude Code \
coding assistant. The assistant has paused to consult you for guidance.

Review the conversation and provide concise, actionable advice. Focus on:
- Architectural decisions and trade-offs
- Potential pitfalls the assistant might miss
- Alternative approaches worth considering
- Security, performance, or correctness concerns

Be direct. Limit your response to 300-500 words.`;

const COLLECTOR_SYSTEM_PROMPT = `You are synthesizing advice from multiple AI models \
for a coding agent. You will receive several independent advisor opinions about the \
same coding problem. Synthesize them into a single, coherent response that:
- Identifies consensus points (where advisors agree)
- Highlights disagreements and explains which perspective is stronger
- Produces a clear, actionable recommendation
Be concise. Do not attribute advice to specific models.`;

/** Provider keys the advisor executor can sign with. */
export interface AdvisorApiKeys {
  openrouter?: string;
  google?: string;
  openai?: string;
  anthropic?: string;
}

/** The four places an advisor or collector request can be sent. */
export type AdvisorRouteKind = "google" | "openai" | "openrouter" | "anthropic";

/**
 * Where one advisor model's request goes, and what signs it. The ONE place
 * the advisor's provider branching lives: request building, the collector
 * choice, key resolution, the P7 log and startup checks all read this.
 */
export interface AdvisorRoute {
  kind: AdvisorRouteKind;
  /** Endpoint host, e.g. `openrouter.ai`. */
  host: string;
  /** Full endpoint URL the request is POSTed to. */
  url: string;
  /** Which `AdvisorApiKeys` entry signs the request. */
  credential: AdvisorRouteKind;
  /** The model id placed in the request body, after catalog resolution. */
  wireModel: string;
}

const ADVISOR_ENDPOINTS: Readonly<Record<AdvisorRouteKind, string>> = Object.freeze({
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
});

function routeOf(kind: AdvisorRouteKind, wireModel: string): AdvisorRoute {
  const url = ADVISOR_ENDPOINTS[kind];
  return { kind, host: new URL(url).host, url, credential: kind, wireModel };
}

/**
 * Resolves an advisor model spec to its route. Pure: reads only the spec and
 * the catalog cache, performs no I/O.
 *
 * - `google@`/`gemini@` (and bare `gemini-*`) → the direct Gemini API.
 * - `openai@`/`oai@` (and bare `gpt-*`) → api.openai.com with the metered
 *   OPENAI_API_KEY, never the Codex login.
 * - a Claude model (`claude-*`, `haiku`, `sonnet`, `opus`, `anthropic@`) →
 *   the Anthropic Messages API, but ONLY as the collector. A Claude panel
 *   member goes to OpenRouter, as it always did.
 * - everything else (e.g. `grok-4.6` → `x-ai`) → OpenRouter, the id resolved
 *   through the catalog.
 *
 * Not subscription routing: the advisor never goes through `route()`.
 */
export function advisorRouteFor(modelSpec: string, role: "panel" | "collector"): AdvisorRoute {
  const parsed = parseModelSpec(modelSpec);

  if (role === "collector" && isAnthropicModel(parsed)) {
    const model = parsed.model;
    const aliasResolved =
      model === "haiku" || model === "sonnet" || model === "opus"
        ? findEntryByAlias(model)?.modelId
        : null;
    return routeOf("anthropic", aliasResolved ?? model);
  }

  const provider = parsed.provider;
  if (provider === "google" || provider === "gemini") return routeOf("google", parsed.model);
  if (provider === "openai" || provider === "oai") return routeOf("openai", parsed.model);

  // Everything else -> OpenRouter
  const rawModelId =
    parsed.isExplicitProvider && provider !== "openrouter"
      ? `${provider}/${parsed.model}`
      : parsed.model;
  return routeOf("openrouter", resolveModelNameSync(rawModelId, "openrouter").resolvedId);
}

/**
 * The credentials an advisor configuration can use: every panel model's, plus
 * the collector's when one can run (it needs more than one panel model).
 * A spec that fails to resolve is skipped; its call reports the failure.
 */
export function advisorCredentialsFor(
  models: string[],
  collector: string | null | undefined
): Set<AdvisorRouteKind> {
  const needed = new Set<AdvisorRouteKind>();
  const add = (spec: string, role: "panel" | "collector") => {
    try {
      needed.add(advisorRouteFor(spec, role).credential);
    } catch {
      // reported by the call itself
    }
  };
  for (const m of models) add(m, "panel");
  if (collector && models.length > 1) add(collector, "collector");
  return needed;
}

/**
 * The credential-authority provider each advisor credential resolves through.
 * `anthropic` is `native-anthropic`, which resolves exactly ANTHROPIC_API_KEY
 * (env → config → keychain → op://) and never the Claude Code OAuth token.
 */
export const ADVISOR_AUTHORITY_PROVIDER: Readonly<Record<AdvisorRouteKind, string>> = Object.freeze(
  {
    google: "google",
    openai: "openai",
    openrouter: "openrouter",
    anthropic: "native-anthropic",
  }
);

/**
 * True for the placeholder key claude-runner installs in proxy-auth mode
 * (`sk-ant-api03-placeholder-not-used-…`). It is not a credential: sending it
 * to api.anthropic.com is a guaranteed 401. Matched loosely on purpose — every
 * placeholder claudish or a wrapper has ever installed says so in its value,
 * and a real Anthropic key does not.
 */
export function isPlaceholderAnthropicKey(key: string): boolean {
  return /placeholder/i.test(key);
}

/**
 * THE advisor credential lookup: the startup check and the runtime call path
 * both resolve through this one function, so they cannot disagree about
 * whether a launch is possible. They did: startup asked the authority alone
 * and refused a Google panel model the runtime would have called with
 * GOOGLE_API_KEY.
 *
 * Only the two auth headers a credential provider signs with are read
 * (`Authorization` / `x-api-key`). The api-key half ALWAYS returns an object —
 * `{headers:{}}` with no key, or one carrying only static non-auth headers —
 * so neither the object nor "some header is non-empty" proves a credential
 * (CLAUDE.md).
 *
 * google: the authority's `google` provider is the DIRECT Gemini API
 * (GEMINI_API_KEY); Antigravity and Code Assist are registered under their own
 * names, and nothing may alias `google`. GOOGLE_API_KEY, which that provider
 * therefore never reads, stays a last-resort env fallback because the advisor
 * always accepted it.
 *
 * anthropic (collector only): ANTHROPIC_API_KEY as the authority resolves it,
 * never claudish's placeholder and never ANTHROPIC_AUTH_TOKEN — which the
 * native-anthropic provider would otherwise hand out as an `x-api-key`, and
 * which is the subscription arm's OAuth token. Claude Code's inbound
 * `authorization` bearer is not visible here at all; the runtime's own
 * inbound-`x-api-key` preference lives at its call site.
 *
 * Returns the secret, so a caller that needs presence only (the startup check)
 * must test it and drop it — never log or print it.
 */
export async function resolveAdvisorCredential(
  credential: AdvisorRouteKind
): Promise<string | undefined> {
  const fromAuthority = async (provider: string, header: "any" | "x-api-key") => {
    try {
      const auth = await credentials.getRequestAuth(provider, { model: "" });
      const bearer = auth.headers.Authorization?.replace(/^Bearer\s+/i, "").trim();
      const apiKey = auth.headers["x-api-key"]?.trim();
      return (header === "x-api-key" ? apiKey : bearer || apiKey) || undefined;
    } catch {
      return undefined;
    }
  };

  if (credential === "anthropic") {
    const key = await fromAuthority(ADVISOR_AUTHORITY_PROVIDER.anthropic, "x-api-key");
    if (!key || key === process.env.ANTHROPIC_AUTH_TOKEN || isPlaceholderAnthropicKey(key)) {
      return undefined;
    }
    return key;
  }
  if (credential === "google") {
    return (
      (await fromAuthority(ADVISOR_AUTHORITY_PROVIDER.google, "any")) ||
      process.env.GOOGLE_API_KEY?.trim() ||
      undefined
    );
  }
  return fromAuthority(ADVISOR_AUTHORITY_PROVIDER[credential], "any");
}

/** Builds an OpenAI chat-completions request for a non-Anthropic route. */
function buildAdvisorRequest(
  route: AdvisorRoute,
  messages: any[],
  apiKeys: AdvisorApiKeys,
  systemPrompt: string = ADVISOR_SYSTEM_PROMPT
): { headers: Record<string, string>; body: any } {
  if (route.kind === "anthropic") {
    // The Messages API has its own request shape; only the collector uses it.
    throw new Error(`${route.wireModel}: the Anthropic route is collector-only`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKeys[route.credential] ?? ""}`,
  };
  if (route.kind === "openrouter") {
    headers["HTTP-Referer"] = "https://claudish.com";
    headers["X-Title"] = "Claudish Advisor";
  }
  return {
    headers,
    body: {
      model: route.wireModel,
      max_tokens: 2048,
      messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAIMessages(messages)],
    },
  };
}

/**
 * What one panel or collector call actually did. Provenance is part of the
 * data type, never reconstructed from placeholder strings: `text` exists only
 * when `origin` is `upstream`, `reason` and `stubPath` only when it is not.
 */
export interface AdvisorModelOutcome {
  role: "panel" | "collector";
  /** The model spec as the user named it. */
  requestedModel: string;
  /** The route the request was sent on; null when the request could not be built. */
  route: AdvisorRoute | null;
  /** `extractUpstreamStatus(body) ?? response.status`; null when no response arrived. */
  upstreamStatus: number | null;
  upstreamStatusSource: UpstreamStatusSource | null;
  /** Bytes of the HTTP response body; 0 when none arrived. */
  responseBytes: number;
  latencyMs: number;
  origin: AdviceOrigin;
  stubPath: AdvisorStubPath | null;
  text?: string;
  reason?: string;
}

/** One advisor call end to end: every model's outcome and the delivered result. */
export interface AdvisorCallOutcome {
  toolUseId: string;
  sessionId: string | null;
  panel: AdvisorModelOutcome[];
  collector: string | null;
  /** null when no collector ran (none configured, one model, or no advice to synthesize). */
  collectorOutcome: AdvisorModelOutcome | null;
  /** `upstream` only when ≥1 panel model AND the collector (if it ran) were upstream. */
  resultOrigin: AdviceOrigin;
  /** The aggregate stub path when `resultOrigin` is not `upstream`. */
  stubPath: AdvisorStubPath | null;
  result: AdvisorToolResult;
}

interface AdvisorFetchPlan {
  role: AdvisorModelOutcome["role"];
  requestedModel: string;
  route: AdvisorRoute;
  headers: Record<string, string>;
  body: any;
  /** Abort after this long; undefined = no timeout. */
  timeoutMs?: number;
  extractText: (data: any) => string | undefined;
  /** Stub path when the call answered 2xx without usable advice text. */
  emptyStubPath: AdvisorStubPath;
  /** Stub path when the call failed outright. */
  errorStubPath: AdvisorStubPath;
}

/** Abort a panel call after this long; a failure like any other (stub path S7). */
const ADVISOR_PANEL_TIMEOUT_MS = 60_000;

/**
 * Abort a collector call after this long — BOTH collector routes. The
 * Anthropic collector had no timeout at all, so a collector that never
 * answered stalled a LIVE request indefinitely (the panel loop is awaited
 * before the upstream request is sent). A timeout is a recorded failure like
 * any other: origin `stub`, stub path S9, and the unchanged fall-back to the
 * panel's unsynthesized sections.
 */
const ADVISOR_COLLECTOR_TIMEOUT_MS = 30_000;

interface ObservedResponse {
  status: number;
  source: UpstreamStatusSource;
  bytes: number;
}

function stubOutcome(
  base: Pick<AdvisorModelOutcome, "role" | "requestedModel" | "route">,
  stubPath: AdvisorStubPath,
  reason: string,
  latencyMs: number,
  observed?: ObservedResponse
): AdvisorModelOutcome {
  return {
    ...base,
    upstreamStatus: observed?.status ?? null,
    upstreamStatusSource: observed?.source ?? null,
    responseBytes: observed?.bytes ?? 0,
    latencyMs,
    origin: "stub",
    stubPath,
    reason,
  };
}

function summarizeErrorBody(bodyText: string): string {
  let message = "";
  try {
    message = extractProviderMessage(JSON.parse(bodyText));
  } catch {
    message = bodyText;
  }
  const oneLine = String(message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine ? oneLine.slice(0, 200) : "(empty body)";
}

function describeFetchError(err: unknown, timeoutMs?: number): string {
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === "AbortError" && timeoutMs) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  return `request failed: ${e?.message ?? String(err)}`;
}

/**
 * Performs one advisor HTTP call and classifies it. Never rejects: every
 * failure becomes a `stub` outcome carrying its stub path and reason.
 *
 * The status is read from the body first because the advisor path uses bare
 * `fetch`, not a claudish handler: `extractUpstreamStatus` only finds
 * `error.upstream_status` when some remapping layer wrote it, so normally the
 * source is `http_status`. No status is invented when no response arrived.
 */
async function executeAdvisorFetch(
  plan: AdvisorFetchPlan,
  fetchImpl?: typeof fetch
): Promise<AdvisorModelOutcome> {
  const base = { role: plan.role, requestedModel: plan.requestedModel, route: plan.route };
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const controller = plan.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), plan.timeoutMs) : undefined;
  // Resolved per call, so an omitted seam is exactly the global fetch of today.
  const doFetch = fetchImpl ?? fetch;

  try {
    let resp: Response;
    try {
      resp = await doFetch(plan.route.url, {
        method: "POST",
        headers: plan.headers,
        body: JSON.stringify(plan.body),
        signal: controller?.signal,
      });
    } catch (err) {
      return stubOutcome(
        base,
        plan.errorStubPath,
        describeFetchError(err, plan.timeoutMs),
        elapsed()
      );
    }

    let bodyText: string;
    try {
      bodyText = await resp.text();
    } catch (err) {
      return stubOutcome(
        base,
        plan.errorStubPath,
        `HTTP ${resp.status} but the body could not be read: ${describeFetchError(err, plan.timeoutMs)}`,
        elapsed(),
        { status: resp.status, source: "http_status", bytes: 0 }
      );
    }

    const bodyStatus = extractUpstreamStatus(bodyText);
    const observed: ObservedResponse = {
      status: bodyStatus ?? resp.status,
      source: bodyStatus !== undefined ? "error.upstream_status" : "http_status",
      bytes: new TextEncoder().encode(bodyText).byteLength,
    };

    if (!resp.ok || (bodyStatus !== undefined && bodyStatus >= 400)) {
      return stubOutcome(
        base,
        plan.errorStubPath,
        `HTTP ${observed.status}: ${summarizeErrorBody(bodyText)}`,
        elapsed(),
        observed
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return stubOutcome(
        base,
        plan.emptyStubPath,
        `HTTP ${observed.status} but the response body is not JSON`,
        elapsed(),
        observed
      );
    }

    const text = plan.extractText(data);
    if (typeof text !== "string" || text.trim().length === 0) {
      return stubOutcome(
        base,
        plan.emptyStubPath,
        `HTTP ${observed.status} but the response carried no advice text`,
        elapsed(),
        observed
      );
    }

    return {
      ...base,
      upstreamStatus: observed.status,
      upstreamStatusSource: observed.source,
      responseBytes: observed.bytes,
      latencyMs: elapsed(),
      origin: "upstream",
      stubPath: null,
      text,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Advice text from an OpenAI chat-completions body. */
function extractChatCompletionText(data: any): string | undefined {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
    return joined || undefined;
  }
  return undefined;
}

/** Advice text from an Anthropic messages body: its first text block. */
function extractAnthropicText(data: any): string | undefined {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks.find((b: any) => b?.type === "text")?.text;
  return typeof text === "string" ? text : undefined;
}

function errorMessageOf(err: unknown): string {
  return (err as { message?: string } | undefined)?.message ?? String(err);
}

async function callAdvisorModel(
  modelSpec: string,
  messages: any[],
  apiKeys: AdvisorApiKeys,
  fetchImpl?: typeof fetch
): Promise<AdvisorModelOutcome> {
  let plan: AdvisorFetchPlan;
  try {
    const route = advisorRouteFor(modelSpec, "panel");
    const { headers, body } = buildAdvisorRequest(route, messages, apiKeys);
    plan = {
      role: "panel",
      requestedModel: modelSpec,
      route,
      headers,
      body,
      timeoutMs: ADVISOR_PANEL_TIMEOUT_MS,
      extractText: extractChatCompletionText,
      emptyStubPath: ADVISOR_STUB_PATHS.PANEL_EMPTY,
      errorStubPath: ADVISOR_STUB_PATHS.PANEL_ERROR,
    };
  } catch (err) {
    const base = { role: "panel" as const, requestedModel: modelSpec, route: null };
    return stubOutcome(
      base,
      ADVISOR_STUB_PATHS.PANEL_ERROR,
      `could not build the request: ${errorMessageOf(err)}`,
      0
    );
  }
  return executeAdvisorFetch(plan, fetchImpl);
}

function isAnthropicModel(parsed: ReturnType<typeof parseModelSpec>): boolean {
  const m = parsed.model.toLowerCase();
  return (
    parsed.provider === "anthropic" ||
    m.startsWith("claude-") ||
    m === "haiku" ||
    m === "sonnet" ||
    m === "opus"
  );
}

function planAnthropicCollector(
  requestedModel: string,
  route: AdvisorRoute,
  adviceText: string,
  apiKey?: string
): AdvisorFetchPlan {
  return {
    role: "collector",
    requestedModel,
    route,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: route.wireModel,
      max_tokens: 1024,
      system: COLLECTOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: adviceText }],
    },
    timeoutMs: ADVISOR_COLLECTOR_TIMEOUT_MS,
    extractText: extractAnthropicText,
    emptyStubPath: ADVISOR_STUB_PATHS.ANTHROPIC_COLLECTOR_EMPTY,
    errorStubPath: ADVISOR_STUB_PATHS.COLLECTOR_FAILED,
  };
}

async function callCollectorModel(
  collectorSpec: string,
  advice: Array<{ model: string; text: string }>,
  apiKeys: AdvisorApiKeys,
  fetchImpl?: typeof fetch
): Promise<AdvisorModelOutcome> {
  let plan: AdvisorFetchPlan;
  try {
    const adviceText = advice
      .map((a, i) => `### Advisor ${i + 1} (${a.model})\n${a.text}`)
      .join("\n\n");

    const route = advisorRouteFor(collectorSpec, "collector");

    if (route.kind === "anthropic") {
      plan = planAnthropicCollector(collectorSpec, route, adviceText, apiKeys.anthropic);
    } else {
      // External collector via OpenRouter/Google/OpenAI
      const { headers, body } = buildAdvisorRequest(route, [], apiKeys, COLLECTOR_SYSTEM_PROMPT);
      // Override messages since buildAdvisorRequest would try to convert
      body.messages = [
        { role: "system", content: COLLECTOR_SYSTEM_PROMPT },
        { role: "user", content: adviceText },
      ];
      plan = {
        role: "collector",
        requestedModel: collectorSpec,
        route,
        headers,
        body,
        timeoutMs: ADVISOR_COLLECTOR_TIMEOUT_MS,
        extractText: extractChatCompletionText,
        emptyStubPath: ADVISOR_STUB_PATHS.COLLECTOR_EMPTY,
        errorStubPath: ADVISOR_STUB_PATHS.COLLECTOR_FAILED,
      };
    }
  } catch (err) {
    const base = {
      role: "collector" as const,
      requestedModel: collectorSpec,
      route: null,
    };
    return stubOutcome(
      base,
      ADVISOR_STUB_PATHS.COLLECTOR_FAILED,
      `could not build the request: ${errorMessageOf(err)}`,
      0
    );
  }
  return executeAdvisorFetch(plan, fetchImpl);
}

/** The panel section for a model that produced no advice. Names model and reason. */
function panelFailureSection(o: AdvisorModelOutcome): string {
  return `## ${o.requestedModel}\n[Error: ${o.requestedModel} returned no advice — ${o.reason}]`;
}

function allPanelFailedText(panel: AdvisorModelOutcome[]): string {
  if (panel.length === 0) {
    return `${ADVISOR_ERROR_PREFIX} No advisor model is configured, so no advice was produced. ${ADVISOR_ERROR_SUFFIX}`;
  }
  const head =
    panel.length === 1
      ? `The advisor model ${panel[0].requestedModel} did not return advice.`
      : `None of the ${panel.length} advisor models returned advice.`;
  const lines = panel.map((o) => `- ${o.requestedModel}: ${o.reason}`);
  return `${ADVISOR_ERROR_PREFIX} ${head}\n${lines.join("\n")}\n${ADVISOR_ERROR_SUFFIX}`;
}

function collectorFailedText(collector: AdvisorModelOutcome, sections: string[]): string {
  return (
    `${ADVISOR_ERROR_PREFIX} The collector model ${collector.requestedModel} failed to synthesize ` +
    `the advice: ${collector.reason}. The panel's unsynthesized answers follow.\n\n` +
    sections.join("\n\n")
  );
}

function modelCallRecord(
  kind: "advisor_call" | "advisor_collector_call",
  outcome: AdvisorModelOutcome,
  call: Pick<AdvisorCallOutcome, "toolUseId" | "sessionId">
): Record<string, unknown> {
  return {
    kind,
    event: kind,
    toolUseId: call.toolUseId,
    sessionId: call.sessionId,
    role: outcome.role,
    requestedModel: outcome.requestedModel,
    provider: outcome.route?.kind ?? null,
    route: outcome.route ? { kind: outcome.route.kind, host: outcome.route.host } : null,
    routedModel: outcome.route?.wireModel ?? null,
    upstreamStatus: outcome.upstreamStatus,
    upstreamStatusSource: outcome.upstreamStatusSource,
    responseBytes: outcome.responseBytes,
    latencyMs: outcome.latencyMs,
    origin: outcome.origin,
    stubPath: outcome.stubPath,
    reason: outcome.reason ?? null,
  };
}

/**
 * Writes the P7 records for one call: one `advisor_call` per panel model, one
 * `advisor_collector_call` when a collector ran, and one `advisor_rewrite`.
 * Origin goes to the LOG only — never into the prompt or the advice text.
 */
function logAdvisorCallOutcome(cfg: AdvisorSwapConfig, o: AdvisorCallOutcome): void {
  for (const p of o.panel) logAdvisorEvent(cfg, modelCallRecord("advisor_call", p, o));
  if (o.collectorOutcome) {
    logAdvisorEvent(cfg, modelCallRecord("advisor_collector_call", o.collectorOutcome, o));
  }
  // `failedModels`: every panel member — and the collector, when it ran and
  // failed — whose origin is not `upstream`. Empty when nothing failed.
  //
  // WHY THE FIELD EXISTS. A PARTIAL panel failure (one member failed, another
  // answered, no collector) deliberately keeps `isError: false` and
  // `resultOrigin: "upstream"`: the model still receives the other members'
  // REAL advice, with the failure named in the text, and `is_error: true`
  // would tell it the whole call failed. That decision stands. But it left the
  // record for a partial failure indistinguishable from a clean one at a
  // glance — `originsByModel` carries the same truth, keyed per model, which
  // an audit has to walk. This is that truth as one flat list.
  const failedModels = [...o.panel, ...(o.collectorOutcome ? [o.collectorOutcome] : [])]
    .filter((m) => m.origin !== "upstream")
    .map((m) => m.requestedModel);
  logAdvisorEvent(cfg, {
    kind: "advisor_rewrite",
    event: "advisor_rewrite",
    toolUseId: o.toolUseId,
    sessionId: o.sessionId,
    panel: o.panel.map((p) => p.requestedModel),
    originsByModel: Object.fromEntries(o.panel.map((p) => [p.requestedModel, p.origin])),
    failedModels,
    collector: o.collector,
    collectorOrigin: o.collectorOutcome
      ? o.collectorOutcome.origin
      : o.collector
        ? ("absent" satisfies AdviceOrigin)
        : null,
    resultOrigin: o.resultOrigin,
    stubPath: o.stubPath,
    isError: o.result.isError,
  });
}

/** One warning per call in which any model failed, naming each model and reason. */
function warnOnAdvisorFailures(
  o: AdvisorCallOutcome,
  warn: (message: string) => void = warnAdvisor
): void {
  const failed = [...o.panel, ...(o.collectorOutcome ? [o.collectorOutcome] : [])].filter(
    (m) => m.origin !== "upstream"
  );
  if (failed.length === 0 && o.resultOrigin === "upstream") return;
  const detail =
    failed.length > 0
      ? failed
          .map(
            (m) => `${m.role === "collector" ? "collector " : ""}${m.requestedModel}: ${m.reason}`
          )
          .join("; ")
      : "no advisor model is configured";
  const verdict =
    o.resultOrigin === "upstream"
      ? "advice from the other models was still delivered"
      : "the model received an error report instead of advice";
  warn(`advisor call ${o.toolUseId} — ${detail} (${verdict})`);
}

export interface RunAdvisorCallParams {
  toolUseId: string;
  /** Claude Code session id of the request that consumed the call. */
  sessionId?: string;
  messages: any[];
  models: string[];
  collector: string | null;
  apiKeys: AdvisorApiKeys;
  /** When given, the P7 records are written to its advisor log. */
  cfg?: AdvisorSwapConfig;
  /**
   * Test seam: HTTP client for panel and collector calls. Defaults to the
   * global fetch, resolved at call time. Production callers leave it unset;
   * it exists so tests can drive the failure paths (S4-S9) without a network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam: receives the per-failure warning. Defaults to the sanctioned
   * warning channel (`warnAdvisor` -> `logStderr`, which adds the `[advisor] `
   * prefix; the seam receives the message without it). Production callers
   * leave it unset.
   */
  warn?: (message: string) => void;
}

/**
 * Runs one advisor call: every panel model in parallel, then the collector
 * when there is more than one answer to synthesize. Never rejects.
 *
 * The success path produces exactly the text it always did (R4): a single
 * model's answer as-is, the collector's synthesis, or — with no collector —
 * the `## model` sections. Failures produce plain text naming the model and
 * reason with `isError: true`, write the P7 log records, and raise one
 * warning.
 */
export async function runAdvisorCall(params: RunAdvisorCallParams): Promise<AdvisorCallOutcome> {
  const { toolUseId, messages, models, collector, apiKeys, fetchImpl } = params;

  const panel = await Promise.all(
    models.map((m) => callAdvisorModel(m, messages, apiKeys, fetchImpl))
  );
  const successful = panel.filter(
    (o): o is AdvisorModelOutcome & { text: string } => o.origin === "upstream"
  );
  const sections = panel.map((o) =>
    o.origin === "upstream" ? `## ${o.requestedModel}\n${o.text}` : panelFailureSection(o)
  );

  let result: AdvisorToolResult;
  let collectorOutcome: AdvisorModelOutcome | null = null;
  let resultOrigin: AdviceOrigin;
  let stubPath: AdvisorStubPath | null = null;

  if (models.length === 1 && successful.length === 1) {
    // Single advisor: its answer as-is.
    result = { text: successful[0].text, isError: false };
    resultOrigin = "upstream";
  } else if (successful.length === 0) {
    result = { text: allPanelFailedText(panel), isError: true };
    resultOrigin = "stub";
    stubPath = ADVISOR_STUB_PATHS.ALL_PANEL_FAILED;
  } else if (!collector) {
    // No collector: the sections verbatim.
    result = { text: sections.join("\n\n"), isError: false };
    resultOrigin = "upstream";
  } else {
    collectorOutcome = await callCollectorModel(
      collector,
      successful.map((o) => ({ model: o.requestedModel, text: o.text })),
      apiKeys,
      fetchImpl
    );
    if (collectorOutcome.origin === "upstream" && collectorOutcome.text !== undefined) {
      result = { text: collectorOutcome.text, isError: false };
      resultOrigin = "upstream";
    } else {
      log(
        `[advisor] collector ${collector} failed: ${collectorOutcome.reason}, falling back to concat`
      );
      result = { text: collectorFailedText(collectorOutcome, sections), isError: true };
      resultOrigin = "stub";
      stubPath = collectorOutcome.stubPath;
    }
  }

  const outcome: AdvisorCallOutcome = {
    toolUseId,
    sessionId: params.sessionId ?? null,
    panel,
    collector,
    collectorOutcome,
    resultOrigin,
    stubPath,
    result,
  };

  log(
    `[advisor] call ${toolUseId}: resultOrigin=${resultOrigin}${stubPath ? ` stubPath=${stubPath}` : ""} ` +
      `origins=${panel.map((p) => `${p.requestedModel}:${p.origin}`).join(",")}` +
      (collectorOutcome
        ? ` collector=${collectorOutcome.requestedModel}:${collectorOutcome.origin}`
        : "")
  );
  if (params.cfg) logAdvisorCallOutcome(params.cfg, outcome);
  warnOnAdvisorFailures(outcome, params.warn);
  return outcome;
}

/**
 * The original entry point, kept for compatibility: the delivered text only.
 * Prefer `runAdvisorCall`, which also reports provenance and `isError`.
 */
export async function fetchMultiModelAdvice(
  toolUseId: string,
  messages: any[],
  models: string[],
  collector: string | null,
  apiKeys: AdvisorApiKeys
): Promise<string> {
  const outcome = await runAdvisorCall({ toolUseId, messages, models, collector, apiKeys });
  return outcome.result.text;
}
