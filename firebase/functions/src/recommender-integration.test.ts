import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { Timestamp } from "firebase-admin/firestore";

import { mergeResults } from "./merger.js";
import { selectByProvider, diffRecommendations, isCodingCandidate } from "./recommender.js";
import { validateRawModel, validateRecommendedDoc } from "./schema-runtime.js";
import type { CollectorResult, RawModel, RecommendedModelsDoc } from "./schema.js";

// ─────────────────────────────────────────────────────────────
// Golden fixture integration test
//
// Drives the FULL pipeline (schema gate → merger → selectByProvider →
// diff gate) against a realistic hand-crafted CollectorResult[].
// This replaces the "did we remember the alias" unit tests with a
// whole-pipeline contract test.
// ─────────────────────────────────────────────────────────────

interface FixtureFile {
  results: Array<{
    collectorId: string;
    fetchedAt: string;
    models: unknown[];
  }>;
}

function loadFixture(): CollectorResult[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "test-fixtures", "collector-results-snapshot.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;

  // Mirror BaseCollector.makeResult: validate every raw model through
  // the schema gate. Invalid models are dropped.
  const results: CollectorResult[] = [];
  for (const r of parsed.results) {
    const validated: RawModel[] = [];
    for (const raw of r.models) {
      const result = validateRawModel(raw, r.collectorId);
      if (result.ok) validated.push(result.model);
      else throw new Error(`fixture invalid: ${result.error}`);
    }
    results.push({
      collectorId: r.collectorId,
      models: validated,
      fetchedAt: new Date(r.fetchedAt),
    });
  }
  return results;
}

