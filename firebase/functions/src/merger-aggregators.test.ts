import { describe, it, expect } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  buildSourcesMap,
  buildAggregatorsList,
  COLLECTOR_TO_PROVIDER,
} from "./merger.js";
import type {
  RawModel,
  ModelDoc,
  ConfidenceTier,
  SourceRecord,
} from "./schema.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawModel> & Pick<RawModel, "collectorId" | "externalId" | "confidence">): RawModel {
  return {
    sourceUrl: `https://example.test/${overrides.collectorId}`,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SourceRecord> & Pick<SourceRecord, "externalId" | "confidence">): SourceRecord {
  return {
    lastSeen: Timestamp.now(),
    sourceUrl: "https://example.test/record",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Case 1: Empty raws → empty aggregators
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — empty", () => {
  it("returns an empty array when sources is empty", () => {
    const sources: ModelDoc["sources"] = {};
    const result = buildAggregatorsList(sources);
    expect(result).toEqual([]);
  });

  it("returns empty aggregators when raws are empty", () => {
    const sourcesMap = buildSourcesMap([]);
    expect(sourcesMap).toEqual({});
    expect(buildAggregatorsList(sourcesMap)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Case 2: Single openrouter-api source → 1 aggregator entry
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — single openrouter source", () => {
  it("produces one aggregator entry with provider='openrouter'", () => {
    const raws: RawModel[] = [
      makeRaw({
        collectorId: "openrouter-api",
        externalId: "qwen/qwen3-coder",
        confidence: "aggregator_reported",
      }),
    ];
    const sources = buildSourcesMap(raws);
    const aggregators = buildAggregatorsList(sources);

    expect(aggregators).toHaveLength(1);
    expect(aggregators[0]).toEqual({
      provider: "openrouter",
      externalId: "qwen/qwen3-coder",
      confidence: "aggregator_reported",
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Case 3: Multiple aggregators → openrouter + fireworks + together-ai
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — multiple aggregators", () => {
  it("produces 3 entries for openrouter + fireworks + together-ai", () => {
    const raws: RawModel[] = [
      makeRaw({
        collectorId: "openrouter-api",
        externalId: "qwen/qwen3-coder",
        confidence: "aggregator_reported",
      }),
      makeRaw({
        collectorId: "fireworks-api",
        externalId: "accounts/fireworks/models/qwen3-coder",
        confidence: "aggregator_reported",
      }),
      makeRaw({
        collectorId: "together-ai-api",
        externalId: "Qwen/Qwen3-Coder",
        confidence: "aggregator_reported",
      }),
    ];
    const sources = buildSourcesMap(raws);
    const aggregators = buildAggregatorsList(sources);

    expect(aggregators).toHaveLength(3);

    const byProvider = new Map(aggregators.map(a => [a.provider, a]));
    expect(byProvider.get("openrouter")?.externalId).toBe("qwen/qwen3-coder");
    expect(byProvider.get("fireworks")?.externalId).toBe(
      "accounts/fireworks/models/qwen3-coder",
    );
    expect(byProvider.get("together-ai")?.externalId).toBe("Qwen/Qwen3-Coder");
  });
});

// ─────────────────────────────────────────────────────────────
// Case 4: Mix of aggregator + scraper sources → only aggregators included
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — filters out non-routable scraper sources", () => {
  it("omits pricing scraper entries (e.g. qwen-pricing-scrape)", () => {
    const raws: RawModel[] = [
      makeRaw({
        collectorId: "openrouter-api",
        externalId: "qwen/qwen3-coder",
        confidence: "aggregator_reported",
      }),
      makeRaw({
        collectorId: "qwen-pricing-scrape",
        externalId: "qwen3-coder",
        confidence: "scrape_verified",
      }),
      makeRaw({
        collectorId: "anthropic-pricing-scrape",
        externalId: "claude-3-5",
        confidence: "scrape_verified",
      }),
    ];
    const sources = buildSourcesMap(raws);
    const aggregators = buildAggregatorsList(sources);

    // Only the openrouter-api entry survives the filter.
    expect(aggregators).toHaveLength(1);
    expect(aggregators[0].provider).toBe("openrouter");

    // But sources map still contains all three for provenance.
    expect(Object.keys(sources).sort()).toEqual([
      "anthropic-pricing-scrape",
      "openrouter-api",
      "qwen-pricing-scrape",
    ]);
  });

  it("returns empty aggregators when only scraper sources exist", () => {
    const raws: RawModel[] = [
      makeRaw({
        collectorId: "kimi-pricing-scrape",
        externalId: "kimi-k2",
        confidence: "scrape_unverified",
      }),
    ];
    const sources = buildSourcesMap(raws);
    const aggregators = buildAggregatorsList(sources);

    expect(aggregators).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Case 5: Same model from openrouter at different confidences → highest wins
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — confidence tie-break via buildSourcesMap", () => {
  it("reflects the highest-confidence externalId when the same collector reports twice", () => {
    const raws: RawModel[] = [
      // Lower confidence first
      makeRaw({
        collectorId: "openrouter-api",
        externalId: "qwen/qwen3-coder-old",
        confidence: "scrape_unverified",
      }),
      // Higher confidence second
      makeRaw({
        collectorId: "openrouter-api",
        externalId: "qwen/qwen3-coder",
        confidence: "aggregator_reported",
      }),
    ];
    const sources = buildSourcesMap(raws);
    const aggregators = buildAggregatorsList(sources);

    expect(aggregators).toHaveLength(1);
    expect(aggregators[0].provider).toBe("openrouter");
    expect(aggregators[0].externalId).toBe("qwen/qwen3-coder");
    expect(aggregators[0].confidence).toBe("aggregator_reported");
  });
});

// ─────────────────────────────────────────────────────────────
// Case 6: COLLECTOR_TO_PROVIDER exhaustiveness regression test
// ─────────────────────────────────────────────────────────────
describe("COLLECTOR_TO_PROVIDER — exhaustive mapping regression", () => {
  it("every entry in the table maps a collectorId to a non-empty provider", () => {
    for (const [collectorId, provider] of Object.entries(COLLECTOR_TO_PROVIDER)) {
      expect(typeof collectorId).toBe("string");
      expect(collectorId.length).toBeGreaterThan(0);
      expect(typeof provider).toBe("string");
      expect(provider.length).toBeGreaterThan(0);
    }
  });

  it("every entry produces an aggregator with the correct provider when fed through buildAggregatorsList", () => {
    for (const [collectorId, expectedProvider] of Object.entries(COLLECTOR_TO_PROVIDER)) {
      const confidence: ConfidenceTier = "aggregator_reported";
      const sources: ModelDoc["sources"] = {
        [collectorId]: makeRecord({
          externalId: `vendor/${collectorId}-model`,
          confidence,
        }),
      };
      const aggregators = buildAggregatorsList(sources);
      expect(aggregators).toHaveLength(1);
      expect(aggregators[0].provider).toBe(expectedProvider);
      expect(aggregators[0].externalId).toBe(`vendor/${collectorId}-model`);
      expect(aggregators[0].confidence).toBe(confidence);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Case 7: Unknown collectorId → silently skipped
// ─────────────────────────────────────────────────────────────
describe("buildAggregatorsList — unknown collector ignored", () => {
  it("returns no entry for a collectorId not in COLLECTOR_TO_PROVIDER", () => {
    const sources: ModelDoc["sources"] = {
      "made-up-collector": makeRecord({
        externalId: "foo/bar",
        confidence: "aggregator_reported",
      }),
    };
    const aggregators = buildAggregatorsList(sources);
    expect(aggregators).toEqual([]);
  });

  it("skips unknown collectors while preserving known ones", () => {
    const sources: ModelDoc["sources"] = {
      "openrouter-api": makeRecord({
        externalId: "qwen/qwen3-coder",
        confidence: "aggregator_reported",
      }),
      "future-aggregator-api": makeRecord({
        externalId: "future/model",
        confidence: "aggregator_reported",
      }),
    };
    const aggregators = buildAggregatorsList(sources);
    expect(aggregators).toHaveLength(1);
    expect(aggregators[0].provider).toBe("openrouter");
  });
});
