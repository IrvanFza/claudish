/**
 * GeminiCodeAssistProvider — Gemini Code Assist (gemini-cli backend) via OAuth.
 *
 * Transport concerns:
 * - OAuth access token via getValidAccessToken()
 * - Project ID via setupGeminiUser()
 * - Fixed endpoint: cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 * - Wraps payload in CodeAssist envelope: {model, project, user_prompt_id, request: <payload>}
 * - GeminiRequestQueue for rate limiting
 * - 429 classification: RATE_LIMIT_EXCEEDED (retry), MODEL_CAPACITY_EXHAUSTED (model fallback), QUOTA_EXHAUSTED (terminal)
 * - gemini-sse stream format (with response wrapper)
 */

import { randomUUID } from "node:crypto";
import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import {
  CODE_ASSIST_FALLBACK_CHAIN,
  buildCodeAssistUserAgent,
  getGeminiTierDisplayName,
  getServedCodeAssistModels,
  getValidAccessToken,
  retrieveUserQuota,
  setupGeminiUser,
} from "../../auth/gemini-oauth.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import { log, logStderr } from "../../logger.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_ENDPOINT = `${CODE_ASSIST_BASE}/v1internal:streamGenerateContent?alt=sse`;

/** Max retry attempts for retryable 429s (RATE_LIMIT_EXCEEDED) */
const MAX_RETRY_ATTEMPTS = 3;
/** Default retry delay when server doesn't specify one (matches opencode-gemini-auth) */
const DEFAULT_RATE_LIMIT_DELAY_MS = 10_000;

/** Generate a short random request ID (matches gemini-cli activity logger) */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

/** Classification of 429 responses from Code Assist API */
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
 * Mirrors gemini-cli / opencode-gemini-auth behavior:
 * - RATE_LIMIT_EXCEEDED → retryable (short-window per-minute limit)
 * - QUOTA_EXHAUSTED → terminal (daily limit hit)
 * - MODEL_CAPACITY_EXHAUSTED → terminal (triggers model fallback instead)
 */
function classify429(responseBody: string): QuotaClassification | null {
  try {
    const raw = JSON.parse(responseBody);
    // Handle both {error: {details: [...]}} and [{error: {details: [...]}}] formats
    const error = Array.isArray(raw) ? raw[0]?.error : raw?.error;
    const details = Array.isArray(error?.details) ? error.details : [];

    // Extract RetryInfo delay hint
    const retryInfo = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    );
    let retryDelayMs = parseRetryDelay(retryInfo?.retryDelay);

    // Also try extracting from error message: "Please retry in 2.5s"
    if (retryDelayMs === undefined && typeof error?.message === "string") {
      const match = error.message.match(/retry in ([\d.]+)(ms|s)/i);
      if (match) {
        const val = Number.parseFloat(match[1]);
        retryDelayMs = match[2] === "ms" ? Math.round(val) : Math.round(val * 1000);
      }
    }

    // Extract ErrorInfo reason
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
      // Terminal for retry purposes — model fallback handles this separately
      return { terminal: true, retryDelayMs, reason };
    }

    // Check QuotaFailure violations for daily vs per-minute hints
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

    // Unknown 429 — default to retryable
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

export class GeminiCodeAssistProviderTransport implements ProviderTransport {
  readonly name = "gemini-codeassist";
  private _displayName = "GeminiCA";
  get displayName(): string {
    return this._displayName;
  }
  readonly streamFormat: StreamFormat = "gemini-sse";

  private modelName: string;
  private accessToken: string | null = null;
  private projectId: string | null = null;
  private tierId: string | null = null;

  /**
   * The delegated per-request auth artifact (headers + CodeAssist-envelope
   * transform) from the credential authority, populated by refreshAuth(). The
   * PRIMARY request's headers + envelope come from here. The local
   * accessToken/projectId/tierId above are kept in lockstep (from the same
   * module-cached oauth leaf functions) purely for the 429 fallback chain and
   * quota logic, which are request-routing concerns, not auth.
   */
  private cachedAuth: RequestAuth | null = null;

  /** The last envelope built by transformPayload, stored for fallback retries */
  private lastEnvelope: any = null;

