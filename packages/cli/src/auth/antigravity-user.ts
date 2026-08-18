/**
 * Antigravity project / tier / served-model resolution.
 *
 * Extracted from the retired `gemini-oauth.ts` when the Gemini Code Assist
 * provider was removed (Google retired the "Code Assist for individuals" tier
 * for gemini-cli's OAuth client — `UNSUPPORTED_CLIENT`). Only the Antigravity
 * half of that module survives, because only the Antigravity flow still reaches
 * this backend.
 *
 * Auth is NOT handled here: the access token comes from the shared `agy`
 * keychain store via `antigravity-token.ts`. This module answers the two
 * questions the transport asks once a token is in hand — which project/tier is
 * this account on, and which model ids does it actually serve.
 */

import { log } from "../logger.js";

/**
 * The Antigravity backend. Same host the retired Code Assist path used — the
 * split was never about the endpoint, it was about which OAuth client minted
 * the token.
 */
const ANTIGRAVITY_API_BASE = "https://cloudcode-pa.googleapis.com/v1internal";

/**
 * The served set changes on the daily-quota cadence, not per request, and both
 * lookups below are real network calls we don't want on every refreshAuth.
 */
const SERVED_MODELS_TTL_MS = 10 * 60 * 1000;

/** The `metadata.ideType` sent by the Antigravity provider. */
const ANTIGRAVITY_IDE_TYPE = "ANTIGRAVITY";

/** `loadCodeAssist` response — only the fields we read. */
interface LoadCodeAssistResponse {
  currentTier?: string | { id?: string };
  paidTier?: { id?: string; name?: string };
  cloudaicompanionProject?: string;
}

/**
 * Mark an error as a terminal CONFIGURATION verdict rather than a transient
 * fault. `composed-handler.ts` checks `err.terminal` and answers 400 inline, so
 * the explanation reaches the user immediately instead of being buried under
 * Claude Code's "API error · Retrying" banner for minutes of pointless backoff.
 */
function makeTerminalSetupError(message: string): Error {
  const err = new Error(message);
  (err as Error & { terminal?: boolean }).terminal = true;
  return err;
}

/**
 * Antigravity's own User-Agent — matches the captured Antigravity CLI exactly.
 *
 * `loadCodeAssist` gates the VISIBLE TIER on request identity (this UA plus
 * `metadata.ideType`), which is why it is reproduced verbatim. It does not gate
 * generation — that is gated on the OAuth client that minted the token, which
 * headers cannot fake. We present this identity because we are carrying a real
 * Antigravity token, not to impersonate one.
 */
export function buildAntigravityUserAgent(): string {
  return `antigravity/cli/1.1.9 (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`;
}

let cachedAgProjectId: string | null = null;
let cachedAgTierId: string | null = null;
let cachedAgTierName: string | null = null;

/** Clear the cached Antigravity project/tier (e.g. on account switch). */
export function resetAntigravityUserCache(): void {
  cachedAgProjectId = null;
  cachedAgTierId = null;
  cachedAgTierName = null;
  agServedCache = null;
  agServedCacheAt = 0;
}

