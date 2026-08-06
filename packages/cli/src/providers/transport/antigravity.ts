/**
 * AntigravityProviderTransport — Antigravity (cloudcode-pa backend) via the
 * SHARED Antigravity OAuth token.
 *
 * Adapted from the since-removed providers/transport/gemini-codeassist.ts. It keeps ALL of that
 * transport's hardening — the 429 classification (RATE_LIMIT_EXCEEDED retry /
 * MODEL_CAPACITY_EXHAUSTED fallback / QUOTA_EXHAUSTED terminal), the live
 * served-set discovery, the capacity fallback chain, and the served-set-aware
 * 404 rewrite (F1–F7) — and differs only in identity and model handling:
 *
 * - Auth token comes from getValidAntigravityAccessToken() (the shared agy
 *   keychain item, self-refreshed), NOT the gemini-cli login token.
 * - Identity is ALWAYS Antigravity: the antigravity UA + ideType ANTIGRAVITY,
 *   independent of CLAUDISH_GEMINI_ANTIGRAVITY.
 * - The requested model id is resolved to a LIVE-served id
 *   (resolveAntigravityModelId over getServedAntigravityModels) before the
 *   envelope is built.
 *
 * Transport concerns:
 * - OAuth access token via getValidAntigravityAccessToken()
 * - Project ID + tier via setupAntigravityUser()
 * - Fixed endpoint: cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 * - Wraps payload in the CodeAssist envelope: {model, project, user_prompt_id, request}
 * - GeminiRequestQueue for rate limiting
 * - gemini-sse stream format (with response wrapper)
 */

import { randomUUID } from "node:crypto";
import { getValidAntigravityAccessToken } from "../../auth/antigravity-token.js";
import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import {
  buildAntigravityUserAgent,
  getAntigravityTierDisplayName,
  getServedAntigravityModels,
  retrieveUserQuota,
  setupAntigravityUser,
} from "../../auth/antigravity-user.js";
import { lookupFamilyDefaultVariant } from "../../adapters/model-catalog.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import { log, logStderr } from "../../logger.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

// The backend host. Still the cloudcode-pa endpoint the retired Code Assist
// path used — the split was never about the URL, it was about which OAuth
// client minted the token.
const ANTIGRAVITY_BASE = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT = `${ANTIGRAVITY_BASE}/v1internal:streamGenerateContent?alt=sse`;

/** Max retry attempts for retryable 429s (RATE_LIMIT_EXCEEDED) */
const MAX_RETRY_ATTEMPTS = 3;
/** Default retry delay when server doesn't specify one */
const DEFAULT_RATE_LIMIT_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// Model-id resolution (live served set — NO hardcoded model ids)
// ---------------------------------------------------------------------------

/**
 * Reasoning-tier RANK — a LAST-RESORT rule, used only when neither the backend
 * nor the catalog names a default.
 *
 * Two authorities come first: the Antigravity backend's own
 * `defaultAgentModelId` (per-account, from fetchAvailableModels), and the slim
 * catalog's `routeVariant.isDefault` (per-family, e.g. `gemini-3.6-flash-high`
 * for family `gemini-3.6-flash`). This ordering only matters when both are
 * silent — a genuinely cold path. Lower number = stronger tier.
 */
const REASONING_TIER_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  "extra-low": 3,
  tiered: 4,
};