describe("Recommender integration — golden fixture", () => {
  it("drives the full pipeline end-to-end and produces expected selections", () => {
    const collectorResults = loadFixture();
    const merged = mergeResults(collectorResults);

    // ── Merger canonicalized ids and providers ──────────────────────
    const ids = new Set(merged.map((m) => m.modelId));

    // Vendor-prefixed minimaxai/ ids must be canonical post-schema-gate
    expect(ids.has("minimax-m2.7")).toBe(true);
    expect(ids.has("minimax-m2.5")).toBe(true);

    // No id should contain a slash
    for (const m of merged) {
      expect(m.modelId.includes("/")).toBe(false);
      // No id should retain :free
      expect(m.modelId.endsWith(":free")).toBe(false);
      // All lowercase
      expect(m.modelId).toBe(m.modelId.toLowerCase());
    }

    // Provider canonicalization: minimaxai -> minimax, zhipu -> z-ai,
    // moonshot -> moonshotai, xai -> x-ai (via PROVIDER_ALIAS_MAP)
    const minimaxDoc = merged.find((m) => m.modelId === "minimax-m2.7");
    expect(minimaxDoc?.provider).toBe("minimax");

    const glmDoc = merged.find((m) => m.modelId === "glm-5.1");
    expect(glmDoc?.provider).toBe("z-ai");

    const kimiDoc = merged.find((m) => m.modelId === "kimi-k2.5");
    expect(kimiDoc?.provider).toBe("moonshotai");

    const grokFastDoc = merged.find((m) => m.modelId === "grok-5-fast");
    expect(grokFastDoc?.provider).toBe("x-ai");

    // ── isCodingCandidate drops non-coding modalities ────────────────
    // Realtime (audio), TTS (no tools), omni (audio+video) should be excluded
    const realtime = merged.find((m) => m.modelId === "gpt-realtime-preview");
    expect(realtime).toBeDefined();
    expect(isCodingCandidate(realtime!)).toBe(false);

    const tts = merged.find((m) => m.modelId === "tts-1-hd");
    expect(tts).toBeDefined();
    expect(isCodingCandidate(tts!)).toBe(false);

    const omni = merged.find((m) => m.modelId === "qwen3.5-omni-flash");
    expect(omni).toBeDefined();
    expect(isCodingCandidate(omni!)).toBe(false);

    // Normal coding models pass
    const gpt54 = merged.find((m) => m.modelId === "gpt-5.4");
    expect(gpt54).toBeDefined();
    expect(isCodingCandidate(gpt54!)).toBe(true);

    // ── Run selection ────────────────────────────────────────────────
    const { flagships, fastModels } = selectByProvider(merged);

    const flagIds = new Set(flagships.map((m) => m.modelId));
    const fastIds = new Set(fastModels.map((m) => m.modelId));
    const allPicked = new Set([...flagIds, ...fastIds]);

    // Expected flagships (one per provider covered in fixture)
    expect(flagIds.has("gpt-5.4")).toBe(true);
    expect(flagIds.has("qwen3.6-plus")).toBe(true);
    expect(flagIds.has("minimax-m2.7")).toBe(true);
    expect(flagIds.has("gemini-3.1-pro")).toBe(true);
    expect(flagIds.has("grok-5-latest")).toBe(true);
    expect(flagIds.has("glm-5.1")).toBe(true);
    expect(flagIds.has("kimi-k2.5")).toBe(true);

    // Older minimax-m2.5 must NOT be the MiniMax flagship (m2.7 is newer)
    expect(flagIds.has("minimax-m2.5")).toBe(false);

    // Expected fast picks
    expect(fastIds.has("gpt-5.4-mini")).toBe(true);
    expect(fastIds.has("qwen3.5-flash-02-23")).toBe(true);
    expect(fastIds.has("gemini-3.1-flash")).toBe(true);
    expect(fastIds.has("grok-5-fast")).toBe(true);
    expect(fastIds.has("glm-5.1-flash")).toBe(true);
    expect(fastIds.has("kimi-k2.5-turbo")).toBe(true);

    // Nano MUST NOT appear — it's banned by obsoleteIndicators (/nano/i)
    expect(allPicked.has("gpt-5.4-nano")).toBe(false);

    // Audio / video / TTS / omni / realtime MUST NOT appear
    expect(allPicked.has("gpt-realtime-preview")).toBe(false);
    expect(allPicked.has("tts-1-hd")).toBe(false);
    expect(allPicked.has("qwen3.5-omni-flash")).toBe(false);

    // No picked model has a "/" in its id (post-canonicalization guarantee)
    for (const m of [...flagships, ...fastModels]) {
      expect(m.modelId.includes("/")).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// diffRecommendations unit test — exercises the pre-publish gate
// ─────────────────────────────────────────────────────────────

function makeDoc(models: Array<{ id: string; provider: string; category: string }>): RecommendedModelsDoc {
  return {
    version: "2.0.0",
    lastUpdated: "2026-04-13",
    generatedAt: "2026-04-13T03:00:00.000Z",
    source: "firebase-auto",
    models: models.map((m, i) => ({
      id: m.id,
      openrouterId: `${m.provider}/${m.id}`,
      name: m.id,
      description: `${m.id} model`,
      provider: m.provider,
      category: m.category,
      priority: i + 1,
      pricing: { input: "$1/1M", output: "$2/1M", average: "$1.5/1M" },
      context: "128K",
      maxOutputTokens: null,
      modality: "text->text",
      supportsTools: true,
      supportsReasoning: false,
      supportsVision: false,
      isModerated: false,
      recommended: true as const,
    })),
  };
}

describe("diffRecommendations — pre-publish gate", () => {
  it("passes when new doc is unchanged", () => {
    const doc = makeDoc([
      { id: "gpt-5.4", provider: "openai", category: "programming" },
      { id: "gemini-3.1-pro", provider: "google", category: "programming" },
      { id: "gpt-5.4-mini", provider: "openai", category: "fast" },
    ]);
    const result = diffRecommendations(doc, doc);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes on first run (previous=null)", () => {
    const doc = makeDoc([
      { id: "gpt-5.4", provider: "openai", category: "programming" },
    ]);
    const result = diffRecommendations(null, doc);
    expect(result.ok).toBe(true);
  });

  it("rejects when a provider disappears entirely", () => {
    const prev = makeDoc([
      { id: "gpt-5.4", provider: "openai", category: "programming" },
      { id: "gemini-3.1-pro", provider: "google", category: "programming" },
    ]);
    const next = makeDoc([
      { id: "gpt-5.4", provider: "openai", category: "programming" },
    ]);
    const result = diffRecommendations(prev, next);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("google"))).toBe(true);
  });

  it("rejects when an id contains a slash", () => {
    const next = makeDoc([
      { id: "minimaxai/minimax-m2.7", provider: "minimax", category: "programming" },
      { id: "gpt-5.4", provider: "openai", category: "programming" },
    ]);
    const result = diffRecommendations(null, next);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("/"))).toBe(true);
  });

  it("rejects when total entry count drops >20%", () => {
    const prev = makeDoc(
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        provider: "openai",
        category: "programming",
      })),
    );
    const next = makeDoc([
      { id: "m0", provider: "openai", category: "programming" },
      { id: "m1", provider: "openai", category: "programming" },
      { id: "m2", provider: "openai", category: "programming" },
    ]);
    const result = diffRecommendations(prev, next);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("total entries"))).toBe(true);
  });

  it("rejects when category count drops >30%", () => {
    const prev = makeDoc(
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        provider: "openai",
        category: "fast",
      })),
    );
    const next = makeDoc(
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        provider: "openai",
        category: "fast",
      })).slice(0, 3),
    );
    const result = diffRecommendations(prev, next);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("category"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// validateRecommendedDoc smoke tests
// ─────────────────────────────────────────────────────────────

describe("validateRecommendedDoc", () => {
  it("accepts a valid doc", () => {
    const doc = makeDoc([
      { id: "gpt-5.4", provider: "openai", category: "programming" },
    ]);
    const result = validateRecommendedDoc(doc);
    expect(result.ok).toBe(true);
  });

  it("rejects an id with a slash", () => {
    const doc = makeDoc([
      { id: "openai/gpt-5.4", provider: "openai", category: "programming" },
    ]);
    const result = validateRecommendedDoc(doc);
    expect(result.ok).toBe(false);
  });
});

// Silence unused Timestamp import if TS gets grumpy
void Timestamp;
