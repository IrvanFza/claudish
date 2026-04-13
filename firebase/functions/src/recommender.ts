import { getFirestore } from "firebase-admin/firestore";
import type { ModelDoc, RecommendedModelEntry, RecommendedModelsDoc } from "./schema.js";
import { CONFIDENCE_RANK } from "./schema.js";
import {
  KNOWN_PROVIDER_SLUGS,
  validateRecommendedDoc,
} from "./schema-runtime.js";
import { alertRecommendationDiff } from "./slack-alert.js";

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
/**
 * Lexical modality fallback: catch image/audio/speech/tts models when their
 * capability flags are incomplete (upstream data quality issue). These
 * substrings in the model id are a strong signal that the model is not a
 * coding tool, even if `imageOutput` / `audioInput` are unset.
 *
 * Intentionally narrow — only substrings that are unambiguous modality
 * markers. Does NOT include "flash" (that's a speed tier, not a modality)
 * or "vision" (vision-capable coding models are fine).
 */
const MODALITY_ID_MARKERS = [
  /-image-/i,   // gemini-3.1-flash-image-preview
  /-image$/i,   // gpt-5-image
  /^image-/i,   // image-gen-1
  /-audio-/i,
  /-audio$/i,
  /-tts-/i,
  /-tts$/i,
  /-speech-/i,
  /-speech$/i,
  /-omni-/i,    // qwen3-omni-flash (multimodal, not coding)
  /-omni$/i,
  /-realtime/i, // realtime audio endpoints
  /-whisper/i,
  /-embedding/i, // embedding models don't have tool calling anyway, defense in depth
  /-dall-e/i,
];

export function isCodingCandidate(doc: ModelDoc): boolean {
  const caps = doc.capabilities ?? {};
  // Positive: must support tools
  if (!caps.tools) return false;
  // Negative: modality exclusions (capability flags — primary signal)
  if (caps.audioInput) return false;
  if (caps.videoInput) return false;
  if (caps.imageOutput) return false;
  // Lexical modality fallback (for collectors with incomplete capability flags)
  if (MODALITY_ID_MARKERS.some(re => re.test(doc.modelId))) return false;
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

  // Build the doc
  const recDoc: RecommendedModelsDoc = {
    version: "2.0.0",
    lastUpdated: new Date().toISOString().split("T")[0],
    generatedAt: new Date().toISOString(),
    source: "firebase-auto",
    models: entries,
  };

  // ── Pre-publish gate: schema validation ────────────────────────────
  const schemaResult = validateRecommendedDoc(recDoc);
  if (!schemaResult.ok) {
    console.error(
      `[recommender] schema validation failed, writing to pending: ${schemaResult.errors.join("; ")}`,
    );
    await db.collection("config").doc("recommended-models-pending").set(recDoc);
    const webhook = process.env.SLACK_WEBHOOK_URL ?? "";
    await alertRecommendationDiff(
      webhook,
      schemaResult.errors.map((e) => `schema: ${e}`),
    );
    return entries;
  }

  // ── Pre-publish gate: diff vs previously published doc ─────────────
  const prevSnap = await db.collection("config").doc("recommended-models").get();
  const prevDoc = prevSnap.exists
    ? (prevSnap.data() as RecommendedModelsDoc)
    : null;

  const diffResult = diffRecommendations(prevDoc, recDoc);
  if (!diffResult.ok) {
    console.error(
      `[recommender] diff gate rejected ${diffResult.violations.length} violation(s): ${diffResult.violations.join("; ")}`,
    );
    await db.collection("config").doc("recommended-models-pending").set(recDoc);
    const webhook = process.env.SLACK_WEBHOOK_URL ?? "";
    await alertRecommendationDiff(webhook, diffResult.violations);
    return entries;
  }

  // ── Gate clean → publish ───────────────────────────────────────────
  await db.collection("config").doc("recommended-models").set(recDoc);
  console.log(
    `[recommender] wrote ${entries.length} recommended: ` +
    entries.map(e => `${e.id}(${e.category})`).join(", ")
  );

  return entries;
}

// ─────────────────────────────────────────────────────────────
// Pre-publish diff gate
//
// Compares the new recommended-models doc to the currently published
// one. Flags drastic regressions that almost certainly indicate a
// broken upstream collector rather than a legitimate model-catalog
// change.
// ─────────────────────────────────────────────────────────────

const KNOWN_PROVIDER_SET: Set<string> = new Set(KNOWN_PROVIDER_SLUGS);

