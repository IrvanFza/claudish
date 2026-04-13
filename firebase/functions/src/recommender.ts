import { getFirestore } from "firebase-admin/firestore";
import type { ModelDoc, RecommendedModelEntry, RecommendedModelsDoc } from "./schema.js";
import { CONFIDENCE_RANK } from "./schema.js";

// ─────────────────────────────────────────────────────────────
// Provider definitions — ONLY provider identity, no model IDs
//
// The recommender discovers the best flagship and fast models
// per provider from the live catalog. No hardcoded model names.
// ─────────────────────────────────────────────────────────────

interface ProviderDef {
  /** Canonical provider slug(s) as seen in Firestore ModelDoc.provider */
  slugs: string[];
  /** Display name */
  display: string;
  /** Patterns that indicate a "fast" variant (turbo, flash, mini, nano, lite) */
  fastIndicators: RegExp[];
  /** Patterns to EXCLUDE from recommendations (obsolete/superseded models) */
  obsoleteIndicators?: RegExp[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    slugs: ["openai"],
    display: "OpenAI",
    fastIndicators: [/mini/i],
    // Modality exclusions (/audio/, /tts/, /dall-e/, /whisper/, /image/, /realtime/)
    // now handled by isCodingCandidate via capability flags. Entries below are
    // legacy/discontinued model LINES, not modalities:
    //   - codex:           old codex-* line, superseded by general gpt-* chat
    //   - gpt-oss:         OpenAI open-source weights, not the API line
    //   - computer-use:    agent-preview lineage, not general coding
    //   - embedding:       embedding models (not chat)
    //   - davinci / babbage: legacy instruct lineage
    //   - nano:            degraded sub-tier below mini — explicitly not recommended
    obsoleteIndicators: [/^codex/i, /^gpt-oss/i, /^computer-use/i, /^embedding/i, /^davinci/i, /^babbage/i, /nano/i],
  },
  {
    slugs: ["google"],
    display: "Google",
    // Gemma = open-weight (not Gemini API). deep-research / gemini-robotics
    // are research-preview lineages, not the coding API. Modality exclusions
    // (image/tts/audio) are handled by isCodingCandidate.
    fastIndicators: [/flash/i, /lite/i],
    obsoleteIndicators: [/^gemma/i, /^deep-research/i, /^gemini-robotics/i],
  },
  {
    slugs: ["x-ai"],
    display: "xAI",
    fastIndicators: [/fast/i],
    // Old coding-specific grok models superseded by general models
    obsoleteIndicators: [/code-fast/i],
  },
  {
    slugs: ["qwen"],
    display: "Qwen",
    fastIndicators: [/turbo/i, /lite/i, /flash/i],
    // omni / audio / vl / ocr / speech exclusions are handled by isCodingCandidate
    // (capability flags). `mt$` stays because it marks machine-translation
    // checkpoints that are text->text with tools but NOT general coding models.
    obsoleteIndicators: [/mt$/i],
  },
  {
    slugs: ["z-ai"],
    display: "Z.ai",
    fastIndicators: [/turbo/i, /flash/i],
  },
  {
    slugs: ["moonshotai"],
    display: "Moonshot",
    fastIndicators: [/turbo/i],
  },
  {
    slugs: ["minimax"],
    display: "MiniMax",
    fastIndicators: [], // No fast variant exists
  },
];

