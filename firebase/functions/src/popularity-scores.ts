// ─────────────────────────────────────────────────────────────
// Static provider popularity table
//
// Hand-curated reputation score per canonical provider slug, used
// by the top100 ranking endpoint. This is intentionally static —
// we control the values, they're reviewable in PRs, and they don't
// depend on external analytics.
//
// Scale: 0–100
//   100  — frontier lab, widely adopted flagship models
//    80  — strong reputation, widely used
//    60  — specialized or emerging
//    40  — default for unknown / niche providers
//
// Keys are canonical provider slugs from schema-runtime.ts
// (KNOWN_PROVIDER_SLUGS). Update both files together when adding
// a new provider.
// ─────────────────────────────────────────────────────────────

import type { CanonicalProviderSlug } from "./schema-runtime.js";
import type { ModelDoc } from "./schema.js";

export const PROVIDER_POPULARITY: Record<CanonicalProviderSlug, number> = {
  // Tier S — frontier labs
  anthropic:     100,
  openai:        100,
  google:         95,
  "x-ai":         88,
  deepseek:       88,

  // Tier A — strong reputation
  "meta-llama":   82,
  qwen:           80,
  alibaba:        80,
  mistralai:      75,
  "z-ai":         72,
  moonshotai:     72,
  minimax:        70,

  // Tier B — specialized / emerging
  cohere:         65,
  perplexity:     62,
  nvidia:         60,
  "black-forest-labs": 60,
  bytedance:      55,
  ai21:           55,
  "01-ai":        55,
  "stability-ai": 50,
  baidu:          50,
  tencent:        50,

  // Aggregators / gateways — these are routing layers, not model authors.
  // Low score so they never outrank real labs on reputation alone.
  openrouter:     40,
  togethercomputer: 45,
  "fireworks-ai": 45,
  "opencode-zen": 40,
};

const DEFAULT_POPULARITY = 40;

/**
 * Look up the 0–100 popularity score for a provider slug.
 * Returns DEFAULT_POPULARITY for unknown providers so the whole
 * scoring pipeline never crashes on a new provider.
 */
export function popularityPoints(provider: string | undefined | null): number {
  if (!provider) return DEFAULT_POPULARITY;
  const key = provider.toLowerCase();
  return (PROVIDER_POPULARITY as Record<string, number>)[key] ?? DEFAULT_POPULARITY;
}

// ─────────────────────────────────────────────────────────────
// Top-100 ranking score
//
// Weighted composite of:
//   popularity   25%  — static provider reputation (above)
//   recency      30%  — releaseDate proximity to now
//   generation   20%  — is this the latest version in its family?
//   capabilities 10%  — thinking, vision, tools, etc.
//   context      10%  — context window size (log scale)
//   confidence    5%  — data source confidence
//
// Output is 0–100 (all sub-scores are 0–1 then scaled at the end).
// ─────────────────────────────────────────────────────────────

const W_POPULARITY  = 0.25;
const W_RECENCY     = 0.30;
const W_GENERATION  = 0.20;
const W_CAPABILITIES = 0.10;
const W_CONTEXT     = 0.10;
const W_CONFIDENCE  = 0.05;

/**
 * Top100 score bundled with its components so callers can inspect
 * WHY a model ranked where it did (useful for debugging and for
 * the response payload).
 */
export interface Top100Score {
  total: number;          // 0–100
  popularity: number;     // 0–100 (raw table lookup, not weighted)
  recency: number;        // 0–1
  generation: number;     // 0–1
  capabilities: number;   // 0–1
  context: number;        // 0–1
  confidence: number;     // 0–1
}

