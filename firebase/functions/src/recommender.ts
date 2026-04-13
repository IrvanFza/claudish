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
    // Exclude non-chat models and old codex line
    obsoleteIndicators: [/codex/i, /^realtime/i, /^audio/i, /^tts/i, /^dall-e/i, /^whisper/i, /image/i, /^gpt-oss/i, /^computer-use/i, /^embedding/i, /^chatgpt-image/i, /^davinci/i, /^babbage/i, /nano/i],
  },
  {
    slugs: ["google"],
    display: "Google",
    // Exclude Gemma (open-weight, not Gemini API), and non-chat models
    fastIndicators: [/flash/i, /lite/i],
    obsoleteIndicators: [/^gemma/i, /^deep-research/i, /^gemini-robotics/i, /image/i, /tts/i, /audio/i],
  },
  {
    slugs: ["x-ai", "xai"],
    display: "xAI",
    fastIndicators: [/fast/i],
    // Old coding-specific grok models superseded by general models
    obsoleteIndicators: [/code-fast/i],
  },
  {
    slugs: ["qwen"],
    display: "Qwen",
    fastIndicators: [/turbo/i, /lite/i, /flash/i],
    obsoleteIndicators: [/omni/i, /audio/i, /vl/i, /ocr/i, /speech/i, /mt$/i],
  },
  {
    slugs: ["z-ai", "zhipu", "zai", "glm"],
    display: "Z.ai",
    fastIndicators: [/turbo/i, /flash/i],
  },
  {
    slugs: ["moonshotai", "moonshot", "kimi"],
    display: "Moonshot",
    fastIndicators: [/turbo/i],
  },
  {
    slugs: ["minimax", "minimaxai"],
    display: "MiniMax",
    fastIndicators: [], // No fast variant exists
  },
];

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
 * Two-stage pipeline:
 * 1. Algorithmic: For each provider, find the best flagship and fast model
 *    using scoring (no hardcoded model names).
 * 2. LLM fine-tuning: Send candidates to Gemini Flash for review.
 *    If LLM fails, algorithmic picks are used as-is.
 */