  /** Set when a fallback model is used instead of the requested one */
  private _activeModelName: string | undefined;

  /**
   * Models this account's Code Assist tier currently serves, discovered LIVE in
   * refreshAuth() via getServedCodeAssistModels() (read from retrieveUserQuota
   * buckets). The set varies by tier AND changes over time, so it cannot be
   * hardcoded.
   * Used for the capacity-fallback chain and the model-not-found hint. Empty
   * until refreshAuth() has run (composed-handler awaits refreshAuth before any
   * request, so it is always populated by the time enqueueRequest needs it).
   */
  private servedModels: string[] = [];

  constructor(modelName: string) {
    this.modelName = modelName;
    // Fallback candidates are resolved live in refreshAuth(); nothing to compute
    // synchronously here.
  }

  getActiveModelName(): string | undefined {
    return this._activeModelName;
  }

  getEndpoint(): string {
    return CODE_ASSIST_ENDPOINT;
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
   * Build the Gemini Code Assist headers from local OAuth state. Used by the
   * 429 fallback chain (handleCapacityExhausted), which needs a fresh
   * x-activity-request-id per attempt. The PRIMARY request uses the delegated
   * artifact's headers instead (see getHeaders()).
   */
  private buildLocalHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": buildCodeAssistUserAgent(this.modelName),
      "x-activity-request-id": createActivityRequestId(),
    };
  }

  /**
   * Refresh auth before each request. The transport no longer manages OAuth
   * itself — it delegates the request artifact (headers + CodeAssist envelope)
   * to the credential authority. It still mirrors accessToken/projectId/tierId
   * locally (from the module-cached oauth leaf functions — a cache hit, no extra
   * network round-trip) so the 429 fallback chain and quota logic keep working.
   */
  async refreshAuth(): Promise<void> {
    this.cachedAuth = await credentials.getRequestAuth("gemini-codeassist", {
      model: this.modelName,
    });
    // Mirror local state for the fallback chain + quota (cache-hit reads).
    this.accessToken = await getValidAccessToken();
    const { projectId, tierId } = await setupGeminiUser(this.accessToken);
    this.projectId = projectId;
    this.tierId = tierId;
    this._displayName = getGeminiTierDisplayName();
    // Discover the live served-model set (cache-hit after the first request) so
    // the capacity fallback + model-not-found hint reflect what this account's
    // tier actually serves today, not a hardcoded roster that drifts.
    this.servedModels = await getServedCodeAssistModels(this.accessToken, this.projectId);
    log(
      `[GeminiCodeAssist] Auth refreshed, project: ${this.projectId}, tier: ${this._displayName}, served: ${this.servedModels.join(",") || "(none)"}`
    );
  }

  /**
   * Wrap the standard Gemini payload in the CodeAssist envelope.
   * The inner payload (contents, generationConfig, systemInstruction, tools)
   * is built by GeminiAdapter.buildPayload().
   *
   * Stores the envelope for potential fallback retries in enqueueRequest.
   */
  transformPayload(payload: any): any {
    // PRIMARY request: the CodeAssist envelope comes from the delegated auth
    // artifact. Fall back to the local builder if delegation hasn't run.
    const envelope = this.cachedAuth?.transformPayload
      ? this.cachedAuth.transformPayload(payload)
      : this.buildEnvelope(payload, this.modelName);
    // Store for capacity-fallback retries, which rebuild envelopes for other
    // models via buildEnvelope (using the local projectId/tierId).
    this.lastEnvelope = envelope;
    return envelope;
  }

  /**
   * Build the CodeAssist envelope for a given model name.
   */
  private buildEnvelope(innerPayload: any, model: string): any {
    const envelope: any = {
      model,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request: innerPayload,
    };
    // Paid tiers: enable Google One AI credits for capacity routing (matches gemini-cli)
    if (this.tierId && this.tierId !== "free-tier") {
      envelope.enabled_credit_types = ["GOOGLE_ONE_AI"];
    }
    return envelope;
  }

  /**
   * Rate-limited request via GeminiRequestQueue singleton.
   *
   * 429 classification (matches gemini-cli / opencode-gemini-auth):
   * - RATE_LIMIT_EXCEEDED → retry with backoff (up to 3 attempts)
   * - MODEL_CAPACITY_EXHAUSTED → model fallback chain
   * - QUOTA_EXHAUSTED → terminal, return error (daily limit)
   * - Unknown 429 → retry with backoff
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const queue = GeminiRequestQueue.getInstance();

    // Retry loop for RATE_LIMIT_EXCEEDED (transient per-minute limits)
    let lastResponse: Response | null = null;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const response = attempt === 1 ? await queue.enqueue(fetchFn) : await queue.enqueue(fetchFn);

      if (response.status !== 429) {
        // A 404 usually means this model is not served by the tier we are on.
        // Only rewrite when the live served set CONFIRMS that — otherwise a
        // served model that 404s transiently would be reported as permanently
        // unavailable, sending the user to fix the wrong thing.
        if (response.status === 404) {
          return this.rewriteModelNotFound(response);
        }
        return response;
      }

      const bodyText = await response.clone().text();
      const classification = classify429(bodyText);
      lastResponse = response;

      if (!classification) {
        // Can't parse — return as-is
        log("[GeminiCodeAssist] 429 response could not be classified, returning to caller");
        return response;
      }

      log(
        `[GeminiCodeAssist] 429 classified: reason=${classification.reason}, terminal=${classification.terminal}, delay=${classification.retryDelayMs}ms`
      );

      // MODEL_CAPACITY_EXHAUSTED → model fallback chain (below)
      if (classification.reason === "MODEL_CAPACITY_EXHAUSTED") {
        return this.handleCapacityExhausted(response, queue);
      }

      // QUOTA_EXHAUSTED → terminal, daily limit
      if (classification.terminal) {
        logStderr(
          `[GeminiCodeAssist] Quota exhausted (${classification.reason || "daily limit"}). Check plan limits.`
        );
        return response;
      }

      // RATE_LIMIT_EXCEEDED or unknown retryable → retry with backoff
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = classification.retryDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
        logStderr(
          `[GeminiCodeAssist] Rate limited (${classification.reason || "unknown"}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`
        );
        // On first rate limit, fetch and display quota info
        if (attempt === 1) {
          await this.logQuotaInfo();
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // All retry attempts exhausted
    logStderr(`[GeminiCodeAssist] Rate limit persisted after ${MAX_RETRY_ATTEMPTS} retries`);
    return lastResponse!;
  }

  /**
   * Handle MODEL_CAPACITY_EXHAUSTED by trying the other LIVE-served models.
   *
   * Candidates come from `this.servedModels` (discovered from retrieveUserQuota
   * buckets in refreshAuth), ordered by rankCodeAssistModel, excluding the model
   * that just exhausted. A candidate that 404s (briefly unserved mid-tier-roll)
   * or rate-limits is skipped and the next is tried — previously a 404 on a
   * hardcoded-chain candidate was returned immediately, surfacing a raw 404.
   */
  private async handleCapacityExhausted(
    originalResponse: Response,
    queue: GeminiRequestQueue
  ): Promise<Response> {
    const candidates = this.servedModels.filter((m) => m !== this.modelName);

    if (candidates.length === 0) {
      log(`[GeminiCodeAssist] ${this.modelName} capacity exhausted, no fallback models available`);
      return originalResponse;
    }

    if (!this.lastEnvelope) {
      log(
        `[GeminiCodeAssist] ${this.modelName} capacity exhausted but no stored envelope for retry`
      );
      return originalResponse;
    }

    log(`[GeminiCodeAssist] Model ${this.modelName} capacity exhausted, starting fallback chain`);
    logStderr(`[GeminiCodeAssist] ${this.modelName} capacity exhausted, trying fallback models...`);

    let lastResponse = originalResponse;
    const innerPayload = this.lastEnvelope.request;
    const endpoint = this.getEndpoint();
    const tried: string[] = [this.modelName];

    for (const fallbackModel of candidates) {
      log(`[GeminiCodeAssist] Trying fallback model: ${fallbackModel}`);
      tried.push(fallbackModel);

      const fallbackEnvelope = this.buildEnvelope(innerPayload, fallbackModel);
      // Fallback attempts mint fresh headers (new x-activity-request-id) from
      // local OAuth state — not the cached primary artifact.
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
          `[GeminiCodeAssist] Using fallback model: ${fallbackModel} (${this.modelName} had no capacity)`
        );
        return fallbackResponse;
      }

      if (fallbackResponse.status === 404) {
        // Briefly unserved (tier roll) — skip to the next candidate, don't surface.
        log(`[GeminiCodeAssist] ${fallbackModel} returned 404, skipping to next fallback`);
        lastResponse = fallbackResponse;
        continue;
      }

      if (fallbackResponse.status === 429) {
        const fallbackBodyText = await fallbackResponse.clone().text();
        const classification = classify429(fallbackBodyText);
        if (classification?.reason === "MODEL_CAPACITY_EXHAUSTED") {
          log(`[GeminiCodeAssist] ${fallbackModel} also capacity exhausted, trying next...`);
          lastResponse = fallbackResponse;
          continue;
        }
        // Other 429 (rate limit) — return as-is; outer loop retries on next request.
        return fallbackResponse;
      }

      // Any other status — surface it rather than mask with another attempt.
      return fallbackResponse;
    }

    log("[GeminiCodeAssist] All fallback models exhausted");
    logStderr(`[GeminiCodeAssist] All models capacity exhausted (tried: ${tried.join(" -> ")})`);
    // If every candidate 404'd, the last response is a raw "entity not found".
    // Route it through the same rewrite the primary path uses so the surface is
    // consistent no matter which attempt produced the final 404.
    if (lastResponse.status === 404) {
      return this.rewriteModelNotFound(lastResponse, true);
    }
    return lastResponse;
  }

  /**
   * Rewrite a 404 into an actionable error naming what this tier actually
   * serves and how to reach the model anyway. Status stays 404 (terminal), so
   * composed-handler remaps it to a 400 surfaced verbatim — the user sees the
   * guidance instead of a bare "Requested entity was not found."
   *
   * Returns the response UNTOUCHED when the live served set contains the model:
   * that 404 is not an entitlement problem, and claiming otherwise would send
   * the user off to fix a subscription that is working fine.
   */
  private rewriteModelNotFound(response: Response, capacityFallbacksExhausted = false): Response {
    const served =
      this.servedModels.length > 0 ? this.servedModels : CODE_ASSIST_FALLBACK_CHAIN.slice();

    if (!capacityFallbacksExhausted && served.includes(this.modelName)) {
      log(
        `[GeminiCodeAssist] 404 for ${this.modelName}, which IS in the served set — passing through unmodified`
      );
      return response;
    }

    // Drain the original so the connection body isn't left hanging.
    response.text().catch(() => {});
    const list = served.join(", ");
    const tier = this._displayName || "Gemini Code Assist";
    const reason = capacityFallbacksExhausted
      ? `${this.modelName} could not be served after every Gemini Code Assist capacity fallback failed (${tier}, via go@). ` +
        `That tier currently reports: ${list}. `
      : `${this.modelName} is not served by your Gemini Code Assist tier (${tier}, via go@). ` +
        `That tier currently serves: ${list}. `;
    const message =
      reason +
      `To use ${this.modelName}, go through the direct Gemini API instead — ` +
      "set GEMINI_API_KEY (get one at https://aistudio.google.com/app/apikey) and run " +
      `google@${this.modelName}.`;
    const body = JSON.stringify({
      error: { code: 404, status: "NOT_FOUND", message },
    });
    if (capacityFallbacksExhausted) {
      logStderr(
        `[GeminiCodeAssist] ${this.modelName} capacity fallbacks exhausted (404). Reported models: ${list}`
      );
    } else {
      logStderr(
        `[GeminiCodeAssist] ${this.modelName} not served by ${tier} (404). Serves: ${list}`
      );
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
        logStderr(`[GeminiCodeAssist] Quota status:\n${lines.join("\n")}`);
      }
    } catch {
      // Non-fatal: quota check is informational only
    }
  }

  /**
   * Get quota remaining for a specific model from Code Assist API.
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

// Backward-compatible alias
/** @deprecated Use GeminiCodeAssistProviderTransport */
export { GeminiCodeAssistProviderTransport as GeminiCodeAssistProvider };