/** Rank a reasoning-tier suffix (the part after the family name). */
function rankReasoningSuffix(suffix: string): number {
  const rank = REASONING_TIER_RANK[suffix.toLowerCase()];
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * Rank a FULL served id by its reasoning-tier suffix, for display ordering
 * (strongest tier first). A bare family id with no recognised suffix ranks
 * last. Same rule as `rankReasoningSuffix`, applied to a whole id — the caller
 * has served ids, not pre-split family/suffix pairs.
 */
export function rankAntigravityModel(modelId: string): number {
  const dash = modelId.lastIndexOf("-");
  if (dash === -1) return Number.MAX_SAFE_INTEGER;
  // "extra-low" is the one two-word suffix, so try the last TWO segments first.
  const parts = modelId.split("-");
  if (parts.length >= 2) {
    const twoWord = rankReasoningSuffix(`${parts[parts.length - 2]}-${parts[parts.length - 1]}`);
    if (twoWord !== Number.MAX_SAFE_INTEGER) return twoWord;
  }
  return rankReasoningSuffix(modelId.slice(dash + 1));
}

/**
 * Resolve a user-supplied model id to the id the Antigravity backend serves,
 * using ONLY the LIVE served set (from fetchAvailableModels). No pinned model
 * ids — the served ids and the default come from the account's own subscription.
 *
 * Rules (pure, exported for testing):
 *  1. Exact hit — `servedIds` contains `requested` → return it.
 *  2. CATALOG — the slim catalog's `routeVariant.isDefault` names this family's
 *     default variant (e.g. `gemini-3.1-pro-high` for `gemini-3.1-pro-preview`).
 *     Taken when that id is actually served. This is the ONLY rule that can
 *     bridge a catalog id whose stem differs from the backend's — the served id
 *     `gemini-3.1-pro-high` does not extend `gemini-3.1-pro-preview-`, so the
 *     prefix rule below cannot see it, and the request 404s.
 *  3. Family variants — served ids that extend `requested-` (e.g.
 *     `gemini-3.6-flash-high` for `gemini-3.6-flash`). If any exist:
 *       - if the backend `defaultId` is one of them → return `defaultId`;
 *       - else the strongest reasoning tier by suffix RANK.
 *  4. Otherwise — return `requested` unchanged and let the backend 404, which
 *     the served-set-aware 404 rewrite (F1–F7) turns into an actionable error.
 *
 * `catalogDefault` is injected rather than looked up inside, so the function
 * stays pure and testable.
 */
export function resolveAntigravityModelId(
  requested: string,
  servedIds: string[],
  defaultId: string | null,
  catalogDefault?: string | null
): string {
  const req = requested.trim();

  if (servedIds.includes(req)) return req;

  if (catalogDefault && servedIds.includes(catalogDefault)) return catalogDefault;

  const familyPrefix = `${req}-`;
  const variants = servedIds.filter((id) => id.startsWith(familyPrefix));
  if (variants.length > 0) {
    if (defaultId && variants.includes(defaultId)) return defaultId;
    let best = variants[0];
    let bestRank = rankReasoningSuffix(best.slice(familyPrefix.length));
    for (const variant of variants.slice(1)) {
      const rank = rankReasoningSuffix(variant.slice(familyPrefix.length));
      if (rank < bestRank) {
        best = variant;
        bestRank = rank;
      }
    }
    return best;
  }

  return req;
}

/** Generate a short random request ID (matches the Antigravity CLI activity logger) */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

/** Classification of 429 responses from the Code Assist API */
interface QuotaClassification {
  /** Whether this 429 is terminal (don't retry) */
  terminal: boolean;
  /** Suggested retry delay in ms (from server RetryInfo or defaults) */
  retryDelayMs?: number;
  /** The specific reason from ErrorInfo */
  reason?: string;
}

/**
 * Classify a 429 response to determine retry behavior.
 * - RATE_LIMIT_EXCEEDED → retryable (short-window per-minute limit)
 * - QUOTA_EXHAUSTED → terminal (daily limit hit)
 * - MODEL_CAPACITY_EXHAUSTED → terminal (triggers model fallback instead)
 */
function classify429(responseBody: string): QuotaClassification | null {
  try {
    const raw = JSON.parse(responseBody);
    const error = Array.isArray(raw) ? raw[0]?.error : raw?.error;
    const details = Array.isArray(error?.details) ? error.details : [];

    const retryInfo = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    );
    let retryDelayMs = parseRetryDelay(retryInfo?.retryDelay);

    if (retryDelayMs === undefined && typeof error?.message === "string") {
      const match = error.message.match(/retry in ([\d.]+)(ms|s)/i);
      if (match) {
        const val = Number.parseFloat(match[1]);
        retryDelayMs = match[2] === "ms" ? Math.round(val) : Math.round(val * 1000);
      }
    }

    const errorInfo = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
    );
    const reason = errorInfo?.reason;

    if (reason === "QUOTA_EXHAUSTED") {
      return { terminal: true, retryDelayMs, reason };
    }
    if (reason === "RATE_LIMIT_EXCEEDED") {
      return { terminal: false, retryDelayMs: retryDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, reason };
    }
    if (reason === "MODEL_CAPACITY_EXHAUSTED") {
      return { terminal: true, retryDelayMs, reason };
    }

    const quotaFailure = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
    );
    if (quotaFailure?.violations?.length) {
      const text = quotaFailure.violations
        .map((v: any) => `${v.quotaId || ""} ${v.description || ""}`)
        .join(" ")
        .toLowerCase();
      if (text.includes("perday") || text.includes("daily") || text.includes("per day")) {
        return { terminal: true, retryDelayMs, reason };
      }
      if (text.includes("perminute") || text.includes("per minute")) {
        return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000, reason };
      }
    }

    return { terminal: false, retryDelayMs, reason };
  } catch {
    return null;
  }
}

