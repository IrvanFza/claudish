/**
 * Dynamic pricing cache service
 *
 * Loads model pricing from the on-disk cache populated by prior sessions
 * and falls back to simple per-provider defaults when the cache is unavailable.
 *
 * Pricing data is considered an estimate (isEstimate: true). Fresh pricing
 * now flows through Firebase `ModelDoc.pricing` on a per-model basis —
 * there is no bulk pricing endpoint, so we no longer try to pre-populate
 * from the OpenRouter catalog.
 *
 * Architecture:
 *   getModelPricing() → in-memory map → disk cache → provider defaults
 *   warmPricingCache() → background: disk cache (no network fetch)
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import {
  registerDynamicPricingLookup,
  type ModelPricing,
} from "../handlers/shared/remote-provider-types.js";

// In-memory pricing map: OpenRouter model ID → pricing
const pricingMap = new Map<string, ModelPricing>();

// Disk cache path and TTL
const CACHE_DIR = join(homedir(), ".claudish");
const CACHE_FILE = join(CACHE_DIR, "pricing-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Whether the cache has been warmed (to avoid repeated warm attempts)
let cacheWarmed = false;

/**
 * Map from claudish provider names to OpenRouter model ID prefixes.
 * OpenRouter IDs look like "openai/gpt-5", "google/gemini-2.5-pro", etc.
 */
const PROVIDER_TO_OR_PREFIX: Record<string, string[]> = {
  openai: ["openai/"],
  oai: ["openai/"],
  gemini: ["google/"],
  google: ["google/"],
  minimax: ["minimax/"],
  mm: ["minimax/"],
  kimi: ["moonshotai/"],
  moonshot: ["moonshotai/"],
  glm: ["zhipu/"],
  zhipu: ["zhipu/"],
  ollamacloud: ["ollamacloud/", "meta-llama/", "qwen/", "deepseek/"],
  oc: ["ollamacloud/", "meta-llama/", "qwen/", "deepseek/"],
};

/**
 * Synchronous lookup of dynamic pricing for a provider + model.
 * Returns undefined if no dynamic pricing is available (caller should fall back).
 */
export function getDynamicPricingSync(
  provider: string,
  modelName: string
): ModelPricing | undefined {
  // For OpenRouter, the model name IS the full OpenRouter ID (e.g., "openai/gpt-5")
  if (provider === "openrouter") {
    const direct = pricingMap.get(modelName);
    if (direct) return direct;
    // Try prefix match
    for (const [key, pricing] of pricingMap) {
      if (modelName.startsWith(key)) return pricing;
    }
    return undefined;
  }

  const prefixes = PROVIDER_TO_OR_PREFIX[provider.toLowerCase()];
  if (!prefixes) return undefined;

  // Try exact match with each prefix
  for (const prefix of prefixes) {
    const orId = `${prefix}${modelName}`;
    const pricing = pricingMap.get(orId);
    if (pricing) return pricing;
  }

  // Try prefix match (e.g., "gpt-4o-2024-08-06" matches "openai/gpt-4o")
  for (const prefix of prefixes) {
    for (const [key, pricing] of pricingMap) {
      if (!key.startsWith(prefix)) continue;
      const orModelName = key.slice(prefix.length);
      if (modelName.startsWith(orModelName)) return pricing;
    }
  }

  return undefined;
}

/**
 * Warm the pricing cache by loading disk cache into memory.
 * Does NOT do any network fetches — the OpenRouter bulk catalog path was
 * removed when claudish switched to Firebase for model information.
 *
 * Call this at startup (fire-and-forget). Non-blocking.
 */
export async function warmPricingCache(): Promise<void> {
  if (cacheWarmed) return;
  cacheWarmed = true;

  // Register lookup function so getModelPricing() can use dynamic pricing
  registerDynamicPricingLookup(getDynamicPricingSync);

  try {
    const diskFresh = loadDiskCache();
    if (diskFresh) {
      log("[PricingCache] Loaded pricing from disk cache");
    } else {
      // Stale or missing — use provider defaults until a future version
      // repopulates per-model via Firebase `ModelDoc.pricing`.
      log("[PricingCache] Disk cache stale or missing, using provider defaults");
    }
  } catch (error) {
    log(`[PricingCache] Error warming cache: ${error}`);
  }
}

/**
 * Load disk cache into memory. Returns true if cache is fresh (within TTL).
 */
function loadDiskCache(): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return false;

    const stat = statSync(CACHE_FILE);
    const age = Date.now() - stat.mtimeMs;
    const isFresh = age < CACHE_TTL_MS;

    const raw = readFileSync(CACHE_FILE, "utf-8");
    const data: Record<string, ModelPricing> = JSON.parse(raw);

    // Populate in-memory map
    for (const [key, pricing] of Object.entries(data)) {
      pricingMap.set(key, pricing);
    }

    return isFresh;
  } catch {
    // Cache corruption or read error — treat as miss
    return false;
  }
}

// NOTE: The previous OpenRouter bulk-catalog fetchers (`saveDiskCache`,
// `populateFromOpenRouterModels`) were removed when claudish moved to
// Firebase for model information. The pricing cache is now read-only
// for existing disk caches and relies on provider-default fallbacks
// for missing entries. A future version can repopulate the map per-model
// from `ModelDoc.pricing` via `getModelByIdFromFirebase()`.
