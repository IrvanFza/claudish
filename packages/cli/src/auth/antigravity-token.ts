/**
 * Antigravity shared OAuth token — read / refresh / write.
 *
 * Antigravity's own CLI (`agy`) stores its OAuth token in the macOS login
 * keychain, and claudish shares that SAME store so a single sign-in covers both
 * tools (Jack's explicit requirement). claudish also owns the refresh lifecycle:
 * when the access token is expired or near-expiry it refreshes against Google's
 * token endpoint and writes the fresh (possibly rotated) token back, so `agy`
 * picks it up too.
 *
 * Store layout (macOS login keychain):
 *   service = "gemini", account = "antigravity"
 *   value   = "go-keyring-base64:" + base64(JSON)   (zalando/go-keyring format)
 *   JSON    = { token: { access_token, token_type, refresh_token, expiry(RFC3339) },
 *               id_token, auth_method }
 *
 * SECURITY: claudish never ships Antigravity's OAuth client_id / client_secret.
 * They are extracted at runtime from the user's OWN `agy` binary (the same
 * install we read the token from) and the working pair is discovered by trying
 * combos against the refresh endpoint until one returns 200.
 *
 * Every side effect (keychain read/write, cred extraction, HTTP, clock) is
 * behind an injectable `deps` object so the module is fully testable with no
 * real keychain or network.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, logStderr } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keychain service used by the shared agy/claudish token item. */
const KC_SERVICE = "gemini";
/** Keychain account used by the shared agy/claudish token item. */
const KC_ACCOUNT = "antigravity";
/** go-keyring single-item value prefix. Chunked values use other prefixes (unsupported). */
const PREFIX = "go-keyring-base64:";
/** Google's OAuth2 token endpoint (refresh grant). */
const REFRESH_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Refresh when the access token is within this window of its expiry (~2 min). */
const EXPIRY_SKEW_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The OAuth token as stored under `token` in the shared store's JSON. */
export interface AntigravityToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  /** RFC3339 timestamp of access-token expiry (Go time.Time format). */
  expiry: string;
}

/** The full decoded shared-store record. Unknown fields are preserved on write. */
interface SharedStoreRecord {
  token: AntigravityToken;
  id_token?: string;
  auth_method?: string;
  [key: string]: unknown;
}

/** A candidate OAuth client credential pair extracted from the agy binary. */
export interface ClientCred {
  clientId: string;
  clientSecret: string;
}

/** Minimal fetch signature (avoids depending on the global's extra `preconnect`). */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Injectable side-effect seams. Tests supply fakes so no real keychain, binary,
 * network, or clock is ever touched.
 */
export interface AntigravityTokenDeps {
  /** Read the raw keychain value (with the `go-keyring-base64:` prefix), or null. */
  readStore: () => string | null;
  /** Write the raw keychain value (with the prefix). */
  writeStore: (rawValue: string) => void;
  /** Best-effort candidate client-cred pairs extracted from the local agy binary. */
  extractCreds: () => ClientCred[];
  /** HTTP client (defaults to global fetch). */
  fetch: FetchFn;
  /** Current time in ms since epoch (defaults to Date.now). */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Default (real) deps
// ---------------------------------------------------------------------------

/** Read the shared token via macOS `security`. Non-darwin → null (with a warning). */
function defaultReadStore(): string | null {
  if (process.platform !== "darwin") {
    logStderr(
      "[Antigravity] Shared token store is macOS-only for now (other keyring backends are a follow-up)."
    );
    return null;
  }
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"],
      { encoding: "utf8" }
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Item not found (agy not signed in) or `security` unavailable.
    return null;
  }
}

/** Write the shared token via macOS `security` (upsert with -U). */
function defaultWriteStore(rawValue: string): void {
  if (process.platform !== "darwin") {
    throw new Error("[Antigravity] Cannot write the shared token store on a non-macOS platform.");
  }
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w", rawValue],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
}

/** Locate the user's agy binary: `which agy`, else ~/.local/bin/agy. */
function locateAgyBinary(): string | null {
  try {
    const p = execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
    if (p.length > 0) return p;
  } catch {
    // fall through to the conventional install path
  }
  const fallback = join(homedir(), ".local", "bin", "agy");
  return existsSync(fallback) ? fallback : null;
}

