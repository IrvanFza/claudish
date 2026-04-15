import { Timestamp } from "firebase-admin/firestore";
import type {
  RawModel, ModelDoc, CollectorResult, PricingData, CapabilityFlags, FieldSource,
  AggregatorEntry,
} from "./schema.js";
import { CONFIDENCE_RANK } from "./schema.js";
import { canonicalizeModelId } from "./schema-runtime.js";

/**
 * Mapping from collectorId (used as the key in `sources`) to the canonical CLI
 * provider name used by `aggregators[]` and the routing layer.
 *
 * Only collectors that represent ROUTABLE aggregators are listed. Pricing scrapers
 * and other non-routable collectors are intentionally absent — they contribute to
 * `sources` (for provenance) but not to `aggregators` (which is a CLI routing index).
 *
 * To add a new aggregator: add the collectorId here AND add a provider entry to the
 * CLI's BUILTIN_PROVIDERS array (with matching `name`).
 */
export const COLLECTOR_TO_PROVIDER: Record<string, string> = {
  "openrouter-api": "openrouter",
  "openai-api": "openai",
  "anthropic-api": "anthropic",
  "google-api": "google",
  "xai-api": "xai",
  "mistral-api": "mistral",
  "moonshot-api": "moonshot",
  "deepseek-api": "deepseek",
  "dashscope-api": "qwen",
  "zhipu-api": "glm",
  "fireworks-api": "fireworks",
  "together-ai-api": "together-ai",
  "opencode-zen-api": "opencode-zen",
};

// Sanity bounds for pricing (USD per million tokens)
// min: 0 allows free-tier models (Gemini Flash free, GLM-4-Flash, etc.)
// Negative values (e.g. -1000000 from bad scrapes) are still rejected
const PRICING_BOUNDS = {
  input: { min: 0, max: 1000 },
  output: { min: 0, max: 2000 },
};

// Sanity bounds for context window
const CONTEXT_BOUNDS = { min: 1000, max: 10_000_000 };

export function mergeResults(results: CollectorResult[]): ModelDoc[] {
  // Step 1: Flatten all raw models
  const allRaw: RawModel[] = results.flatMap(r => r.models);

  // Step 2: Group by canonical ID.
  // Collectors that went through the schema gate already have canonicalId set
  // to the clean form. Legacy/untrusted callers may pass through here too,
  // so we defensively re-canonicalize.
  const byId = new Map<string, RawModel[]>();
  for (const raw of allRaw) {
    const key = canonicalizeModelId(raw.canonicalId ?? raw.externalId);
    const existing = byId.get(key) ?? [];
    existing.push(raw);
    byId.set(key, existing);
  }

  // Step 3: Merge each group (modelId = clean canonical key)
  const docs: ModelDoc[] = [];
  for (const [canonicalId, raws] of byId) {
    docs.push(mergeGroup(canonicalId, raws));
  }

  // Step 4: Deduplicate — if both "model" and "model:free" existed, they merged
  // into the same key. But if only "model:free" existed (no paid version), the
  // normalizeCanonicalKey already stripped ":free" from the key, so the stored
  // modelId is already clean.

  return docs;
}