export async function generateRecommendedModels(): Promise<RecommendedModelEntry[]> {
  const db = getFirestore();

  const snap = await db.collection("models")
    .where("status", "in", ["active", "preview"])
    .get();

  const allModels: ModelDoc[] = snap.docs.map(d => d.data() as ModelDoc);
  console.log(`[recommender] ${allModels.length} active/preview models in catalog`);

  // Stage 1: Algorithmic selection
  const { flagships, fastModels } = selectByProvider(allModels);
  console.log(
    `[recommender] algorithmic: ${flagships.length} flagships, ${fastModels.length} fast — ` +
    `flagships=[${flagships.map(m => m.modelId).join(", ")}] fast=[${fastModels.map(m => m.modelId).join(", ")}]`
  );

  // Stage 2: LLM fine-tuning
  let finalFlagships = flagships;
  let finalFast = fastModels;
  try {
    const refined = await llmRefine(flagships, fastModels, allModels);
    if (refined) {
      finalFlagships = refined.flagships;
      finalFast = refined.fast;
      console.log(
        `[recommender] LLM refined: flagships=[${finalFlagships.map(m => m.modelId).join(", ")}] ` +
        `fast=[${finalFast.map(m => m.modelId).join(", ")}]`
      );
    }
  } catch (err) {
    console.warn(`[recommender] LLM fine-tuning failed, using algorithmic picks:`, err);
  }

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
    // Find all models for this provider
    const provModels = allModels.filter(m => {
      const p = m.provider.toLowerCase();
      return prov.slugs.some(s => p === s);
    });

    if (provModels.length === 0) {
      console.log(`[recommender] no models for ${prov.display}`);
      continue;
    }

    // Filter out obsolete models (match against bare ID, stripping vendor prefix)
    const viable = provModels.filter(m => {
      if (!prov.obsoleteIndicators) return true;
      const bareId = m.modelId.includes("/") ? m.modelId.split("/").pop()! : m.modelId;
      return !prov.obsoleteIndicators.some(re => re.test(bareId));
    });

    // Must support tool calling and have real pricing (skip free-only/stale models)
    const withTools = viable.filter(m =>
      m.capabilities?.tools &&
      m.pricing && (m.pricing.input > 0 || m.pricing.output > 0)
    );
    if (withTools.length === 0) {
      console.log(`[recommender] no tool-capable models for ${prov.display}`);
      continue;
    }

    // Split into "fast" candidates and "flagship" candidates
    const bareModelId = (m: ModelDoc) => m.modelId.includes("/") ? m.modelId.split("/").pop()! : m.modelId;
    const fastCandidates = withTools.filter(m =>
      prov.fastIndicators.some(re => re.test(bareModelId(m)))
    );
    const flagshipCandidates = withTools.filter(m =>
      !prov.fastIndicators.some(re => re.test(bareModelId(m)))
    );

    // Pick best flagship by score
    const bestFlagship = pickBest(flagshipCandidates.length > 0 ? flagshipCandidates : withTools);
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
// Stage 2: LLM fine-tuning with Gemini Flash
// ─────────────────────────────────────────────────────────────

interface LLMRefinement {
  flagships: ModelDoc[];
  fast: ModelDoc[];
}

async function llmRefine(
  flagships: ModelDoc[],
  fastModels: ModelDoc[],
  allModels: ModelDoc[],
): Promise<LLMRefinement | null> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[recommender] no GOOGLE_GEMINI_API_KEY, skipping LLM refinement");
    return null;
  }

  // Build alternatives pool — top 10 per provider so the LLM sees newer versions
  const pickedIds = new Set([...flagships, ...fastModels].map(m => m.modelId));
  const targetProviderSlugs = new Set(PROVIDERS.flatMap(p => p.slugs));
  // Build per-provider obsolete filters for alternatives
  const providerObsolete = new Map<string, RegExp[]>();
  for (const p of PROVIDERS) {
    if (p.obsoleteIndicators) {
      for (const slug of p.slugs) providerObsolete.set(slug, p.obsoleteIndicators);
    }
  }

  const allAlts = allModels
    .filter(m => !pickedIds.has(m.modelId) && m.capabilities?.tools)
    .filter(m => m.pricing && (m.pricing.input > 0 || m.pricing.output > 0))
    .filter(m => targetProviderSlugs.has((m.provider ?? "").toLowerCase()))
    .filter(m => {
      const bareId = m.modelId.includes("/") ? m.modelId.split("/").pop()! : m.modelId;
      const obs = providerObsolete.get((m.provider ?? "").toLowerCase());
      return !obs || !obs.some(re => re.test(bareId));
    })
    .map(m => ({ id: m.modelId, provider: m.provider, score: scoreModel(m), released: m.releaseDate }));

  // Take top 10 per provider to ensure each provider's models are visible
  const altsByProvider = new Map<string, typeof allAlts>();
  for (const a of allAlts) {
    const key = (a.provider ?? "").toLowerCase();
    const list = altsByProvider.get(key) ?? [];
    list.push(a);
    altsByProvider.set(key, list);
  }
  const alternatives: typeof allAlts = [];
  for (const [, list] of altsByProvider) {
    list.sort((a, b) => b.score - a.score);
    alternatives.push(...list.slice(0, 15));
  }
  alternatives.sort((a, b) => b.score - a.score);

  const prompt = buildLLMPrompt(flagships, fastModels, alternatives);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[recommender] Gemini returned ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn(`[recommender] Gemini returned no text. Finish reason: ${data?.candidates?.[0]?.finishReason}`);
      return null;
    }

    let result: { flagships: string[]; fast: string[]; reasoning?: string };
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.warn(`[recommender] Failed to parse Gemini JSON: ${text.slice(0, 300)}`);
      return null;
    }

    if (result.reasoning) {
      console.log(`[recommender] LLM reasoning: ${result.reasoning}`);
    }

    const modelMap = new Map(allModels.map(m => [m.modelId, m]));

    const refinedFlagships = result.flagships
      .map(id => modelMap.get(id))
      .filter((m): m is ModelDoc => m !== undefined);

    const refinedFast = result.fast
      .map(id => modelMap.get(id))
      .filter((m): m is ModelDoc => m !== undefined);

    // Sanity: at least 3 flagships
    if (refinedFlagships.length < 3) {
      console.warn(`[recommender] LLM returned too few flagships (${refinedFlagships.length}), keeping algorithmic`);
      return null;
    }

    return { flagships: refinedFlagships, fast: refinedFast };
  } catch (err) {
    console.warn(`[recommender] LLM error:`, err);
    return null;
  }
}