// ─────────────────────────────────────────────────────────────
// Positive coding-candidate predicate
//
// A model is a coding candidate iff:
//   - it supports tool calling (function calling)
//   - it does NOT accept audio/video input (non-coding modality)
//   - it does NOT emit image output (non-coding modality)
//   - it has real pricing (not free-tier-only)
//
// This replaces modality-based regex denylists with capability-flag checks.
// If the flags are wrong in Firestore, fix the COLLECTOR that wrote them —
// don't add a regex here.
// ─────────────────────────────────────────────────────────────
export function isCodingCandidate(doc: ModelDoc): boolean {
  const caps = doc.capabilities ?? {};
  // Positive: must support tools
  if (!caps.tools) return false;
  // Negative: modality exclusions
  if (caps.audioInput) return false;
  if (caps.videoInput) return false;
  if (caps.imageOutput) return false;
  // Pricing must be real (not free-tier-only / missing)
  if (!doc.pricing) return false;
  if (doc.pricing.input <= 0 && doc.pricing.output <= 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Subscription alternatives — maps provider slug to subscription plan.
// Users with these subscriptions access flagship models through a
// dedicated (often cheaper/unlimited) endpoint.
// ─────────────────────────────────────────────────────────────
/**
 * Subscription/access alternatives per provider.
 * Each provider may have multiple ways to access its models:
 * - Coding plan subscription (dedicated endpoint, often unlimited)
 * - Gateway (OpenCode Zen, OllamaCloud — free or cheap access)
 * - Per-usage API (direct, pay per token)
 * - OpenRouter (universal aggregator)
 */
interface AccessMethod {
  prefix: string;        // CLI routing prefix (e.g. cx@gpt-5.4)
  plan: string;          // display name
  type: "subscription" | "gateway" | "aggregator";
  modelOverride?: string; // different model name on this endpoint
}

export const ACCESS_METHODS: Record<string, AccessMethod[]> = {
  openai: [
    { prefix: "cx",  plan: "OpenAI Codex",         type: "subscription" },
  ],
  google: [
    { prefix: "go",  plan: "Gemini Code Assist",   type: "subscription" },
  ],
  moonshotai: [
    { prefix: "kc",  plan: "Kimi Coding",          type: "subscription", modelOverride: "kimi-for-coding" },
    { prefix: "oc",  plan: "OllamaCloud",          type: "gateway" },
  ],
  minimax: [
    { prefix: "mmc", plan: "MiniMax Coding",       type: "subscription" },
    { prefix: "oc",  plan: "OllamaCloud",          type: "gateway" },
  ],
  "z-ai": [
    { prefix: "gc",  plan: "GLM Coding",           type: "subscription" },
    { prefix: "zen", plan: "OpenCode Zen",          type: "gateway" },
    { prefix: "oc",  plan: "OllamaCloud",          type: "gateway" },
  ],
  qwen: [
    { prefix: "zen", plan: "OpenCode Zen",          type: "gateway" },
    { prefix: "oc",  plan: "OllamaCloud",          type: "gateway" },
  ],
  "x-ai": [
    // xAI has no subscription plan or gateway — direct API only
  ],
};

// ─────────────────────────────────────────────────────────────
// Scoring weights — release date is king for "most recent" selection
// ─────────────────────────────────────────────────────────────
const W_RELEASE    = 0.30;  // most recent release date wins
const W_CAPS       = 0.25;  // capabilities matter
const W_PRICING    = 0.15;  // cheaper is better (but less important than recency)
const W_CONTEXT    = 0.15;  // larger context is better
const W_CONFIDENCE = 0.15;  // higher confidence data is better

/**
 * Generate recommended models from Firestore catalog.
 *
 * Fully deterministic algorithmic pipeline: for each provider, find the best
 * flagship and fast model using scoring (no hardcoded model names, no LLM).
 */
export async function generateRecommendedModels(): Promise<RecommendedModelEntry[]> {
  const db = getFirestore();

  const snap = await db.collection("models")
    .where("status", "in", ["active", "preview"])
    .get();

  const allModels: ModelDoc[] = snap.docs.map(d => d.data() as ModelDoc);
  console.log(`[recommender] ${allModels.length} active/preview models in catalog`);

  // Algorithmic selection — deterministic, no LLM step
  const { flagships, fastModels } = selectByProvider(allModels);
  console.log(
    `[recommender] selected: ${flagships.length} flagships, ${fastModels.length} fast — ` +
    `flagships=[${flagships.map(m => m.modelId).join(", ")}] fast=[${fastModels.map(m => m.modelId).join(", ")}]`
  );

  const finalFlagships = flagships;
  const finalFast = fastModels;

  // Build final entries: flagships, subscription picks, fast variants
  const entries: RecommendedModelEntry[] = [];
  let priority = 1;
  for (const doc of finalFlagships) entries.push(toEntry(doc, priority++, "flagship"));

  // Subscription/access method picks: same flagship model via alternative endpoints
  for (const doc of finalFlagships) {
    const providerLower = (doc.provider ?? "").toLowerCase();
    const providerDef = PROVIDERS.find(p => p.slugs.includes(providerLower));
    const canonicalSlug = providerDef?.slugs[0];
    const methods = canonicalSlug ? ACCESS_METHODS[canonicalSlug] : undefined;
    if (!methods || methods.length === 0) continue;

    for (const method of methods) {
      const modelName = method.modelOverride ?? doc.modelId;
      const entry = toEntry(doc, priority++, "subscription");
      entry.subscription = {
        prefix: method.prefix,
        plan: method.plan,
        command: `${method.prefix}@${modelName}`,
      };
      if (method.modelOverride) {
        entry.id = method.modelOverride;
      }
      entries.push(entry);
    }
  }

  for (const doc of finalFast) entries.push(toEntry(doc, priority++, "fast"));

  // Write to Firestore
  const recDoc: RecommendedModelsDoc = {
    version: "2.0.0",
    lastUpdated: new Date().toISOString().split("T")[0],
    generatedAt: new Date().toISOString(),
    source: "firebase-auto",
    models: entries,
  };

  await db.collection("config").doc("recommended-models").set(recDoc);
  console.log(
    `[recommender] wrote ${entries.length} recommended: ` +
    entries.map(e => `${e.id}(${e.category})`).join(", ")
  );

  return entries;
}

// ─────────────────────────────────────────────────────────────
// Stage 1: Algorithmic selection — score-based, no hardcoded models
// ─────────────────────────────────────────────────────────────

export function selectByProvider(allModels: ModelDoc[]): {
  flagships: ModelDoc[];
  fastModels: ModelDoc[];
} {
  const flagships: ModelDoc[] = [];
  const fastModels: ModelDoc[] = [];

  for (const prov of PROVIDERS) {
    // Find all models for this provider. ModelDoc.provider is always a
    // CanonicalProviderSlug post-S1, so compare directly.
    const provModels = allModels.filter(m =>
      prov.slugs.some(s => m.provider === s),
    );

    if (provModels.length === 0) {
      console.log(`[recommender] no models for ${prov.display}`);
      continue;
    }

    // Positive predicate + obsolete lineage filter. modelIds are canonical
    // (no vendor prefix) post-S1, so regexes can run directly against modelId.
    const candidates = provModels
      .filter(isCodingCandidate)
      .filter(m =>
        !prov.obsoleteIndicators?.some(re => re.test(m.modelId)),
      );

    if (candidates.length === 0) {
      console.log(`[recommender] no coding-candidate models for ${prov.display}`);
      continue;
    }

    // Split into "fast" candidates and "flagship" candidates
    const fastCandidates = candidates.filter(m =>
      prov.fastIndicators.some(re => re.test(m.modelId)),
    );
    const flagshipCandidates = candidates.filter(m =>
      !prov.fastIndicators.some(re => re.test(m.modelId)),
    );

    // Pick best flagship by score
    const bestFlagship = pickBest(
      flagshipCandidates.length > 0 ? flagshipCandidates : candidates,
    );
    if (bestFlagship) flagships.push(bestFlagship);

    // Pick best fast model (if distinct from flagship)
    if (fastCandidates.length > 0) {
      const bestFast = pickBest(fastCandidates);
      if (bestFast && bestFast.modelId !== bestFlagship?.modelId) {
        fastModels.push(bestFast);
      }
    }
  }

  return { flagships, fastModels };
}

function pickBest(models: ModelDoc[]): ModelDoc | null {
  if (models.length === 0) return null;
  if (models.length === 1) return models[0];
  return models
    .map(m => ({ doc: m, score: scoreModel(m) }))
    .sort((a, b) => b.score - a.score)[0].doc;
}

// ─────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────

function scoreModel(doc: ModelDoc): number {
  return (
    W_RELEASE    * scoreReleaseDate(doc) +
    W_CAPS       * scoreCapabilities(doc) +
    W_PRICING    * scorePricing(doc) +
    W_CONTEXT    * scoreContext(doc) +
    W_CONFIDENCE * scoreConfidence(doc)
  );
}

/**
 * Release date score: more recently released models score higher.
 * Uses the model's releaseDate field (ISO date string from provider API).
 * Falls back to lastUpdated timestamp if releaseDate is missing.
 */
function scoreReleaseDate(doc: ModelDoc): number {
  const now = Date.now();

  // Prefer releaseDate (actual model release) over lastUpdated (data refresh)
  if (doc.releaseDate) {
    const releaseMs = new Date(doc.releaseDate).getTime();
    if (!isNaN(releaseMs)) {
      const ageDays = (now - releaseMs) / (1000 * 60 * 60 * 24);
      // Within 7 days: 1.0, within 30 days: 0.85, within 90 days: 0.6, within 180 days: 0.3, older: 0.1
      if (ageDays <= 7) return 1.0;
      if (ageDays <= 30) return 0.85;
      if (ageDays <= 90) return 0.6;
      if (ageDays <= 180) return 0.3;
      return 0.1;
    }
  }

  // Fallback to lastUpdated (data refresh timestamp)
  if (doc.lastUpdated) {
    const updatedMs = doc.lastUpdated.toMillis();
    const ageDays = (now - updatedMs) / (1000 * 60 * 60 * 24);
    if (ageDays <= 7) return 0.7;   // lower than releaseDate since this is just data refresh
    if (ageDays <= 30) return 0.5;
    return 0.2;
  }

  return 0.1; // no date info at all
}

function scorePricing(doc: ModelDoc): number {
  if (!doc.pricing) return 0;
  const avg = (doc.pricing.input + doc.pricing.output) / 2;
  if (avg <= 0) return 1.0;
  return Math.max(0, 1 - Math.log10(avg + 1) / Math.log10(100));
}

function scoreContext(doc: ModelDoc): number {
  if (!doc.contextWindow) return 0;
  return Math.min(1.0, Math.log10(doc.contextWindow) / Math.log10(10_000_000));
}

function scoreCapabilities(doc: ModelDoc): number {
  let score = 0.4;
  if (doc.capabilities?.thinking) score += 0.25;
  if (doc.capabilities?.vision) score += 0.15;
  if (doc.capabilities?.structuredOutput) score += 0.10;
  if (doc.capabilities?.pdfInput) score += 0.05;
  if (doc.capabilities?.codeExecution) score += 0.05;
  return Math.min(1.0, score);
}

function scoreConfidence(doc: ModelDoc): number {
  const pricingConf = doc.fieldSources?.pricing?.confidence;
  if (!pricingConf) return 0.2;
  return CONFIDENCE_RANK[pricingConf] / 5;
}

// ─────────────────────────────────────────────────────────────
// Conversion helpers
// ─────────────────────────────────────────────────────────────

export function toEntry(doc: ModelDoc, priority: number, tier: "flagship" | "fast" | "subscription"): RecommendedModelEntry {
  const orSource = doc.sources?.["openrouter-api"];
  const openrouterId = orSource?.externalId ?? `${doc.provider}/${doc.modelId}`;

  return {
    id: doc.modelId,
    openrouterId,
    name: doc.displayName,
    description: doc.description ?? `${doc.displayName} model`,
    provider: capitalize(doc.provider),
    category: tier === "fast" ? "fast" : tier === "subscription" ? "subscription" : inferCategory(doc),
    priority,
    pricing: {
      input: doc.pricing ? formatPrice(doc.pricing.input) : "N/A",
      output: doc.pricing ? formatPrice(doc.pricing.output) : "N/A",
      average: doc.pricing ? formatPrice((doc.pricing.input + doc.pricing.output) / 2) : "N/A",
    },
    context: doc.contextWindow ? formatContext(doc.contextWindow) : "N/A",
    maxOutputTokens: doc.maxOutputTokens ?? null,
    modality: inferModality(doc),
    supportsTools: doc.capabilities?.tools ?? false,
    supportsReasoning: doc.capabilities?.thinking ?? false,
    supportsVision: doc.capabilities?.vision ?? false,
    isModerated: false,
    recommended: true,
  };
}

function inferCategory(doc: ModelDoc): string {
  if (doc.capabilities?.vision) return "vision";
  if (doc.capabilities?.thinking) return "reasoning";
  return "programming";
}

function inferModality(doc: ModelDoc): string {
  const inputs = ["text"];
  if (doc.capabilities?.vision) inputs.push("image");
  if (doc.capabilities?.pdfInput) inputs.push("file");
  if (doc.capabilities?.audioInput) inputs.push("audio");
  if (doc.capabilities?.videoInput) inputs.push("video");
  return `${inputs.join("+")}->text`;
}

function formatPrice(usdPerMillion: number): string {
  if (usdPerMillion <= 0) return "FREE";
  return `$${usdPerMillion.toFixed(2)}/1M`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  return `${Math.floor(tokens / 1000)}K`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