export interface DiffResult {
  ok: boolean;
  violations: string[];
}

export function diffRecommendations(
  previous: RecommendedModelsDoc | null,
  next: RecommendedModelsDoc,
): DiffResult {
  const violations: string[] = [];

  // Cheap paranoid checks on NEXT doc — these should be impossible
  // post-S1/S2 but catch regressions if the schema loosens.
  for (const entry of next.models) {
    if (entry.id.includes("/")) {
      violations.push(`entry.id "${entry.id}" contains "/" (should be canonical)`);
    }
    // entry.provider is the DISPLAY provider ("OpenAI", "Google", etc.).
    // Compare the lowercased form against KNOWN_PROVIDER_SLUGS.
    const providerLower = (entry.provider ?? "").toLowerCase();
    if (providerLower && !KNOWN_PROVIDER_SET.has(providerLower)) {
      violations.push(
        `entry "${entry.id}" has unknown provider "${entry.provider}" (not in KNOWN_PROVIDER_SLUGS)`,
      );
    }
  }

  // Can't diff against nothing — first publish always succeeds
  if (!previous) {
    return { ok: violations.length === 0, violations };
  }

  // Provider set today vs yesterday (using display provider, lowercased)
  const prevProviders = new Set(
    previous.models.map((m) => (m.provider ?? "").toLowerCase()).filter(Boolean),
  );
  const nextProviders = new Set(
    next.models.map((m) => (m.provider ?? "").toLowerCase()).filter(Boolean),
  );
  for (const p of prevProviders) {
    if (!nextProviders.has(p)) {
      violations.push(`provider "${p}" disappeared entirely (had entries yesterday)`);
    }
  }

  // Per-category count drop >30% — but ignore reshuffles where models are
  // simply being recategorized (e.g. capability flags improved and a model
  // moves from "vision" to "programming"). Only count the drop if the missing
  // models from this category aren't present in some OTHER category.
  const idsByCategory = (doc: RecommendedModelsDoc): Record<string, Set<string>> => {
    const buckets: Record<string, Set<string>> = {};
    for (const m of doc.models) {
      (buckets[m.category] ??= new Set()).add(m.id);
    }
    return buckets;
  };
  const prevByCat = idsByCategory(previous);
  const nextByCat = idsByCategory(next);
  const allNextIds = new Set(next.models.map((m) => m.id));
  for (const [cat, prevIds] of Object.entries(prevByCat)) {
    if (prevIds.size < 3) continue;
    const nextIds = nextByCat[cat] ?? new Set();
    if (nextIds.size >= prevIds.size * 0.7) continue;
    // Drop is large enough on paper. But: only count IDs that DISAPPEARED
    // from the doc entirely, not ones that just moved to another category.
    const trulyMissing: string[] = [];
    for (const id of prevIds) {
      if (!allNextIds.has(id)) trulyMissing.push(id);
    }
    if (trulyMissing.length > prevIds.size * 0.3) {
      violations.push(
        `category "${cat}" lost ${trulyMissing.length} of ${prevIds.size} models entirely (not just recategorized): ${trulyMissing.slice(0, 3).join(", ")}${trulyMissing.length > 3 ? "..." : ""}`,
      );
    }
  }

  // Total entry count drop >20%
  const prevTotal = previous.models.length;
  const nextTotal = next.models.length;
  if (prevTotal >= 5 && nextTotal < prevTotal * 0.8) {
    violations.push(
      `total entries dropped ${prevTotal} → ${nextTotal} (>20% loss)`,
    );
  }

  return { ok: violations.length === 0, violations };
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
  // Deterministic picker that replaces the former llmRefine stage.
  //
  // The scoring formula alone is not enough — it weights pricing and caps,
  // so it picks gpt-5-image (cheap, capable) over gpt-5.4 (the real flagship).
  // The llmRefine stage used to fix this by instructing Gemini "prefer the
  // newest version number" and "prefer the bare canonical form over suffix
  // variants". We rebuild that deterministically here.
  //
  // Order:
  //   1. Sort by score descending
  //   2. Collapse the top-K to their prefix trunk (before any suffix word)
  //      and return the one whose version tuple is highest
  //   3. Among equal versions, prefer the model with the SHORTER id
  //      (i.e. "gpt-5.4" over "gpt-5.4-preview")
  const scored = models
    .map(m => ({ doc: m, score: scoreModel(m), ver: parseVersion(m.modelId) }))
    .sort((a, b) => {
      // Primary: numeric version (descending)
      const av = a.ver?.version ?? [];
      const bv = b.ver?.version ?? [];
      const versionCmp = compareVersions(bv, av);
      if (versionCmp !== 0) return versionCmp;
      // Secondary: shorter id wins (bare canonical over suffix variant)
      if (a.doc.modelId.length !== b.doc.modelId.length) {
        return a.doc.modelId.length - b.doc.modelId.length;
      }
      // Tertiary: scoring formula
      return b.score - a.score;
    });
  return scored[0].doc;
}