/**
 * Extract OAuth client-cred candidates from the agy binary via `strings`.
 * Returns the cartesian product of discovered client-ids × secrets, deduped.
 * Best-effort: any failure yields an empty list (self-refresh is then
 * unavailable, but a still-valid token keeps working).
 */
function defaultExtractCreds(): ClientCred[] {
  const agy = locateAgyBinary();
  if (!agy) {
    logStderr("[Antigravity] Could not locate the `agy` binary — self-refresh is unavailable.");
    return [];
  }
  let dump: string;
  try {
    dump = execFileSync("strings", [agy], {
      encoding: "utf8",
      // agy is a large Go binary; allow a generous buffer for the strings dump.
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    logStderr("[Antigravity] `strings` failed on the agy binary — self-refresh is unavailable.");
    return [];
  }
  const clientIds = Array.from(
    new Set(dump.match(/[0-9]{6,}-[a-z0-9]+\.apps\.googleusercontent\.com/g) ?? [])
  );
  const secrets = Array.from(new Set(dump.match(/GOCSPX-[A-Za-z0-9_-]{20,}/g) ?? []));
  const combos: ClientCred[] = [];
  for (const clientId of clientIds) {
    for (const clientSecret of secrets) {
      combos.push({ clientId, clientSecret });
    }
  }
  return combos;
}

const defaultDeps: AntigravityTokenDeps = {
  readStore: defaultReadStore,
  writeStore: defaultWriteStore,
  extractCreds: defaultExtractCreds,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Decode the raw store value into a record. Returns null when absent/unsupported. */
function parseRecord(raw: string | null): SharedStoreRecord | null {
  if (!raw) return null;
  if (!raw.startsWith(PREFIX)) {
    // go-keyring chunks values that exceed the keychain item limit under other
    // prefixes; that layout is unsupported for now.
    logStderr(
      "[Antigravity] Shared token is in an unsupported keyring format (not go-keyring-base64) — skipping."
    );
    return null;
  }
  try {
    const json = Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8");
    const rec = JSON.parse(json) as SharedStoreRecord;
    if (!rec?.token?.access_token) return null;
    return rec;
  } catch (err) {
    log(`[Antigravity] Failed to decode shared token: ${err}`);
    return null;
  }
}

/** Encode a record back into the raw `go-keyring-base64:` store value. */
function encodeRecord(rec: SharedStoreRecord): string {
  return PREFIX + Buffer.from(JSON.stringify(rec), "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Public: read / write
// ---------------------------------------------------------------------------

/** Read the current shared Antigravity token, or null if absent/unsupported. */
export function readSharedAntigravityToken(
  deps: AntigravityTokenDeps = defaultDeps
): AntigravityToken | null {
  const rec = parseRecord(deps.readStore());
  return rec ? rec.token : null;
}

/**
 * Memoized "is an Antigravity token present in the shared store" — for the SYNC
 * readiness classifier that the config TUI's React render path calls on every
 * frame. `readSharedAntigravityToken()` shells out to `security`, so cache the
 * boolean for a few seconds; the TTL means signing into Antigravity is reflected
 * without a claudish restart, without spawning a process per render.
 */
let cachedHasToken: { at: number; value: boolean } | null = null;
const HAS_TOKEN_TTL_MS = 5000;
export function hasSharedAntigravityToken(deps: AntigravityTokenDeps = defaultDeps): boolean {
  const now = Date.now();
  if (cachedHasToken && now - cachedHasToken.at < HAS_TOKEN_TTL_MS) return cachedHasToken.value;
  let value = false;
  try {
    value = readSharedAntigravityToken(deps) != null;
  } catch {
    value = false;
  }
  cachedHasToken = { at: now, value };
  return value;
}

/**
 * Write an updated Antigravity token back to the shared store, PRESERVING every
 * other field (id_token / auth_method / unknown keys) — only the token's
 * access_token / refresh_token / expiry / token_type are replaced.
 */
export function writeSharedAntigravityToken(
  tok: AntigravityToken,
  deps: AntigravityTokenDeps = defaultDeps
): void {
  const existing = parseRecord(deps.readStore());
  const base: SharedStoreRecord = existing ?? { token: tok };
  const merged: SharedStoreRecord = {
    ...base,
    token: { ...base.token, ...tok },
  };
  deps.writeStore(encodeRecord(merged));
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** True when the access token is expired or within EXPIRY_SKEW_MS of expiry. */
function needsRefresh(tok: AntigravityToken, now: number): boolean {
  const expMs = Date.parse(tok.expiry);
  // An unparseable/absent expiry is treated as needing refresh (fail safe).
  if (Number.isNaN(expMs)) return true;
  return now >= expMs - EXPIRY_SKEW_MS;
}

/** The client-cred pair proven to work this process — cached after first success. */
let cachedCred: ClientCred | null = null;

/**
 * Refresh the access token. The client-cred combo is discovered AS the refresh:
 * each candidate is tried against the token endpoint and the first 200 both
 * proves the pair (cached for subsequent refreshes) and yields the new token.
 * The refresh_token may ROTATE — the response's is written back when present.
 */
async function refreshToken(
  tok: AntigravityToken,
  deps: AntigravityTokenDeps
): Promise<AntigravityToken> {
  const combos = cachedCred ? [cachedCred] : deps.extractCreds();
  if (combos.length === 0) {
    throw new Error(
      "[Antigravity] Access token expired and no OAuth client credentials could be extracted " +
        "from the `agy` binary to refresh it. Re-run the Antigravity CLI to refresh your session, " +
        "or use g@<model> with GEMINI_API_KEY."
    );
  }

  let lastStatus = 0;
  let lastBody = "";
  for (const cred of combos) {
    const res = await deps.fetch(REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        refresh_token: tok.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (res.ok) {
      cachedCred = cred;
      const j = (await res.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string;
      };
      const expiry = new Date(deps.now() + j.expires_in * 1000).toISOString();
      return {
        access_token: j.access_token,
        token_type: tok.token_type || "Bearer",
        // Google may rotate the refresh token — keep the new one when returned.
        refresh_token: j.refresh_token || tok.refresh_token,
        expiry,
      };
    }

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");
  }

  throw new Error(
    `[Antigravity] Token refresh failed for all ${combos.length} client-cred combo(s) ` +
      `(last HTTP ${lastStatus}${lastBody ? `: ${lastBody.slice(0, 200)}` : ""}). ` +
      "Re-run the Antigravity CLI to refresh your session, or use g@<model> with GEMINI_API_KEY."
  );
}

// ---------------------------------------------------------------------------
// Public: valid access token (single-flight)
// ---------------------------------------------------------------------------

/** In-flight resolve promise — collapses concurrent callers onto one refresh. */
let inFlight: Promise<string> | null = null;

async function resolveValidToken(deps: AntigravityTokenDeps): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "[Antigravity] The shared Antigravity token store is macOS-only for now. " +
        "Use g@<model> with GEMINI_API_KEY on this platform."
    );
  }

  const rec = parseRecord(deps.readStore());
  if (!rec) {
    throw new Error(
      "[Antigravity] No Antigravity session found. Install Antigravity and sign in " +
        "(the `agy` CLI), or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  const tok = rec.token;
  if (!needsRefresh(tok, deps.now())) {
    return tok.access_token;
  }

  log("[Antigravity] Access token expired/near-expiry — refreshing.");
  const refreshed = await refreshToken(tok, deps);
  writeSharedAntigravityToken(refreshed, deps);
  log("[Antigravity] Token refreshed and written back to the shared store.");
  return refreshed.access_token;
}

/**
 * Read → refresh-if-needed → write-back → return a valid Antigravity access
 * token. Single-flight: concurrent callers share one in-flight resolution so a
 * refresh never races itself. Throws a clear, actionable error when the store is
 * missing (agy not installed / not signed in) or on a non-macOS platform.
 */
export function getValidAntigravityAccessToken(
  deps: AntigravityTokenDeps = defaultDeps
): Promise<string> {
  if (inFlight) return inFlight;
  inFlight = resolveValidToken(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Clear the in-flight promise and the cached client-cred (between tests). */
export function _resetAntigravityTokenState(): void {
  inFlight = null;
  cachedCred = null;
  cachedHasToken = null;
}
