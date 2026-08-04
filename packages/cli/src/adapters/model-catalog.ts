/**
 * Model metadata catalog — Firebase slim cache is the sole source of truth.
 *
 * All model facts (contextWindow, supportsVision) come from the slim catalog
 * at ~/.claudish/all-models.json, populated at proxy startup by the OpenRouter
 * catalog resolver.
 *
 * Adapter-specific behavior (temperature ranges, tool name limits, max tool
 * counts) lives in the dialect/format classes themselves — those are CLI
 * constraints, not model metadata.
 */

import {
  readAllModelsCache,
  type ReasoningCapability,
  type SlimModelEntry,
} from "../providers/all-models-cache.js";

export type { ReasoningCapability, ReasoningControl } from "../providers/all-models-cache.js";

export interface ModelEntry {
  /** Model ID as stored in the slim catalog (not lowercased) */
  modelId: string;
  /** Context window in tokens */
  contextWindow: number;
  /** Whether model supports vision/image input (may be undefined if Firebase didn't specify) */
  supportsVision?: boolean;
  /**
   * Curated release date (ISO `YYYY-MM-DD`), when Firebase has one. The
   * authoritative freshness signal — pickers prefer it over any date a provider
   * endpoint reports, which is a roster-added timestamp, not a release.
   */
  releaseDate?: string;
}

/**
 * Look up model metadata from the Firebase slim catalog cache.
 *
 * Accepts:
 *   - Bare model IDs ("glm-5", "minimax-m2.7")
 *   - Vendor-prefixed IDs ("x-ai/grok-4")
 *
 * Throws if `modelId` contains "@" — callers must strip the provider prefix
 * before calling (contract enforcement).
 *
 * Returns undefined when:
 *   - The cache file doesn't exist (cold start)
 *   - modelId isn't in the cache
 *   - The entry exists but has no `contextWindow`
 *
 * @param cachePath Override cache path. Defaults to `~/.claudish/all-models.json`.
 *                  Only tests should pass this.
 */
export function lookupModel(modelId: string, cachePath?: string): ModelEntry | undefined {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry || entry.contextWindow === undefined) return undefined;
  return {
    modelId: entry.modelId,
    contextWindow: entry.contextWindow,
    supportsVision: entry.supportsVision,
    releaseDate: entry.releaseDate,
  };
}

/**
 * Reasoning capability for a model, straight from the slim catalog.
 *
 * Separate from {@link lookupModel} on purpose: that one gates on
 * `contextWindow` being present (its callers want a window), whereas reasoning
 * metadata is useful on its own — a model can carry `reasoning` with no window.
 *
 * Returns undefined for a cold cache or an unknown model. Callers MUST treat
 * that as "no information" and keep their existing behaviour; it is never an
 * error, and it must never block a request.
 */
export function lookupModelReasoning(
  modelId: string,
  cachePath?: string
): ReasoningCapability | undefined {
  return findCacheEntry(modelId, cachePath)?.reasoning;
}

/**
 * Provider-aware context window lookup.
 *
 * The same model id can enforce DIFFERENT windows on different serving backends
 * (e.g. gpt-5.6-sol = 1.05M on the OpenAI API but ~372K on the ChatGPT Codex
 * OAuth backend). The slim catalog carries the per-provider window on each
 * `aggregators[]` entry; this returns the window for `provider` if present,
 * else the model's top-level `contextWindow`.
 *
 * @param provider The resolved CLI provider name (e.g. "openai-codex").
 * @returns The provider-specific window, the top-level window, or undefined if
 *          the model isn't in the catalog at all.
 */
export function lookupModelForProvider(
  modelId: string,
  provider: string,
  cachePath?: string
): number | undefined {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry) return undefined;
  return (
    entry.aggregators?.find((a) => a.provider === provider)?.contextWindow ?? entry.contextWindow
  );
}

/**
 * Whether a subscription endpoint can serve a model, and under which wire id.
 *
 * - `serves`     — the plan includes this model; send `externalId` (the wire id
 *                  the endpoint accepts, e.g. `k3` for catalog `kimi-k3`).
 * - `not-served` — the provider IS a subscription plan, but this model isn't in
 *                  it. Routing should DROP the candidate: sending the model
 *                  anyway is a guaranteed rejection, and silently substituting a
 *                  different model gives the user something they didn't ask for.
 * - `unknown`    — not a subscription plan, or the model isn't in the catalog.
 *                  Caller keeps its existing behaviour.
 */
export type SubscriptionRouting =
  | { kind: "serves"; externalId: string }
  | { kind: "not-served" }
  | { kind: "unknown" };

/**
 * Resolve how a subscription provider should route a model, from catalog data
 * alone (`subscriptionPlans[]` + `aggregators[].externalId`).
 *
 * Nothing about which models a plan includes is hardcoded — that is exactly the
 * data that goes stale. Kimi Code shipping K3 while the CLI pinned
 * `kimi-for-coding` is the worked example.
 */
export function resolveSubscriptionRouting(
  modelId: string,
  provider: string,
  cachePath?: string
): SubscriptionRouting {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry) return { kind: "unknown" };

  if (entry.subscriptionPlans?.includes(provider)) {
    const agg = entry.aggregators?.find((a) => a.provider === provider);
    // A plan membership without an aggregator entry has no wire id to send;
    // treat it as unknown rather than inventing one.
    return agg?.externalId ? { kind: "serves", externalId: agg.externalId } : { kind: "unknown" };
  }

  // The model doesn't list this plan. Only call that "not served" once we've
  // confirmed the provider really is a subscription plan somewhere in the
  // catalog — otherwise a provider with no plan data would lose every route.
  return isSubscriptionPlan(provider, cachePath) ? { kind: "not-served" } : { kind: "unknown" };
}

/** True if any catalog entry lists `provider` as a subscription plan. */
function isSubscriptionPlan(provider: string, cachePath?: string): boolean {
  const cache = readAllModelsCache(cachePath);
  if (!cache) return false;
  return cache.entries.some((e) => e.subscriptionPlans?.includes(provider));
}

/**
 * Find the slim catalog entry for a model id (bare or vendor-prefixed), matching
 * on modelId or aliases. Shared by lookupModel / lookupModelForProvider.
 * Throws if `modelId` contains "@" — callers must strip the provider prefix.
 */
function findCacheEntry(modelId: string, cachePath?: string): SlimModelEntry | undefined {
  if (modelId.includes("@")) {
    throw new Error(
      `model-catalog lookup received provider-routed ID "${modelId}" — callers must strip the "@" prefix before calling`
    );
  }

  const cache = readAllModelsCache(cachePath);
  if (!cache || cache.entries.length === 0) return undefined;

  const lower = modelId.toLowerCase();
  // Vendor-prefixed IDs like "x-ai/grok-beta" — match on segment after "/"
  const unprefixed = lower.includes("/") ? lower.substring(lower.lastIndexOf("/") + 1) : lower;

  for (const entry of cache.entries) {
    const entryId = entry.modelId.toLowerCase();

    const exactMatch = entryId === unprefixed || entryId === lower;
    const aliasMatch = entry.aliases?.some(
      (a) => a.toLowerCase() === unprefixed || a.toLowerCase() === lower
    );

    if (exactMatch || aliasMatch) {
      return entry;
    }
  }

  return undefined;
}

/** Default context window when no catalog match (0 = unknown, shows N/A in status line) */
export const DEFAULT_CONTEXT_WINDOW = 0;

/** Default vision support when no catalog match */
export const DEFAULT_SUPPORTS_VISION = true;
