/**
 * Antigravity shared OAuth token — read / refresh / write.
 *
 * Antigravity's own CLI (`agy`) stores its OAuth token in the macOS login
 * keychain, and claudish shares that SAME store so a single sign-in covers both
 * tools (Jack's explicit requirement). agy OWNS the refresh lifecycle too:
 * claudish never handles the Antigravity client secret in ANY form (no embed, no
 * scrape, no token exchange). When the shared token is expired, claudish asks agy
 * to refresh it — running `agy models` (a lightweight authed command that lists
 * served models, no generation quota) makes agy mint a fresh token with ITS OWN
 * current secret and write it back to the shared store. claudish then simply
 * RE-READS the store.
 *
 * Store layout (macOS login keychain):
 *   service = "gemini", account = "antigravity"
 *   value   = "go-keyring-base64:" + base64(JSON)   (zalando/go-keyring format)
 *   JSON    = { token: { access_token, token_type, refresh_token, expiry(RFC3339) },
 *               id_token, auth_method }
 *
 * Why delegate refresh: Antigravity's client_secret is a static literal baked
 * into the `agy` binary, and agy AUTO-UPDATES — each release rotates the secret
 * and Google revokes the old one — so any secret claudish embedded or scraped
 * would break within days, and there's no dynamic client registration. Letting
 * agy do the refresh means claudish is always current, holds no secret, and stays
 * out of the OAuth-client business entirely.
 *
 * Every side effect (keychain read/write/delete, the agy refresh command, clock)
 * is behind an injectable `deps` object so the module is fully testable with no
 * real keychain and no real agy process.
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
/** Refresh when the access token is within this window of its expiry (~2 min). */
const EXPIRY_SKEW_MS = 120_000;
/** Max time to wait for `agy models` to refresh the shared token. */
const AGY_REFRESH_TIMEOUT_MS = 40_000;

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

/**
 * Injectable side-effect seams. Tests supply fakes so no real keychain, agy
 * process, or clock is ever touched.
 */
export interface AntigravityTokenDeps {
  /** Read the raw keychain value (with the `go-keyring-base64:` prefix), or null. */
  readStore: () => string | null;
  /** Write the raw keychain value (with the prefix). */
  writeStore: (rawValue: string) => void;
  /** Delete the shared keychain item entirely (logout). Optional; defaults to `security delete-generic-password`. */
  deleteStore?: () => void;
  /**
   * Ask the Antigravity CLI to refresh the shared token — the real implementation
   * runs `agy models` (a lightweight authed command), which makes agy mint a fresh
   * token with its OWN current secret and write it back to the shared store. A
   * no-op when agy isn't installed (the caller then re-reads, finds it still
   * stale, and throws). claudish never touches the client secret itself.
   */
  runAgyRefresh: () => void;
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

/**
 * Locate the user's agy binary: `which agy`, else ~/.local/bin/agy.
 * Exported so the login-delegation flow (antigravity-oauth.ts) uses the SAME
 * locator as the refresh scrape.
 */
export function locateAgyBinary(): string | null {
  try {
    const p = execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
    if (p.length > 0) return p;
  } catch {
    // fall through to the conventional install path
  }
  const fallback = join(homedir(), ".local", "bin", "agy");
  return existsSync(fallback) ? fallback : null;
}

/** Delete the shared token via macOS `security` (idempotent — missing item is fine). */
function defaultDeleteStore(): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Item not found / already gone — logout is idempotent.
  }
}

/**
 * Ask the Antigravity CLI to refresh the shared token.
 *
 * `agy models` is a lightweight authed command (lists served models — no
 * generation quota). Running it when the stored token is expired makes agy mint a
 * fresh token with ITS OWN current secret and write it back to the shared store;
 * claudish then simply re-reads it. No-op (silent) when agy isn't installed — the
 * caller re-reads, sees the token is still stale, and throws an actionable error.
 * claudish never handles the client secret in any form.
 */
function defaultRunAgyRefresh(): void {
  const agy = locateAgyBinary();
  if (!agy) return;
  try {
    execFileSync(agy, ["models"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: AGY_REFRESH_TIMEOUT_MS,
    });
  } catch {
    // Non-zero exit / timeout — the caller re-reads the store and decides.
  }
}

const defaultDeps: AntigravityTokenDeps = {
  readStore: defaultReadStore,
  writeStore: defaultWriteStore,
  deleteStore: defaultDeleteStore,
  runAgyRefresh: defaultRunAgyRefresh,
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
 * access_token / refresh_token / expiry / token_type are replaced. This is the
 * refresh write-back; agy owns the FULL record on first login.
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

/**
 * Delete the shared Antigravity token (logout). Idempotent — a missing item is
 * not an error. Also clears the memoized presence flag so the config TUI reflects
 * the logout immediately.
 */
export function deleteSharedAntigravityToken(deps: AntigravityTokenDeps = defaultDeps): void {
  (deps.deleteStore ?? defaultDeleteStore)();
  _resetAntigravityTokenState();
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
      "[Antigravity] No Antigravity session found. Sign in with `claudish login antigravity`, " +
        "or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  if (!needsRefresh(rec.token, deps.now())) {
    return rec.token.access_token;
  }

  // Expired/near-expiry → ask agy to refresh (it owns the secret). Running `agy
  // models` mints a fresh token into the shared store; we then RE-READ it.
  log("[Antigravity] Access token expired/near-expiry — asking the Antigravity CLI to refresh.");
  deps.runAgyRefresh();

  const refreshedRec = parseRecord(deps.readStore());
  if (refreshedRec && !needsRefresh(refreshedRec.token, deps.now())) {
    log("[Antigravity] Shared token refreshed by the Antigravity CLI.");
    return refreshedRec.token.access_token;
  }

  // agy wasn't installed, or ran but the token is still stale (revoked session).
  throw new Error(
    "[Antigravity] Antigravity session expired and couldn't be refreshed. " +
      "Run `claudish login antigravity` (installs/authenticates the Antigravity CLI)."
  );
}

/**
 * Read → refresh-if-needed (via agy) → return a valid Antigravity access token.
 * Single-flight: concurrent callers share one in-flight resolution so only ONE
 * `agy models` refresh runs even under a parallel spawn. Throws a clear,
 * actionable error when the store is missing (not signed in), when agy can't
 * refresh it, or on a non-macOS platform.
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

/** Clear the in-flight promise and the memoized presence flag (between tests). */
export function _resetAntigravityTokenState(): void {
  inFlight = null;
  cachedHasToken = null;
}