function mergeGroup(modelId: string, raws: RawModel[]): ModelDoc {
  // Sort by confidence desc (highest confidence first)
  const sorted = [...raws].sort((a, b) => {
    return CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  });

  const now = Timestamp.now();

  // Pick best value for each field with source provenance
  const pricingResult = pickBestWithSource(sorted, r => r.pricing);
  const contextResult = pickBestWithSource(sorted, r => r.contextWindow);
  const outputResult = pickBestWithSource(sorted, r => r.maxOutputTokens);
  const displayResult = pickBestWithSource(sorted, r => r.displayName);
  const descResult = pickBestWithSource(sorted, r => r.description);
  const statusResult = pickBestWithSource(sorted, r => r.status);

  // Validate and sanitize pricing
  const pricing = pricingResult ? sanitizePricing(pricingResult.value) : undefined;

  // Validate context window
  const rawContext = contextResult?.value;
  const contextWindow =
    rawContext !== undefined && rawContext >= CONTEXT_BOUNDS.min && rawContext <= CONTEXT_BOUNDS.max
      ? rawContext
      : undefined;

  if (rawContext !== undefined && contextWindow === undefined) {
    console.warn(`[merger] context window out of bounds for ${modelId}: ${rawContext}`);
  }

  // releaseDate: pick the earliest non-null date string, track which raw had it
  const allDates = raws
    .filter((r): r is RawModel & { releaseDate: string } => !!r.releaseDate)
    .sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : 1));
  const releaseDate = allDates.length > 0 ? allDates[0].releaseDate : undefined;
  const releaseDateSource = releaseDate
    ? makeFieldSource(allDates[0])
    : undefined;

  // For capabilities: highest-confidence source that provides any capabilities
  const capsSource = sorted.find(r => r.capabilities && Object.keys(r.capabilities).length > 0);

  // Pre-compute sources + aggregators together so the doc builder stays a pure literal.
  const sourcesMap = buildSourcesMap(raws);
  const aggregatorsList = buildAggregatorsList(sourcesMap);

  const doc: ModelDoc = {
    modelId,
    displayName: displayResult?.value ?? modelId,
    provider: pickProvider(raws) ?? "unknown",
    ...(descResult?.value !== undefined ? { description: descResult.value } : {}),
    ...(releaseDate !== undefined ? { releaseDate } : {}),
    pricing: pricing ?? undefined,
    contextWindow,
    maxOutputTokens: outputResult?.value,
    capabilities: mergeCapabilities(sorted),
    aliases: collectAliases(modelId, raws),
    status: statusResult?.value ?? "unknown",
    fieldSources: {
      ...(pricing && pricingResult ? { pricing: pricingResult.source } : {}),
      ...(contextWindow !== undefined && contextResult ? { contextWindow: contextResult.source } : {}),
      ...(outputResult ? { maxOutputTokens: outputResult.source } : {}),
      ...(capsSource ? { capabilities: makeFieldSource(capsSource) } : {}),
      ...(displayResult ? { displayName: displayResult.source } : {}),
      ...(descResult ? { description: descResult.source } : {}),
      ...(statusResult ? { status: statusResult.source } : {}),
      ...(releaseDateSource ? { releaseDate: releaseDateSource } : {}),
    },
    sources: sourcesMap,
    ...(aggregatorsList.length > 0 ? { aggregators: aggregatorsList } : {}),
    lastUpdated: now,
    lastChecked: now,
  };

  return doc;
}

/**
 * Pick the model's native provider, not a gateway/aggregator name.
 * Provider reflects who MADE the model, not who resells it.
 * Strategy: prefer vendor-specific names over generic gateway names.
 */
function pickProvider(raws: RawModel[]): string | undefined {
  const GATEWAY_PROVIDERS = new Set([
    "opencode", "opencode-zen", "fireworks", "together", "togethercomputer",
  ]);

  // First pass: find a non-gateway provider from any source
  for (const raw of raws) {
    if (raw.provider && !GATEWAY_PROVIDERS.has(raw.provider.toLowerCase())) {
      return raw.provider;
    }
  }

  // Fallback: any provider at all
  for (const raw of raws) {
    if (raw.provider) return raw.provider;
  }

  return undefined;
}

interface PickResult<T> {
  value: T;
  source: FieldSource;
}

/** Like pickBest but also returns the FieldSource of the winning collector. */
function pickBestWithSource<T>(
  sorted: RawModel[],
  getter: (r: RawModel) => T | undefined,
): PickResult<T> | undefined {
  for (const raw of sorted) {
    const val = getter(raw);
    if (val !== undefined && val !== null) {
      return { value: val, source: makeFieldSource(raw) };
    }
  }
  return undefined;
}