/** Parse RetryInfo.retryDelay which can be string ("2.5s") or object ({seconds, nanos}) */
function parseRetryDelay(value: any): number | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const match = value.match(/([\d.]+)s/);
    return match ? Math.round(Number.parseFloat(match[1]) * 1000) : undefined;
  }
  if (typeof value === "object") {
    const seconds = typeof value.seconds === "number" ? value.seconds : 0;
    const nanos = typeof value.nanos === "number" ? value.nanos : 0;
    const ms = Math.round(seconds * 1000 + nanos / 1e6);
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

export class AntigravityProviderTransport implements ProviderTransport {
  readonly name = "antigravity";
  private _displayName = "Antigravity";
  get displayName(): string {
    return this._displayName;
  }
  readonly streamFormat: StreamFormat = "gemini-sse";

  /** The user-supplied model id (for messages + the credential ctx). */
  private modelName: string;
  /** The served id actually sent to the backend (mapped from modelName). */
  private servedModelName: string;
  private accessToken: string | null = null;
  private projectId: string | null = null;
  private tierId: string | null = null;

  /**
   * The delegated per-request auth artifact (headers + CodeAssist-envelope
   * transform) from the credential authority, populated by refreshAuth(). The
   * PRIMARY request's headers + envelope come from here. The local
   * accessToken/projectId/tierId below are kept in lockstep purely for the 429
   * fallback chain and quota logic (request-routing concerns, not auth).
   */
  private cachedAuth: RequestAuth | null = null;

  /** The last envelope built by transformPayload, stored for fallback retries */
  private lastEnvelope: any = null;

  /** Set when a fallback model is used instead of the requested one */
  private _activeModelName: string | undefined;

  /**
   * Model ids this account's Antigravity subscription currently serves,
   * discovered LIVE in refreshAuth() via getServedAntigravityModels()
   * (fetchAvailableModels). Used for model-id resolution, the capacity-fallback
   * chain, and the model-not-found hint.
   */
  private servedModels: string[] = [];

  /** The backend-provided default served model id (from fetchAvailableModels). */
  private defaultServedModel: string | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
    // Resolved against the LIVE served set in refreshAuth(); until then the raw
    // name is a safe placeholder (composed-handler always awaits refreshAuth
    // before any request).
    this.servedModelName = modelName;
  }

  getActiveModelName(): string | undefined {
    return this._activeModelName;
  }

  getEndpoint(): string {
    return ANTIGRAVITY_ENDPOINT;
  }

  async getHeaders(): Promise<Record<string, string>> {
    // PRIMARY request: headers come from the delegated auth artifact. If
    // refreshAuth() hasn't run yet (or delegation failed), fall back to a
    // locally-built header set so the fallback chain's per-attempt getHeaders()
    // still mints fresh credentials.
    if (this.cachedAuth) return { ...this.cachedAuth.headers };
    return this.buildLocalHeaders();
  }

  /**
   * Build the Antigravity headers from local OAuth state. Used by the 429
   * fallback chain (handleCapacityExhausted), which needs a fresh
   * x-activity-request-id per attempt. The PRIMARY request uses the delegated
   * artifact's headers instead (see getHeaders()).
   */
  private buildLocalHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": buildAntigravityUserAgent(),
      "x-activity-request-id": createActivityRequestId(),
    };
  }

  /**
   * Refresh auth before each request. The transport delegates the request
   * artifact (headers + CodeAssist envelope) to the credential authority. It
   * still mirrors accessToken/projectId/tierId locally (cache-hit reads) so the
   * 429 fallback chain and quota logic keep working.
   */
  async refreshAuth(): Promise<void> {
    this.cachedAuth = await credentials.getRequestAuth("antigravity", {
      model: this.modelName,
    });
    // Mirror local state for the fallback chain + quota (cache-hit reads).
    this.accessToken = await getValidAntigravityAccessToken();
    const { projectId, tierId } = await setupAntigravityUser(this.accessToken);
    this.projectId = projectId;
    this.tierId = tierId;
    this._displayName = getAntigravityTierDisplayName();
    // Discover the live served-model set (cache-hit after the first request) so
    // model-id resolution + the capacity fallback + the model-not-found hint all
    // reflect what THIS subscription actually serves today.
    const served = await getServedAntigravityModels(this.accessToken, this.projectId);
    this.servedModels = served.servedIds;
    this.defaultServedModel = served.defaultId;
    // Resolve the requested id to a served id against the live set (mirrors the
    // credential provider, which builds the primary envelope).
    this.servedModelName = resolveAntigravityModelId(
      this.modelName,
      this.servedModels,
      this.defaultServedModel,
      lookupFamilyDefaultVariant(this.modelName, "antigravity")
    );
    log(
      `[Antigravity] Auth refreshed, project: ${this.projectId}, tier: ${this._displayName}, ` +
        `model: ${this.modelName} -> ${this.servedModelName}, served: ${this.servedModels.join(",") || "(none)"}`
    );
  }

  /**
   * Wrap the standard Gemini payload in the CodeAssist envelope.
   *
   * Stores the envelope for potential fallback retries in enqueueRequest.
   */
  transformPayload(payload: any): any {
    // PRIMARY request: the CodeAssist envelope comes from the delegated auth
    // artifact (which maps the model id). Fall back to the local builder if
    // delegation hasn't run.
    const envelope = this.cachedAuth?.transformPayload
      ? this.cachedAuth.transformPayload(payload)
      : this.buildEnvelope(payload, this.servedModelName);
    this.lastEnvelope = envelope;
    return envelope;
  }

  /**
   * Build the CodeAssist envelope for a given (already-served) model name.
   */
  private buildEnvelope(innerPayload: any, model: string): any {
    const envelope: any = {
      model,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request: innerPayload,
    };
    // Paid tiers: enable Google One AI credits for capacity routing.
    if (this.tierId && this.tierId !== "free-tier") {
      envelope.enabled_credit_types = ["GOOGLE_ONE_AI"];
    }
    return envelope;
  }

  /**
   * Rate-limited request via GeminiRequestQueue singleton.
   *
   * 429 classification:
   * - RATE_LIMIT_EXCEEDED → retry with backoff (up to 3 attempts)
   * - MODEL_CAPACITY_EXHAUSTED → model fallback chain
   * - QUOTA_EXHAUSTED → terminal, return error (daily limit)
   * - Unknown 429 → retry with backoff
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const queue = GeminiRequestQueue.getInstance();

    let lastResponse: Response | null = null;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const response = attempt === 1 ? await queue.enqueue(fetchFn) : await queue.enqueue(fetchFn);

      if (response.status !== 429) {
        // A 404 usually means this model is not served by the tier we are on.
        // Only rewrite when the live served set CONFIRMS that.
        if (response.status === 404) {
          return this.rewriteModelNotFound(response);
        }
        return response;
      }

      const bodyText = await response.clone().text();
      const classification = classify429(bodyText);
      lastResponse = response;

      if (!classification) {
        log("[Antigravity] 429 response could not be classified, returning to caller");
        return response;
      }

      log(
        `[Antigravity] 429 classified: reason=${classification.reason}, terminal=${classification.terminal}, delay=${classification.retryDelayMs}ms`
      );

      if (classification.reason === "MODEL_CAPACITY_EXHAUSTED") {
        return this.handleCapacityExhausted(response, queue);
      }

      if (classification.terminal) {
        logStderr(
          `[Antigravity] Quota exhausted (${classification.reason || "daily limit"}). Check plan limits.`
        );
        return response;
      }

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = classification.retryDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
        logStderr(
          `[Antigravity] Rate limited (${classification.reason || "unknown"}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`
        );
        if (attempt === 1) {
          await this.logQuotaInfo();
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    logStderr(`[Antigravity] Rate limit persisted after ${MAX_RETRY_ATTEMPTS} retries`);
    return lastResponse!;
  }

  /**
   * Handle MODEL_CAPACITY_EXHAUSTED by trying the other LIVE-served models.
   *
   * Candidates come from `this.servedModels` (discovered in refreshAuth),
   * ordered by rank, excluding the model that just exhausted. A candidate that
   * 404s (briefly unserved mid-tier-roll) or rate-limits is skipped.
   */
  private async handleCapacityExhausted(
    originalResponse: Response,
    queue: GeminiRequestQueue
  ): Promise<Response> {
    const candidates = this.servedModels.filter((m) => m !== this.servedModelName);

    if (candidates.length === 0) {
      log(`[Antigravity] ${this.servedModelName} capacity exhausted, no fallback models available`);
      return originalResponse;
    }

    if (!this.lastEnvelope) {
      log(
        `[Antigravity] ${this.servedModelName} capacity exhausted but no stored envelope for retry`
      );
      return originalResponse;
    }

    log(`[Antigravity] Model ${this.servedModelName} capacity exhausted, starting fallback chain`);
    logStderr(
      `[Antigravity] ${this.servedModelName} capacity exhausted, trying fallback models...`
    );

    let lastResponse = originalResponse;
    const innerPayload = this.lastEnvelope.request;
    const endpoint = this.getEndpoint();
    const tried: string[] = [this.servedModelName];

    for (const fallbackModel of candidates) {
      log(`[Antigravity] Trying fallback model: ${fallbackModel}`);
      tried.push(fallbackModel);

      const fallbackEnvelope = this.buildEnvelope(innerPayload, fallbackModel);
      const headers = this.buildLocalHeaders();
      headers["Content-Type"] = "application/json";

      const fallbackResponse = await queue.enqueue(() =>
        fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(fallbackEnvelope),
        })
      );

      if (fallbackResponse.status === 200) {
        this._activeModelName = fallbackModel;
        logStderr(
          `[Antigravity] Using fallback model: ${fallbackModel} (${this.servedModelName} had no capacity)`
        );
        return fallbackResponse;
      }

      if (fallbackResponse.status === 404) {
        log(`[Antigravity] ${fallbackModel} returned 404, skipping to next fallback`);
        lastResponse = fallbackResponse;
        continue;
      }

      if (fallbackResponse.status === 429) {
        const fallbackBodyText = await fallbackResponse.clone().text();
        const classification = classify429(fallbackBodyText);
        if (classification?.reason === "MODEL_CAPACITY_EXHAUSTED") {
          log(`[Antigravity] ${fallbackModel} also capacity exhausted, trying next...`);
          lastResponse = fallbackResponse;
          continue;
        }
        return fallbackResponse;
      }

      return fallbackResponse;
    }

    log("[Antigravity] All fallback models exhausted");
    logStderr(`[Antigravity] All models capacity exhausted (tried: ${tried.join(" -> ")})`);
    if (lastResponse.status === 404) {
      return this.rewriteModelNotFound(lastResponse, true);
    }
    return lastResponse;
  }

  /**
   * Rewrite a 404 into an actionable error naming what this tier actually
   * serves and how to reach the model anyway. Status stays 404 (terminal), so
   * composed-handler remaps it to a 400 surfaced verbatim.
   *
   * Returns the response UNTOUCHED when the live served set contains the model.
   */
  private rewriteModelNotFound(response: Response, capacityFallbacksExhausted = false): Response {
    // The served set is the LIVE fetchAvailableModels result — no hardcoded seed.
    const served = this.servedModels;

    if (!capacityFallbacksExhausted && served.includes(this.servedModelName)) {
      log(
        `[Antigravity] 404 for ${this.servedModelName}, which IS in the served set — passing through unmodified`
      );
      return response;
    }

    // Drain the original so the connection body isn't left hanging.
    response.text().catch(() => {});
    // Only name the served set when we actually have one (the live fetch may
    // have failed); otherwise stay honest about not knowing.
    const servesClause =
      served.length > 0 ? `That tier currently serves: ${served.join(", ")}. ` : "";
    const tier = this._displayName || "Antigravity";
    const reason = capacityFallbacksExhausted
      ? `${this.modelName} could not be served after every Antigravity capacity fallback failed (${tier}, via ag@). ` +
        servesClause
      : `${this.modelName} is not served by your Antigravity tier (${tier}, via ag@). ` +
        servesClause;
    const message =
      reason +
      `To use ${this.modelName}, go through the direct Gemini API instead — ` +
      "set GEMINI_API_KEY (get one at https://aistudio.google.com/app/apikey) and run " +
      `google@${this.modelName}.`;
    const list = served.join(", ");
    const body = JSON.stringify({
      error: { code: 404, status: "NOT_FOUND", message },
    });
    if (capacityFallbacksExhausted) {
      logStderr(
        `[Antigravity] ${this.modelName} capacity fallbacks exhausted (404). Reported models: ${list}`
      );
    } else {
      logStderr(`[Antigravity] ${this.modelName} not served by ${tier} (404). Serves: ${list}`);
    }
    return new Response(body, {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Fetch and display per-model quota info from the Code Assist API.
   * Called on first rate limit so the user can see their actual usage.
   */
  private async logQuotaInfo(): Promise<void> {
    if (!this.accessToken || !this.projectId) return;
    try {
      const data = await retrieveUserQuota(this.accessToken, this.projectId);
      if (!data?.buckets?.length) return;

      const lines: string[] = [];
      for (const bucket of data.buckets) {
        if (!bucket.modelId) continue;
        const pct =
          typeof bucket.remainingFraction === "number"
            ? `${(bucket.remainingFraction * 100).toFixed(1)}%`
            : "?";
        const reset = bucket.resetTime
          ? new Date(bucket.resetTime).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "?";
        lines.push(`  ${bucket.modelId}: ${pct} remaining (resets ${reset})`);
      }
      if (lines.length > 0) {
        logStderr(`[Antigravity] Quota status:\n${lines.join("\n")}`);
      }
    } catch {
      // Non-fatal: quota check is informational only
    }
  }

  /**
   * Get quota remaining for a specific model from the Code Assist API.
   */
  async getQuotaRemaining(modelName: string): Promise<number | undefined> {
    if (!this.accessToken || !this.projectId) return undefined;
    try {
      const data = await retrieveUserQuota(this.accessToken, this.projectId);
      if (!data?.buckets?.length) return undefined;
      const bucket = data.buckets.find((b: any) => b.modelId === modelName);
      return typeof bucket?.remainingFraction === "number" ? bucket.remainingFraction : undefined;
    } catch {
      return undefined;
    }
  }
}
