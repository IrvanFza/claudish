import { describe, it, expect } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  PROVIDER_POPULARITY,
  popularityPoints,
  scoreForTop100,
  computeGenerationScores,
} from "./popularity-scores.js";
import type { ModelDoc } from "./schema.js";

// ─────────────────────────────────────────────────────────────
// Test helper — minimal ModelDoc factory
// ─────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelDoc> & Pick<ModelDoc, "modelId" | "provider">): ModelDoc {
  const now = Timestamp.now();
  return {
    displayName: overrides.modelId,
    pricing: { input: 3.0, output: 15.0 },
    contextWindow: 200_000,
    capabilities: { tools: true, streaming: true },
    aliases: [],
    status: "active",
    fieldSources: {
      pricing: {
        collectorId: "test",
        confidence: "api_official",
        fetchedAt: new Date().toISOString(),
      },
    },
    sources: {},
    lastUpdated: now,
    lastChecked: now,
    releaseDate: "2026-03-01", // ~6 weeks before today (2026-04-15)
    ...overrides,
  };
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// popularityPoints — static lookup
// ─────────────────────────────────────────────────────────────

describe("popularityPoints", () => {
  it("returns 100 for anthropic and openai", () => {
    expect(popularityPoints("anthropic")).toBe(100);
    expect(popularityPoints("openai")).toBe(100);
  });

  it("returns 95 for google", () => {
    expect(popularityPoints("google")).toBe(95);
  });

  it("returns the default (40) for unknown providers", () => {
    expect(popularityPoints("some-new-lab")).toBe(40);
    expect(popularityPoints(undefined)).toBe(40);
    expect(popularityPoints(null)).toBe(40);
    expect(popularityPoints("")).toBe(40);
  });

  it("is case-insensitive", () => {
    expect(popularityPoints("ANTHROPIC")).toBe(100);
    expect(popularityPoints("Anthropic")).toBe(100);
  });

  it("scores aggregators below real labs", () => {
    expect(popularityPoints("openrouter")).toBeLessThan(popularityPoints("anthropic"));
    expect(popularityPoints("openrouter")).toBeLessThan(popularityPoints("deepseek"));
  });

  it("covers every canonical provider slug from KNOWN_PROVIDER_SLUGS", () => {
    // Guard against drift: if someone adds a slug to schema-runtime.ts,
    // they must also add it to PROVIDER_POPULARITY.
    const { KNOWN_PROVIDER_SLUGS } = require("./schema-runtime.js");
    const table = PROVIDER_POPULARITY as Record<string, number>;
    for (const slug of KNOWN_PROVIDER_SLUGS) {
      expect(table[slug]).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// scoreForTop100 — composite scoring
// ─────────────────────────────────────────────────────────────

describe("scoreForTop100", () => {
  it("returns a score between 0 and 100", () => {
    const m = makeModel({ modelId: "claude-opus-4-6", provider: "anthropic" });
    const score = scoreForTop100(m, 1.0);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("exposes component breakdown", () => {
    const m = makeModel({ modelId: "claude-opus-4-6", provider: "anthropic" });
    const score = scoreForTop100(m, 1.0);
    expect(score.popularity).toBe(100);
    expect(score.generation).toBe(1.0);
    expect(score.recency).toBeGreaterThan(0);
    expect(score.capabilities).toBeGreaterThan(0);
  });

  it("ranks anthropic flagship above an unknown provider with identical attributes", () => {
    const flagship = makeModel({ modelId: "claude-opus-4-6", provider: "anthropic" });
    const unknown = makeModel({ modelId: "someid", provider: "weird-lab" });
    const a = scoreForTop100(flagship, 1.0).total;
    const b = scoreForTop100(unknown, 1.0).total;
    expect(a).toBeGreaterThan(b);
  });

  it("a brand-new model from a smaller lab can beat an old anthropic model", () => {
    // This is the explicit design goal of the 25% popularity weight: merit-weighted.
    const newDeepseek = makeModel({
      modelId: "deepseek-v4",
      provider: "deepseek",
      releaseDate: daysAgo(10),
      capabilities: { thinking: true, tools: true, vision: true, structuredOutput: true, promptCaching: true },
      contextWindow: 1_000_000,
    });
    const oldClaude = makeModel({
      modelId: "claude-old",
      provider: "anthropic",
      releaseDate: daysAgo(800),
      capabilities: { tools: true },
      contextWindow: 100_000,
    });
    const newScore = scoreForTop100(newDeepseek, 1.0).total;
    const oldScore = scoreForTop100(oldClaude, 0.3).total;
    expect(newScore).toBeGreaterThan(oldScore);
  });

  it("rewards recency — newer releaseDate scores higher", () => {
    const fresh = makeModel({ modelId: "x1", provider: "anthropic", releaseDate: daysAgo(5) });
    const stale = makeModel({ modelId: "x2", provider: "anthropic", releaseDate: daysAgo(800) });
    expect(scoreForTop100(fresh, 1.0).recency).toBeGreaterThan(scoreForTop100(stale, 1.0).recency);
  });

  it("rewards capabilities — thinking+vision scores higher than tools-only", () => {
    const rich = makeModel({
      modelId: "x1",
      provider: "anthropic",
      capabilities: { thinking: true, vision: true, tools: true, structuredOutput: true },
    });
    const basic = makeModel({
      modelId: "x2",
      provider: "anthropic",
      capabilities: { tools: true },
    });
    expect(scoreForTop100(rich, 1.0).capabilities).toBeGreaterThan(
      scoreForTop100(basic, 1.0).capabilities,
    );
  });

  it("rewards larger context windows", () => {
    const large = makeModel({ modelId: "x1", provider: "anthropic", contextWindow: 2_000_000 });
    const small = makeModel({ modelId: "x2", provider: "anthropic", contextWindow: 32_000 });
    expect(scoreForTop100(large, 1.0).context).toBeGreaterThan(
      scoreForTop100(small, 1.0).context,
    );
  });

  it("penalizes old generation within a family", () => {
    const m = makeModel({ modelId: "x1", provider: "anthropic" });
    const latest = scoreForTop100(m, 1.0).total;
    const old = scoreForTop100(m, 0.1).total;
    expect(latest).toBeGreaterThan(old);
  });
});

// ─────────────────────────────────────────────────────────────
// computeGenerationScores — family grouping
// ─────────────────────────────────────────────────────────────

describe("computeGenerationScores", () => {
  it("gives 1.0 to the latest model in a family", () => {
    const models = [
      makeModel({ modelId: "claude-opus-4-6", provider: "anthropic", family: "claude-opus" }),
      makeModel({ modelId: "claude-opus-4-5", provider: "anthropic", family: "claude-opus" }),
      makeModel({ modelId: "claude-opus-4-1", provider: "anthropic", family: "claude-opus" }),
    ];
    const scores = computeGenerationScores(models);
    expect(scores.get("claude-opus-4-6")).toBe(1.0);
    expect(scores.get("claude-opus-4-5")).toBeLessThan(1.0);
    expect(scores.get("claude-opus-4-1")).toBeLessThan(scores.get("claude-opus-4-5")!);
  });

  it("handles 'released long ago but still latest in series' — the design goal", () => {
    // claude-opus-4-6 should still score 1.0 even though its releaseDate is old,
    // as long as it's the newest in its family.
    const models = [
      makeModel({
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        family: "claude-opus",
        releaseDate: daysAgo(240),
      }),
    ];
    const scores = computeGenerationScores(models);
    expect(scores.get("claude-opus-4-6")).toBe(1.0);
  });

  it("groups by provider — same family-root across providers doesn't merge", () => {
    const models = [
      makeModel({ modelId: "llama-4-70b", provider: "meta-llama", family: "llama" }),
      makeModel({ modelId: "llama-3-8b", provider: "meta-llama", family: "llama" }),
      // A hypothetical llama from a different provider shouldn't demote meta's llama
      makeModel({ modelId: "llama-5", provider: "some-fork", family: "llama" }),
    ];
    const scores = computeGenerationScores(models);
    expect(scores.get("llama-4-70b")).toBe(1.0); // latest in meta-llama group
    expect(scores.get("llama-5")).toBe(1.0);     // latest in some-fork group
    expect(scores.get("llama-3-8b")).toBeLessThan(1.0);
  });

  it("assigns neutral 0.5 when no versions are parseable", () => {
    const models = [
      makeModel({ modelId: "magic-model", provider: "anthropic", family: "magic" }),
      makeModel({ modelId: "magic-turbo", provider: "anthropic", family: "magic" }),
    ];
    const scores = computeGenerationScores(models);
    expect(scores.get("magic-model")).toBe(0.5);
    expect(scores.get("magic-turbo")).toBe(0.5);
  });

  it("falls back to modelId prefix when family field is missing", () => {
    const models = [
      makeModel({ modelId: "gpt-5-4", provider: "openai" }),
      makeModel({ modelId: "gpt-4o", provider: "openai" }),
    ];
    const scores = computeGenerationScores(models);
    // Both in "gpt" family-root by prefix fallback; gpt-5 > gpt-4
    expect(scores.get("gpt-5-4")).toBe(1.0);
    expect(scores.get("gpt-4o")).toBeLessThan(1.0);
  });

  it("handles a single model in a family (it's trivially the latest)", () => {
    const models = [
      makeModel({ modelId: "unique-1", provider: "anthropic", family: "unique" }),
    ];
    const scores = computeGenerationScores(models);
    expect(scores.get("unique-1")).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────
// End-to-end ranking sanity — simulate a mini top100
// ─────────────────────────────────────────────────────────────

describe("top100 ranking sanity", () => {
  it("produces a stable ordering where frontier models cluster near the top", () => {
    const pool: ModelDoc[] = [
      makeModel({
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        family: "claude-opus",
        capabilities: { thinking: true, tools: true, vision: true, promptCaching: true },
        contextWindow: 1_000_000,
      }),
      makeModel({
        modelId: "gpt-5-4",
        provider: "openai",
        family: "gpt",
        capabilities: { thinking: true, tools: true, vision: true },
        contextWindow: 400_000,
      }),
      makeModel({
        modelId: "gemini-2-5-pro",
        provider: "google",
        family: "gemini",
        capabilities: { thinking: true, tools: true, vision: true },
        contextWindow: 2_000_000,
      }),
      makeModel({
        modelId: "some-old-thing",
        provider: "openrouter",
        releaseDate: daysAgo(900),
        capabilities: {},
        contextWindow: 8_000,
      }),
    ];

    const genScores = computeGenerationScores(pool);
    const ranked = pool
      .map(m => ({
        id: m.modelId,
        score: scoreForTop100(m, genScores.get(m.modelId) ?? 0.5).total,
      }))
      .sort((a, b) => b.score - a.score);

    // Old aggregator noise should be last
    expect(ranked[ranked.length - 1].id).toBe("some-old-thing");
    // Top 3 should be the frontier models (in some order)
    const top3 = ranked.slice(0, 3).map(r => r.id);
    expect(top3).toContain("claude-opus-4-6");
    expect(top3).toContain("gpt-5-4");
    expect(top3).toContain("gemini-2-5-pro");
  });
});