function makeFieldSource(raw: RawModel): FieldSource {
  return {
    collectorId: raw.collectorId,
    confidence: raw.confidence,
    ...(raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

/** Union all capability flags: highest confidence wins for scalar flags.
 *  For effortLevels array: pick the most detailed (longest) list from the highest-confidence source. */
function mergeCapabilities(sorted: RawModel[]): ModelDoc["capabilities"] {
  const merged: ModelDoc["capabilities"] = {};
  // Apply lowest confidence first, highest confidence last (so highest confidence wins)
  for (const raw of [...sorted].reverse()) {
    if (!raw.capabilities) continue;
    // Spread all scalar fields
    const { effortLevels, ...rest } = raw.capabilities as Partial<CapabilityFlags>;
    Object.assign(merged, rest);
    // For effortLevels: keep the most informative (longest) list from the highest-confidence source
    // Since we iterate reverse-confidence (lowest first), each higher-confidence source overwrites
    if (effortLevels && effortLevels.length > 0) {
      merged.effortLevels = effortLevels;
    }
  }
  return merged;
}

/** Collect all external IDs as aliases (excluding the canonical ID itself). */
function collectAliases(canonicalId: string, raws: RawModel[]): string[] {
  const aliases = new Set<string>();
  for (const raw of raws) {
    if (raw.externalId !== canonicalId) aliases.add(raw.externalId);
    for (const a of raw.aliases ?? []) aliases.add(a);
  }
  aliases.delete(canonicalId);
  return [...aliases];
}

export function buildSourcesMap(raws: RawModel[]): ModelDoc["sources"] {
  const sources: ModelDoc["sources"] = {};
  for (const raw of raws) {
    const providerKey = raw.collectorId;
    // Use the most recent and highest-confidence entry per collector
    const existing = sources[providerKey];
    if (
      !existing ||
      CONFIDENCE_RANK[raw.confidence] > CONFIDENCE_RANK[existing.confidence]
    ) {
      sources[providerKey] = {
        confidence: raw.confidence,
        externalId: raw.externalId,
        lastSeen: Timestamp.now(),
        sourceUrl: raw.sourceUrl,
      };
    }
  }
  return sources;
}

/**
 * Build a CLI-friendly aggregator list from a merged `sources` map.
 *
 * Walks the `sources` map, skips non-routable collectors (e.g. pricing scrapers)
 * by filtering through `COLLECTOR_TO_PROVIDER`, and returns one `AggregatorEntry`
 * per routable collector. The resulting list is the multi-aggregator routing
 * index consumed by CLI catalog resolvers.
 */
export function buildAggregatorsList(
  sources: ModelDoc["sources"],
): AggregatorEntry[] {
  const aggregators: AggregatorEntry[] = [];
  for (const [collectorId, record] of Object.entries(sources)) {
    const provider = COLLECTOR_TO_PROVIDER[collectorId];
    if (!provider) continue; // non-routable collector (e.g. pricing scraper)
    aggregators.push({
      provider,
      externalId: record.externalId,
      confidence: record.confidence,
    });
  }
  return aggregators;
}

function roundPrice(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function sanitizePricing(pricing: PricingData): PricingData | undefined {
  const input = roundPrice(pricing.input);
  const output = roundPrice(pricing.output);

  if (
    input < PRICING_BOUNDS.input.min || input > PRICING_BOUNDS.input.max
  ) {
    console.warn(`[merger] pricing input out of bounds: ${input} USD/MTok — dropping`);
    return undefined;
  }

  if (
    output < PRICING_BOUNDS.output.min || output > PRICING_BOUNDS.output.max
  ) {
    console.warn(`[merger] pricing output out of bounds: ${output} USD/MTok — dropping`);
    return undefined;
  }

  return {
    ...pricing,
    input,
    output,
    ...(pricing.cachedRead !== undefined ? { cachedRead: roundPrice(pricing.cachedRead) } : {}),
    ...(pricing.cachedWrite !== undefined ? { cachedWrite: roundPrice(pricing.cachedWrite) } : {}),
  };
}