/** loadCodeAssist with the Antigravity identity (minimal `{ ideType }` metadata). */
async function callLoadCodeAssistAntigravity(accessToken: string): Promise<LoadCodeAssistResponse> {
  const res = await fetch(`${ANTIGRAVITY_API_BASE}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": buildAntigravityUserAgent(),
    },
    // ONLY ideType — the individuals tier returns the project inline without
    // pluginType/platform.
    body: JSON.stringify({ metadata: { ideType: ANTIGRAVITY_IDE_TYPE } }),
  });

  if (!res.ok) {
    throw new Error(`loadCodeAssist (antigravity) failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as LoadCodeAssistResponse;
}

/**
 * Resolve the project + tier for the Antigravity flow.
 *
 * loadCodeAssist auto-provisions `cloudaicompanionProject` inline for the
 * individuals/Ultra tier, so there is NO onboardUser poll and NO
 * GOOGLE_CLOUD_PROJECT requirement. `paidTier.id` wins over `currentTier`.
 * Cached for the life of the process (env/account do not change mid-run).
 */
export async function setupAntigravityUser(
  accessToken: string
): Promise<{ projectId: string; tierId: string }> {
  if (cachedAgProjectId && cachedAgTierId) {
    return { projectId: cachedAgProjectId, tierId: cachedAgTierId };
  }

  const loadRes = await callLoadCodeAssistAntigravity(accessToken);
  log(`[Antigravity] loadCodeAssist response: ${JSON.stringify(loadRes)}`);

  const resolvedTier =
    loadRes.paidTier?.id ||
    (typeof loadRes.currentTier === "object" ? loadRes.currentTier?.id : loadRes.currentTier) ||
    "free-tier";

  const projectId = loadRes.cloudaicompanionProject;
  if (!projectId) {
    throw makeTerminalSetupError(
      "Antigravity did not return a project for this account. Sign in to Antigravity " +
        "(`claudish login antigravity`) and try again, or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  cachedAgProjectId = projectId;
  cachedAgTierId = resolvedTier;
  cachedAgTierName = loadRes.paidTier?.name || null;
  log(`[Antigravity] User set up, project: ${projectId}, tier: ${resolvedTier}`);
  return { projectId, tierId: resolvedTier };
}

/** Short display name for the Antigravity tier (status line). */
export function getAntigravityTierDisplayName(): string {
  if (!cachedAgTierName && !cachedAgTierId) return "Antigravity";
  const id = cachedAgTierId || "";
  if (id.includes("ultra")) return "Antigravity Ultra";
  if (id.includes("pro")) return "Antigravity Pro";
  if (id === "free-tier") return "Antigravity Free";
  return cachedAgTierName || "Antigravity";
}

/** Full tier name for the quota header — falls back to the short name. */
export function getAntigravityTierFullName(): string {
  return cachedAgTierName || getAntigravityTierDisplayName();
}

/** Quota bucket from retrieveUserQuota. */
export interface QuotaBucket {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
  tokenType?: string;
}

/**
 * Retrieve per-model quota usage. Returns buckets with remaining capacity per
 * model. Call after `setupAntigravityUser` (needs its projectId).
 *
 * THE USER-AGENT SELECTS WHICH TIER'S BUCKETS COME BACK. This call used to
 * send the gemini-cli UA (`GeminiCLI/0.5.6/gemini-code-assist`) it was written
 * with. That was known to be a live behavioural question rather than a
 * cosmetic one, and the measurement has now been made — same token, same
 * project, same endpoint, only the UA varied, on a real Ultra account
 * (2026-08-18):
 *
 *   gemini-cli UA  ->  4 buckets: gemini-2.5-flash, -2.5-flash-lite,
 *                      -2.5-pro, -3.1-flash-lite
 *   antigravity UA -> 24 buckets: the 3.x families (3.6-flash-*, 3.5-flash-*,
 *                      3.1-pro-*), plus claude-* and gpt-oss-* uids
 *
 * Those 4 are precisely the RETIRED free Code Assist served set. Identifying
 * as gemini-cli therefore asked the backend for a product the user is not on,
 * and the quota UI rendered "Antigravity Ultra" — a correct tier label from
 * `loadCodeAssist`, which always identified correctly — directly above four
 * models an Ultra subscriber does not use, all pinned at 0%.
 *
 * So this MUST match `loadCodeAssist`'s identity. Both calls hit the same host
 * and the backend answers each according to who is asking.
 */
export async function retrieveUserQuota(
  accessToken: string,
  projectId: string
): Promise<{ buckets?: QuotaBucket[] } | null> {
  try {
    const res = await fetch(`${ANTIGRAVITY_API_BASE}:retrieveUserQuota`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": buildAntigravityUserAgent(),
      },
      body: JSON.stringify({ project: projectId }),
    });
    if (!res.ok) {
      log(`[Antigravity] retrieveUserQuota failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as { buckets?: QuotaBucket[] };
  } catch (err) {
    log(`[Antigravity] retrieveUserQuota error: ${err}`);
    return null;
  }
}

/** Per-model record inside `fetchAvailableModels` (only the fields we read). */
interface AntigravityModelRecord {
  /** Context window, in tokens, AS SERVED BY ANTIGRAVITY. */
  maxTokens?: number;
  maxOutputTokens?: number;
  displayName?: string;
}

/** The Antigravity `fetchAvailableModels` response (only the fields we read). */
interface FetchAvailableModelsResponse {
  /** The served set — the KEYS of this dict ARE the served model ids. */
  models?: Record<string, AntigravityModelRecord>;
  /** Backend-provided default model id (e.g. "gemini-3.6-flash-high"). */
  defaultAgentModelId?: string;
}

/** What the backend reports about one served model. */
export interface AntigravityModelMeta {
  /** `maxTokens` — the window THIS subscription is served, not the model's spec. */
  contextWindow?: number;
  maxOutputTokens?: number;
  displayName?: string;
}

/** The live served-set + default id for the Antigravity account. */
export interface AntigravityServedModels {
  servedIds: string[];
  defaultId: string | null;
  /**
   * Per-model metadata, keyed by served id.
   *
   * Kept because the window Antigravity serves is NOT the model's published
   * spec, and the two disagree by a factor of four on at least one model:
   * measured 2026-08-18, the backend reports `claude-sonnet-4-6` at 250,000
   * tokens while the Firebase catalog lists 1,000,000. A session that trusts
   * the catalog plans against a window it does not have and compacts far too
   * late — the same class of failure the context-window work in v7.24.0 fixed
   * from the other direction.
   *
   * Every gemini id happens to agree (1,048,576 both ways), which is exactly
   * why the disagreement went unnoticed: the models people look at are fine.
   */
  meta: Record<string, AntigravityModelMeta>;
}

let agServedCache: AntigravityServedModels | null = null;
let agServedCacheAt = 0;

/**
 * Discover which model ids this account's Antigravity subscription serves — LIVE.
 *
 * `fetchAvailableModels` is the authoritative per-subscription served-set
 * endpoint: the KEYS of its `models` dict ARE the served ids (already carrying
 * their reasoning-tier suffix, e.g. `gemini-3.6-flash-high`), and
 * `defaultAgentModelId` is the backend's own default.
 *
 * Degrades to `{ servedIds: [], defaultId: null }` on any error, so the
 * transport's 404 handling still functions.
 */
export async function getServedAntigravityModels(
  accessToken: string,
  projectId: string,
  opts?: { force?: boolean }
): Promise<AntigravityServedModels> {
  const now = Date.now();
  if (!opts?.force && agServedCache && now - agServedCacheAt < SERVED_MODELS_TTL_MS) {
    return agServedCache;
  }
  try {
    const res = await fetch(`${ANTIGRAVITY_API_BASE}:fetchAvailableModels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": buildAntigravityUserAgent(),
      },
      // NOTE: the body is `{ project }` — NOT `{ metadata }` (that 400s here).
      body: JSON.stringify({ project: projectId }),
    });
    if (res.ok) {
      const data = (await res.json()) as FetchAvailableModelsResponse;
      const servedIds = data.models ? Object.keys(data.models) : [];
      const defaultId =
        typeof data.defaultAgentModelId === "string" ? data.defaultAgentModelId : null;
      if (servedIds.length > 0) {
        const meta: Record<string, AntigravityModelMeta> = {};
        for (const [id, record] of Object.entries(data.models ?? {})) {
          // Only record fields the backend actually sent. An absent maxTokens
          // (gemini-3.1-flash-image reports none) must stay absent so callers
          // fall back to the catalog rather than reading a fabricated 0.
          const entry: AntigravityModelMeta = {};
          if (typeof record?.maxTokens === "number" && record.maxTokens > 0) {
            entry.contextWindow = record.maxTokens;
          }
          if (typeof record?.maxOutputTokens === "number" && record.maxOutputTokens > 0) {
            entry.maxOutputTokens = record.maxOutputTokens;
          }
          if (typeof record?.displayName === "string" && record.displayName) {
            entry.displayName = record.displayName;
          }
          meta[id] = entry;
        }
        agServedCache = { servedIds, defaultId, meta };
        agServedCacheAt = now;
        return agServedCache;
      }
    } else {
      log(`[Antigravity] fetchAvailableModels failed: ${res.status}`);
    }
  } catch (err) {
    log(`[Antigravity] fetchAvailableModels error: ${err}`);
  }
  if (agServedCache) return agServedCache;
  return { servedIds: [], defaultId: null, meta: {} };
}

/** Test seam: clear the Antigravity served-models cache between tests. */
export function _resetAntigravityServedModelsCache(): void {
  agServedCache = null;
  agServedCacheAt = 0;
}
