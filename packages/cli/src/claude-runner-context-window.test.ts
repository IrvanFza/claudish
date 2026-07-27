import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_AUTO_COMPACT_WINDOW, computeMainThreadContextWindow } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const REDUCED_WINDOW_SPEC = "cx@gpt-5.6-sol";
const LARGER_WINDOW_SPEC = "oai@gpt-5.6-sol";
const BELOW_AUTO_COMPACT_FLOOR_SPEC = "cx@small-context-model";

let tmpDir: string;
let mockCachePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudish-main-thread-window-test-"));
  mockCachePath = join(tmpDir, "all-models.json");

  const entries = [
    {
      modelId: "gpt-5.6-sol",
      aliases: [],
      sources: {},
      contextWindow: 1_050_000,
      aggregators: [
        {
          provider: "openai",
          externalId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 1_050_000,
        },
        {
          provider: "openai-codex",
          externalId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 372_000,
        },
        {
          provider: "openrouter",
          externalId: "openai/gpt-5.6-sol",
          confidence: "gateway_official",
        },
      ],
    },
    {
      modelId: "small-context-model",
      aliases: [],
      sources: {},
      contextWindow: 128_000,
      aggregators: [
        {
          provider: "openai-codex",
          externalId: "small-context-model",
          confidence: "api_official",
          contextWindow: 128_000,
        },
      ],
    },
  ];

  writeFileSync(
    mockCachePath,
    JSON.stringify({
      version: 2,
      lastUpdated: new Date().toISOString(),
      entries,
      models: entries.map((entry) => ({ id: entry.modelId })),
    }),
    "utf-8"
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeMainThreadContextWindow", () => {
  test("exposes the Claude Code auto-compaction floor", () => {
    expect(MIN_AUTO_COMPACT_WINDOW).toBe(200_000);
  });

  test("returns a catalog window below the floor so the caller can leave the env unset", async () => {
    const config = { model: BELOW_AUTO_COMPACT_FLOOR_SPEC } as unknown as ClaudishConfig;

    const window = await computeMainThreadContextWindow(config, mockCachePath);

    expect(window).toBe(128_000);
    expect(window).toBeLessThan(MIN_AUTO_COMPACT_WINDOW);
  });

  test("returns the explicit provider's reduced window instead of the top-level window", async () => {
    const config = { model: REDUCED_WINDOW_SPEC } as unknown as ClaudishConfig;

    const window = await computeMainThreadContextWindow(config, mockCachePath);

    expect(window).toBe(372_000);
    expect(window).not.toBe(1_050_000);
  });

  test("returns the minimum eligible window regardless of model assignment order", async () => {
    const reducedFirst = {
      model: REDUCED_WINDOW_SPEC,
      modelSonnet: LARGER_WINDOW_SPEC,
    } as unknown as ClaudishConfig;
    const largerFirst = {
      model: LARGER_WINDOW_SPEC,
      modelSonnet: REDUCED_WINDOW_SPEC,
    } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(reducedFirst, mockCachePath)).toBe(372_000);
    expect(await computeMainThreadContextWindow(largerFirst, mockCachePath)).toBe(372_000);
  });

  test("ignores haiku and subagent windows when computing the main-thread window", async () => {
    const config = {
      model: LARGER_WINDOW_SPEC,
      modelOpus: LARGER_WINDOW_SPEC,
      modelSonnet: LARGER_WINDOW_SPEC,
      modelHaiku: REDUCED_WINDOW_SPEC,
      modelSubagent: REDUCED_WINDOW_SPEC,
    } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(1_050_000);
  });

  test("returns zero when no main-thread model is configured", async () => {
    const config = {} as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(0);
  });

  test("returns zero when an explicit model is absent from the catalog", async () => {
    const config = { model: "cx@unknown-model" } as unknown as ClaudishConfig;

    expect(await computeMainThreadContextWindow(config, mockCachePath)).toBe(0);
  });
});
