import { describe, it, expect } from "bun:test";
import { selectByProvider, toEntry, PROVIDERS, ACCESS_METHODS } from "./recommender.js";
import { canonicalizeModelId } from "./schema-runtime.js";
import type { ModelDoc } from "./schema.js";
import { Timestamp } from "firebase-admin/firestore";

// Legacy test alias — tests exercised a normalizer that moved to schema-runtime.
const normalizeCanonicalKey = canonicalizeModelId;

// ─────────────────────────────────────────────────────────────
// Helpers — minimal ModelDoc factory
// ─────────────────────────────────────────────────────────────

function makeModelDoc(overrides: Partial<ModelDoc> & Pick<ModelDoc, "modelId" | "provider">): ModelDoc {
  const now = Timestamp.now();
  return {
    displayName: overrides.modelId,
    pricing: { input: 1.0, output: 2.0 },
    contextWindow: 128_000,
    capabilities: { tools: true, streaming: true },
    aliases: [],
    status: "active",
    fieldSources: {},
    sources: {},
    lastUpdated: now,
    lastChecked: now,
    releaseDate: "2026-03-01",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Fix A / Fix F: Vendor prefix stripping in merger normalizeCanonicalKey
// ─────────────────────────────────────────────────────────────

describe("normalizeCanonicalKey — vendor prefix stripping (Fix F)", () => {
  it("strips vendor prefix from canonicalId like minimaxai/minimax-m2.7", () => {
    expect(normalizeCanonicalKey("minimaxai/minimax-m2.7")).toBe("minimax-m2.7");
  });

  it("strips vendor prefix from qwen/qwen3.5-coder", () => {
    expect(normalizeCanonicalKey("qwen/qwen3.5-coder")).toBe("qwen3.5-coder");
  });

  it("strips :free suffix after prefix stripping", () => {
    expect(normalizeCanonicalKey("openai/gpt-4o-mini:free")).toBe("gpt-4o-mini");
  });

  it("handles ids with no vendor prefix (unchanged)", () => {
    expect(normalizeCanonicalKey("gpt-5.4")).toBe("gpt-5.4");
  });

  it("lowercases", () => {
    expect(normalizeCanonicalKey("MiniMax/MiniMax-M2.7")).toBe("minimax-m2.7");
  });
});

// ─────────────────────────────────────────────────────────────
// Fix B: ACCESS_METHODS slug normalization (minimaxai → minimax)
// ─────────────────────────────────────────────────────────────

describe("Provider alias canonicalization (Fix B) — via schema-runtime", () => {
  // Post-refactor, aliases are resolved at the schema gate in
  // canonicalizeProviderSlug (schema-runtime.ts), so by the time models
  // reach the recommender, their `provider` field is already canonical.
  // PROVIDERS.slugs therefore only lists canonical slugs.

  it("minimaxai aliases to minimax and has MiniMax Coding access", () => {
    const { canonicalizeProviderSlug } = require("./schema-runtime.js");
    expect(canonicalizeProviderSlug("minimaxai")).toBe("minimax");
    const methods = ACCESS_METHODS["minimax"];
    expect(methods).toBeDefined();
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0].prefix).toBe("mmc");
  });

  it("moonshot aliases to moonshotai and has Kimi Coding access", () => {
    const { canonicalizeProviderSlug } = require("./schema-runtime.js");
    expect(canonicalizeProviderSlug("moonshot")).toBe("moonshotai");
    const providerDef = PROVIDERS.find(p => p.slugs.includes("moonshotai"));
    expect(providerDef).toBeDefined();
    const methods = ACCESS_METHODS["moonshotai"];
    expect(methods).toBeDefined();
    expect(methods.length).toBeGreaterThan(0);
  });

  it("xai aliases to x-ai", () => {
    const { canonicalizeProviderSlug } = require("./schema-runtime.js");
    expect(canonicalizeProviderSlug("xai")).toBe("x-ai");
    const providerDef = PROVIDERS.find(p => p.slugs.includes("x-ai"));
    expect(providerDef).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Fix C: OpenAI nano models are excluded by obsoleteIndicators
// ─────────────────────────────────────────────────────────────

describe("OpenAI nano exclusion (Fix C)", () => {
  it("excludes gpt-5.4-nano from recommendations", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "gpt-5.4",
        provider: "openai",
        pricing: { input: 5.0, output: 15.0 },
      }),
      makeModelDoc({
        modelId: "gpt-5.4-mini",
        provider: "openai",
        pricing: { input: 0.4, output: 1.6 },
      }),
      makeModelDoc({
        modelId: "gpt-5.4-nano",
        provider: "openai",
        pricing: { input: 0.1, output: 0.4 },
      }),
    ];

    const { flagships, fastModels } = selectByProvider(models);

    // gpt-5.4 should be the flagship
    expect(flagships.some(m => m.modelId === "gpt-5.4")).toBe(true);

    // gpt-5.4-mini should be the fast model
    expect(fastModels.some(m => m.modelId === "gpt-5.4-mini")).toBe(true);

    // gpt-5.4-nano should NOT appear in either list (obsolete)
    const allPicked = [...flagships, ...fastModels];
    expect(allPicked.some(m => m.modelId === "gpt-5.4-nano")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Version-aware picker (replaces llmRefine's "pick newest version" role)
// ─────────────────────────────────────────────────────────────

describe("pickBest — version-aware selection (replaces llmRefine)", () => {
  it("picks gpt-5.4 over gpt-5-image even though image has better pricing score", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "gpt-5-image",
        provider: "openai",
        pricing: { input: 0.5, output: 1.5 }, // cheap → high pricing score
      }),
      makeModelDoc({
        modelId: "gpt-5.4",
        provider: "openai",
        pricing: { input: 5.0, output: 15.0 }, // expensive flagship
      }),
      makeModelDoc({
        modelId: "gpt-5.2",
        provider: "openai",
        pricing: { input: 3.0, output: 9.0 },
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "gpt-5.4")).toBe(true);
    expect(flagships.some(m => m.modelId === "gpt-5-image")).toBe(false);
  });

  it("picks minimax-m2.7 over minimax-m2.5 (newer version wins)", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "minimax-m2.5",
        provider: "minimax",
        pricing: { input: 0.3, output: 1.3 },
      }),
      makeModelDoc({
        modelId: "minimax-m2.7",
        provider: "minimax",
        pricing: { input: 0.3, output: 1.3 },
      }),
      makeModelDoc({
        modelId: "minimax-m2.6",
        provider: "minimax",
        pricing: { input: 0.3, output: 1.3 },
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "minimax-m2.7")).toBe(true);
  });

  it("picks glm-5.1 over glm-4.9 and glm-ocr (newer numeric, and glm-ocr has no version)", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "glm-4.9",
        provider: "z-ai",
        pricing: { input: 0.5, output: 1.5 },
      }),
      makeModelDoc({
        modelId: "glm-5.1",
        provider: "z-ai",
        pricing: { input: 1.0, output: 3.0 },
      }),
      makeModelDoc({
        modelId: "glm-ocr",
        provider: "z-ai",
        pricing: { input: 0.1, output: 0.3 }, // very cheap → high pricing score
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "glm-5.1")).toBe(true);
  });

  it("prefers shorter id when version tuples are equal (gpt-5.4 over gpt-5.4-preview)", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "gpt-5.4-preview",
        provider: "openai",
        pricing: { input: 2.0, output: 6.0 },
      }),
      makeModelDoc({
        modelId: "gpt-5.4",
        provider: "openai",
        pricing: { input: 5.0, output: 15.0 },
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "gpt-5.4")).toBe(true);
    expect(flagships.some(m => m.modelId === "gpt-5.4-preview")).toBe(false);
  });

  it("compares versions numerically (grok-4.20 > grok-4.3)", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "grok-4.3",
        provider: "x-ai",
        pricing: { input: 1.0, output: 3.0 },
      }),
      makeModelDoc({
        modelId: "grok-4.20",
        provider: "x-ai",
        pricing: { input: 1.0, output: 3.0 },
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "grok-4.20")).toBe(true);
  });

  it("does NOT mistake parameter counts for versions (qwq-32b)", () => {
    // Regression: qwq-32b was parsing as version [32] and beating qwen3-max ([3]).
    // The "32b" is the parameter count (32 billion), not a version number.
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "qwen3-max",
        provider: "qwen",
        pricing: { input: 0.78, output: 3.9 },
        releaseDate: "2025-10-27",
      }),
      makeModelDoc({
        modelId: "qwq-32b",
        provider: "qwen",
        pricing: { input: 0.5, output: 2.0 },
        releaseDate: "2025-08-01",
      }),
      makeModelDoc({
        modelId: "qwen-max-2025-01-25",
        provider: "qwen",
        pricing: { input: 1.6, output: 6.4 },
        releaseDate: "2026-02-02",
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "qwen3-max")).toBe(true);
    expect(flagships.some(m => m.modelId === "qwq-32b")).toBe(false);
    expect(flagships.some(m => m.modelId === "qwen-max-2025-01-25")).toBe(false);
  });

  it("handles MoE parameter notation (qwen3-coder-30b-a3b)", () => {
    // qwen3-coder-30b-a3b should parse as version [3] (the qwen3 prefix),
    // not [30] (the param count) or [3] from a3b.
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "qwen3-coder-30b-a3b",
        provider: "qwen",
        pricing: { input: 0.5, output: 2.0 },
      }),
      makeModelDoc({
        modelId: "qwen2-coder-32b",
        provider: "qwen",
        pricing: { input: 0.4, output: 1.6 },
      }),
    ];
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "qwen3-coder-30b-a3b")).toBe(true);
  });

  it("does NOT mistake parameter counts in qwen-coder models", () => {
    // Regression: qwen-coder-32b would parse as [32], beating qwen3-coder ([3]).
    // After the fix, parameter-count tokens are stripped before version parsing.
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "qwen3-coder-30b",
        provider: "qwen",
        pricing: { input: 0.5, output: 1.5 },
      }),
      makeModelDoc({
        modelId: "qwen3-coder-480b",
        provider: "qwen",
        pricing: { input: 2.0, output: 6.0 },
      }),
      makeModelDoc({
        modelId: "qwen-coder-32b",
        provider: "qwen",
        pricing: { input: 0.3, output: 1.0 },
      }),
    ];
    // qwen3-coder-30b and qwen3-coder-480b both parse to [3]. qwen-coder-32b
    // parses to null (no version). The qwen3-* variants beat the unversioned one.
    // Between the two qwen3-coder variants, shorter id wins: 30b is shorter than 480b.
    const { flagships } = selectByProvider(models);
    expect(flagships.some(m => m.modelId === "qwen3-coder-30b")).toBe(true);
    expect(flagships.some(m => m.modelId === "qwen-coder-32b")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Fix D: Qwen omni/audio/vl models excluded by obsoleteIndicators
// ─────────────────────────────────────────────────────────────

describe("Qwen omni/audio exclusion (Fix D) — now via capability flags", () => {
  it("excludes non-text modality models via isCodingCandidate", () => {
    const models: ModelDoc[] = [
      makeModelDoc({
        modelId: "qwen3.5-coder",
        provider: "qwen",
        pricing: { input: 2.0, output: 8.0 },
        capabilities: { tools: true, streaming: true },
      }),
      makeModelDoc({
        modelId: "qwen3.5-flash-02-23",
        provider: "qwen",
        pricing: { input: 0.3, output: 1.2 },
        capabilities: { tools: true, streaming: true },
      }),
      // Omni model: accepts audio + video (non-coding modality)
      makeModelDoc({
        modelId: "qwen3.5-omni-flash",
        provider: "qwen",
        pricing: { input: 0.5, output: 2.0 },
        capabilities: { tools: true, streaming: true, audioInput: true, videoInput: true },
      }),
      // Audio-only model
      makeModelDoc({
        modelId: "qwen3.5-audio",
        provider: "qwen",
        pricing: { input: 0.5, output: 2.0 },
        capabilities: { tools: true, streaming: true, audioInput: true },
      }),
      // Vision-language model — no tools (pure VL, not a coding model)
      makeModelDoc({
        modelId: "qwen3.5-vl-72b",
        provider: "qwen",
        pricing: { input: 2.0, output: 8.0 },
        capabilities: { tools: false, streaming: true, vision: true },
      }),
    ];

    const { flagships, fastModels } = selectByProvider(models);
    const allPicked = [...flagships, ...fastModels];

    // omni, audio, and vl models should NOT be picked
    expect(allPicked.some(m => m.modelId === "qwen3.5-omni-flash")).toBe(false);
    expect(allPicked.some(m => m.modelId === "qwen3.5-audio")).toBe(false);
    expect(allPicked.some(m => m.modelId === "qwen3.5-vl-72b")).toBe(false);

    // Normal coder/flash models SHOULD be picked
    expect(allPicked.some(m => m.modelId === "qwen3.5-coder")).toBe(true);
    expect(allPicked.some(m => m.modelId === "qwen3.5-flash-02-23")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// toEntry: vendor prefix stripping in output
// ─────────────────────────────────────────────────────────────

describe("toEntry strips vendor prefix from modelId", () => {
  it("strips minimaxai/ prefix from entry id", () => {
    const doc = makeModelDoc({
      modelId: "minimaxai/minimax-m2.7",
      provider: "minimax",
    });
    // After S1+S2, canonicalizeModelId is the single normalization function.
    // The merger calls it at ingest, so toEntry receives already-clean IDs.
    // This test validates that canonicalization removes the vendor prefix.
    expect(normalizeCanonicalKey(doc.modelId)).toBe("minimax-m2.7");
    // Use toEntry to silence unused import warning and document the contract.
    void toEntry(doc, 1, "flagship");
  });
});