export function scoreForTop100(
  doc: ModelDoc,
  generationScore: number,
): Top100Score {
  const popularity = popularityPoints(doc.provider);
  const recency = scoreRecency(doc);
  const capabilities = scoreCapabilities(doc);
  const context = scoreContext(doc);
  const confidence = scoreConfidence(doc);

  const total =
    W_POPULARITY  * popularity +
    W_RECENCY     * recency * 100 +
    W_GENERATION  * generationScore * 100 +
    W_CAPABILITIES * capabilities * 100 +
    W_CONTEXT     * context * 100 +
    W_CONFIDENCE  * confidence * 100;

  return {
    total: Math.round(total * 100) / 100,
    popularity,
    recency,
    generation: generationScore,
    capabilities,
    context,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────
// Sub-score helpers — mirror recommender.ts but kept local so
// top100 can evolve independently of the recommender rubric.
// ─────────────────────────────────────────────────────────────

function scoreRecency(doc: ModelDoc): number {
  const now = Date.now();
  if (doc.releaseDate) {
    const releaseMs = new Date(doc.releaseDate).getTime();
    if (!isNaN(releaseMs)) {
      const ageDays = (now - releaseMs) / (1000 * 60 * 60 * 24);
      if (ageDays <= 30)  return 1.0;
      if (ageDays <= 90)  return 0.85;
      if (ageDays <= 180) return 0.65;
      if (ageDays <= 365) return 0.40;
      if (ageDays <= 730) return 0.20;
      return 0.05;
    }
  }
  if (doc.lastUpdated) {
    const ageDays = (now - doc.lastUpdated.toMillis()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 30) return 0.40;
    return 0.15;
  }
  return 0.05;
}

function scoreCapabilities(doc: ModelDoc): number {
  let s = 0.35;
  if (doc.capabilities?.thinking)         s += 0.25;
  if (doc.capabilities?.vision)           s += 0.15;
  if (doc.capabilities?.tools)            s += 0.10;
  if (doc.capabilities?.structuredOutput) s += 0.08;
  if (doc.capabilities?.promptCaching)    s += 0.07;
  return Math.min(1.0, s);
}

function scoreContext(doc: ModelDoc): number {
  if (!doc.contextWindow) return 0;
  // log-scaled to 10M tokens
  return Math.min(1.0, Math.log10(doc.contextWindow) / Math.log10(10_000_000));
}

function scoreConfidence(doc: ModelDoc): number {
  const conf = doc.fieldSources?.pricing?.confidence;
  if (!conf) return 0.2;
  const rank: Record<string, number> = {
    scrape_unverified: 1,
    scrape_verified: 2,
    aggregator_reported: 3,
    gateway_official: 4,
    api_official: 5,
  };
  return (rank[conf] ?? 1) / 5;
}

// ─────────────────────────────────────────────────────────────
// Generation scoring — "latest in its family"
//
// Groups models by (provider, family-root) and assigns a score
// based on how close each model's parsed version is to the
// newest version in the group.
//
// family-root is derived from the model's `family` field when
// available, otherwise falls back to the modelId prefix before
// the first digit. E.g.:
//   claude-opus-4-6  → family "claude-opus"
//   gpt-5.4          → family-root "gpt" (no family field)
//   gemini-2.5-pro   → family "gemini"
// ─────────────────────────────────────────────────────────────

/**
 * Given the full pool of eligible models, compute a 0–1 generation
 * score per modelId. Latest in family = 1.0, one version behind =
 * 0.6, two behind = 0.3, older = 0.1.
 *
 * Models without a parseable version get 0.5 (neutral) so they
 * aren't punished for IDs like `gpt-4o` or `claude-sonnet-4-5`.
 */
export function computeGenerationScores(models: ModelDoc[]): Map<string, number> {
  const scores = new Map<string, number>();

  // Group by (provider, family-root)
  const groups = new Map<string, ModelDoc[]>();
  for (const m of models) {
    const root = familyRoot(m);
    const key = `${m.provider}::${root}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    // Parse versions for each model in the group
    const parsed = group.map(m => ({
      model: m,
      version: parseVersion(m.modelId),
    }));

    // Find the max version in the group
    const withVersion = parsed.filter(p => p.version !== null);
    if (withVersion.length === 0) {
      // No parseable versions — everyone gets neutral 0.5
      for (const p of parsed) scores.set(p.model.modelId, 0.5);
      continue;
    }

    const maxVersion = withVersion.reduce(
      (acc, p) => (compareVersions(p.version!, acc) > 0 ? p.version! : acc),
      withVersion[0].version!,
    );

    for (const p of parsed) {
      if (!p.version) {
        scores.set(p.model.modelId, 0.5);
        continue;
      }
      const diff = compareVersions(maxVersion, p.version);
      // diff 0 = latest, positive = older
      if (diff === 0) scores.set(p.model.modelId, 1.0);
      else if (diff <= 1) scores.set(p.model.modelId, 0.6);
      else if (diff <= 2) scores.set(p.model.modelId, 0.3);
      else scores.set(p.model.modelId, 0.1);
    }
  }

  return scores;
}

function familyRoot(doc: ModelDoc): string {
  if (doc.family) return doc.family.toLowerCase();
  // Fallback: take everything before the first digit in modelId
  const m = doc.modelId.match(/^([a-z][a-z0-9-]*?)(?=-?\d)/i);
  return (m?.[1] ?? doc.modelId).toLowerCase();
}

// parseVersion — adapted from recommender.ts with one key difference:
// we coalesce hyphen-separated version components (e.g. `claude-opus-4-6`
// → `[4, 6]`) because Anthropic's canonical IDs use `-` between major
// and minor. The recommender doesn't need this — it uses releaseDate as
// its primary ordering — but top100 ranks directly, so a two-component
// version matters for family grouping.
function parseVersion(modelId: string): number[] | null {
  let stripped = modelId
    .replace(/-\d{4}-\d{2}-\d{2}(-[a-z]+)?(:[a-z]+)?$/i, "")
    .replace(/-\d{4}\d{2}\d{2}$/i, "")
    .replace(/-\d{4}-\d{2}$/i, "");
  for (let i = 0; i < 4; i++) {
    const before = stripped;
    stripped = stripped.replace(/-\d+(?:\.\d+)?[bm](?=$|-)/gi, "");
    stripped = stripped.replace(/-\d+x\d+[bm](?=$|-)/gi, "");
    stripped = stripped.replace(/-a\d+[bm](?=$|-)/gi, "");
    if (stripped === before) break;
  }

  // Find the first numeric token, then greedily absorb hyphen-connected
  // trailing numeric tokens as minor versions. Stop at the first non-numeric
  // or at a token that looks like a suffix (letters-first).
  //   claude-opus-4-6         → [4, 6]
  //   claude-sonnet-4-5       → [4, 5]
  //   gpt-5.4                 → [5, 4]
  //   qwen3-max               → [3]
  //   llama-4-70b             → [4]      (70b already stripped above)
  //   gpt-5-turbo             → [5]      (turbo is a suffix, not a version)
  const firstMatch = stripped.match(/(\d+(?:\.\d+)*)/);
  if (!firstMatch) return null;

  let version = firstMatch[1].split(".").map(Number).filter(n => !Number.isNaN(n));
  if (version.length === 0) return null;

  // Greedy tail: walk forward from the match and absorb `-N` groups.
  const tailStart = (firstMatch.index ?? 0) + firstMatch[1].length;
  const tail = stripped.slice(tailStart);
  const tailMatch = tail.match(/^(?:-\d+)+/);
  if (tailMatch) {
    const extraParts = tailMatch[0].slice(1).split("-").map(Number).filter(n => !Number.isNaN(n));
    version = version.concat(extraParts);
  }

  if (version[0] >= 1900) return null;
  if (version[0] > 99) return null;
  return version;
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