function buildLLMPrompt(
  flagships: ModelDoc[],
  fastModels: ModelDoc[],
  alternatives: Array<{ id: string; provider: string; score: number; released?: string }>,
): string {
  const formatModel = (m: ModelDoc) =>
    `  - ${m.modelId} (${m.provider}) — released:${m.releaseDate ?? "unknown"}, ctx:${m.contextWindow ? formatContext(m.contextWindow) : "?"}, ` +
    `$${m.pricing?.input?.toFixed(2) ?? "?"}/$${m.pricing?.output?.toFixed(2) ?? "?"}/MTok, ` +
    `tools:${m.capabilities?.tools ? "Y" : "N"} reason:${m.capabilities?.thinking ? "Y" : "N"} vision:${m.capabilities?.vision ? "Y" : "N"}`;

  const flagshipSummary = flagships.map(formatModel).join("\n");
  const fastSummary = fastModels.map(formatModel).join("\n");
  const altSummary = alternatives.map(a => `  - ${a.id} (${a.provider}) released:${a.released ?? "?"} score:${a.score.toFixed(3)}`).join("\n");

  return `You are a model catalog curator for Claudish, a CLI proxy for Claude Code that routes to external AI models.

You make the FINAL DECISION on which models to recommend. The algorithm is just a starting point — you must validate and fix its choices.

## Rules (MUST follow)
1. Models are for CODING and AGENTIC tasks (tool calling mandatory)
2. EXACTLY one flagship per provider: OpenAI, Google, xAI/Grok, Qwen, Z.ai/GLM, Moonshot/Kimi, MiniMax
3. Fast variants (turbo/flash/mini/lite) where available
4. Do NOT include Anthropic/Claude (native in Claude Code)
5. Do NOT include free-tier-only models
6. CRITICAL: Always pick the NEWEST version. Higher version numbers = newer:
   - gpt-5.4 > gpt-5.3 > gpt-5.1 (pick gpt-5.4 as flagship)
   - gemini-3.1-pro > gemini-2.5-pro (pick 3.1)
   - kimi-k2.5 > kimi-k2 (pick k2.5)
   - minimax-m2.7 > minimax-m2.5 (pick m2.7)
   - glm-5.1 > glm-5 > glm-4.7 (pick 5.1 if available)
7. The algorithm often picks WRONG due to pricing bias. CHECK version numbers carefully.
8. Flagship = the FULL/LARGEST model (e.g. gpt-5.4, NOT gpt-5.4-mini or gpt-5.4-nano). Mini/nano/lite variants are FAST models, not flagships.
9. Fast = mini/nano/lite/flash/turbo variants of the SAME version as the flagship.
10. For fast variants: prefer mini over nano (nano is a degraded sub-tier, not recommended). If both exist, pick mini.
11. NEVER pick omni/audio/speech/VL/multimodal-only models. These are NOT coding models. Only pick text->text or text+image->text models with tool calling.

## Algorithm picks (REVIEW CRITICALLY — likely has version errors)

Flagships:
${flagshipSummary || "  (none)"}

Fast models:
${fastSummary || "  (none)"}

## All alternatives (model IDs not picked — check for NEWER versions here)
${altSummary || "  (none)"}

## Your task
For EACH provider: check if a newer version exists in the alternatives. Swap if so.

CRITICAL: Use EXACT model IDs from the lists above. Do NOT invent or modify IDs. If an ID is "gpt-5.4", use "gpt-5.4" — NOT "gpt-5.4-chat" or any other variation.

Return JSON:
{
  "flagships": ["model-id-1", "model-id-2", ...],
  "fast": ["model-id-1", ...],
  "reasoning": "Explain each swap you made"
}`;
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
