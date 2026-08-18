import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SlimModelEntry } from "./all-models-cache.js";
import {
  _resetCatalogClient,
  _setCatalogEntriesForTest,
  getCatalogEntries,
  latestOpusModelId,
} from "./catalog-client.js";

function catalogEntry(modelId: string, releaseDate?: string): SlimModelEntry {
  return {
    modelId,
    aliases: [],
    sources: { test: { externalId: modelId } },
    ...(releaseDate === undefined ? {} : { releaseDate }),
  };
}

beforeEach(() => {
  _resetCatalogClient();
});

afterEach(() => {
  _resetCatalogClient();
});

describe("latestOpusModelId", () => {
  test("newest releaseDate wins regardless of catalog order", () => {
    const older = catalogEntry("claude-opus-4-8", "2025-11-24");
    const newest = catalogEntry("claude-opus-5", "2026-08-01");

    for (const entries of [
      [older, newest],
      [newest, older],
    ]) {
      _setCatalogEntriesForTest(entries);
      expect(latestOpusModelId()).toBe("claude-opus-5");
    }
  });

  test("same releaseDate prefers the id without the -fast suffix", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-5-fast", "2026-08-01"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-5");
  });

  test("ignores non-Opus entries", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-sonnet-5", "2027-01-01"),
      catalogEntry("gpt-5.6-luna", "2027-01-02"),
      catalogEntry("claude-opus-4-8", "2025-11-24"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-4-8");

    _setCatalogEntriesForTest([
      catalogEntry("claude-sonnet-5", "2027-01-01"),
      catalogEntry("gpt-5.6-luna", "2027-01-02"),
    ]);
    expect(latestOpusModelId()).toBeNull();
  });

  test("undated entries do not crash or outrank a dated entry", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-99"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-5");
  });

  test("a cold catalog returns null", () => {
    _setCatalogEntriesForTest(null);

    expect(getCatalogEntries()).toBeNull();
    expect(latestOpusModelId()).toBeNull();
    expect(latestOpusModelId() ?? "claude-opus-5").toBe("claude-opus-5");
  });

  test("never resurrects the dead hardcoded claude-opus-4-1 default", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-4-5", "2025-08-05"),
      catalogEntry("claude-opus-4-8", "2025-11-24"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    // `claude-opus-4-1` is 404 on the live API and was the hardcoded default
    // that broke the native probe. It must not appear when the catalog omits it.
    const selected = latestOpusModelId();
    expect(selected).toBe("claude-opus-5");
    expect(selected).not.toBe("claude-opus-4-1");
  });
});