/**
 * Parse a version tuple out of a model id. Returns null if no version-like
 * substring is present. Used to sort siblings like `gpt-5.4 > gpt-5.2 > gpt-5-image`.
 *
 *   gpt-5.4                  → [5, 4]
 *   gpt-5.4-mini             → [5, 4]
 *   gpt-5-image              → [5]        (loses to [5, 4])
 *   qwen3.6-plus             → [3, 6]
 *   minimax-m2.7             → [2, 7]
 *   glm-5.1                  → [5, 1]
 *   grok-4.20                → [4, 20]    (numeric, beats [4, 3])
 *   qwen3-max-2026-01-23     → [3]        (strip trailing date suffix)
 *   qwen3-max                → [3]
 *   qwen-max-2025-01-25      → null       (date is not a version)
 *   qwen-plus-2025-07-28     → null       (date is not a version)
 *   qwq-32b                  → null       (parameter count, not a version)
 *   llama-70b                → null       (parameter count)
 *   qwen3-coder-30b-a3b      → [3]        (strip param counts, parse `qwen3`)
 *
 * Pre-processing strips:
 *   1. Trailing date stamps (-YYYY-MM-DD, -YYYY-MM, -YYYYMMDD)
 *   2. Parameter-count tokens (-Nb, -Nm, NbN, etc.) — these are model size,
 *      not version. Without this strip, qwq-32b would parse as [32] and beat
 *      qwen3-max ([3]) in the version comparison.
 */
function parseVersion(modelId: string): { version: number[] } | null {
  // 1. Strip trailing date stamps so they don't pollute the version parse.
  let stripped = modelId
    .replace(/-\d{4}-\d{2}-\d{2}(-[a-z]+)?(:[a-z]+)?$/i, "")
    .replace(/-\d{4}\d{2}\d{2}$/i, "")
    .replace(/-\d{4}-\d{2}$/i, "");

  // 2. Strip parameter-count tokens. These look like:
  //    -32b, -7b, -70b, -405b, -1.5b, -3b, -32b-a3b (MoE notation), -8x7b
  //    Always at a token boundary (-) and end with `b` (billion) or `m` (million).
  //    Repeat the strip in case of multiple param tokens like -30b-a3b.
  for (let i = 0; i < 4; i++) {
    const before = stripped;
    stripped = stripped.replace(/-\d+(?:\.\d+)?[bm](?=$|-)/gi, "");
    stripped = stripped.replace(/-\d+x\d+[bm](?=$|-)/gi, ""); // -8x7b mixture-of-experts
    stripped = stripped.replace(/-a\d+[bm](?=$|-)/gi, "");    // -a3b (active params in MoE)
    if (stripped === before) break;
  }

  // 3. Match the first run of digits optionally followed by .N.N... groups
  const match = stripped.match(/(\d+(?:\.\d+)*)/);
  if (!match) return null;
  const version = match[1].split(".").map(Number).filter(n => !Number.isNaN(n));
  if (version.length === 0) return null;

  // 4. Sanity: reject anything where the first component looks like a year (≥ 1900).
  // That means the "version" we parsed is actually a standalone date with no
  // real version, like "qwen-plus-2025-12-01" → [2025, 12, 1]. Treat as no version.
  if (version[0] >= 1900) return null;

  // 5. Sanity: reject anything where the first component is unreasonably large
  // for a version number (>99). Real version numbers don't go that high; if we
  // see one, it's almost certainly a parameter count we missed (e.g. `model-128k`).
  if (version[0] > 99) return null;

  return { version };
}

/**
 * Compare two version arrays element-wise. Returns >0 if a is newer, <0 if
 * b is newer, 0 if equal. Shorter arrays are padded with 0s.
 *
 *   [5, 4]  vs [5, 1]  →  3 (a wins)
 *   [5, 4]  vs [5]     →  4 (a wins — longer beats shorter when prefix equal)
 *   [4, 20] vs [4, 3]  → 17 (a wins — numeric, not lexicographic!)
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
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
