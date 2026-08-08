import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSavings, readSessionStats } from "./session-stats.js";

let tempDir: string;
let tokenFile: string;
let previousTokenFile: string | undefined;

beforeEach(() => {
  previousTokenFile = process.env.CLAUDISH_TOKEN_FILE;
  tempDir = mkdtempSync(join(tmpdir(), "claudish-session-stats-"));
  tokenFile = join(tempDir, "tokens.json");
  process.env.CLAUDISH_TOKEN_FILE = tokenFile;
});

afterEach(() => {
  if (previousTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
  else process.env.CLAUDISH_TOKEN_FILE = previousTokenFile;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTokenFile(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    tokenFile,
    JSON.stringify({
      input_tokens: 100_000,
      output_tokens: 20_000,
      total_tokens: 120_000,
      total_cost: 0.75,
      input_per_m: 2,
      output_per_m: 10,
      started_at: 1_000,
      updated_at: 6_000,
      provider_name: "test-provider",
      model_name: "test-model",
      context_window: 200_000,
      ...overrides,
    })
  );
}

describe("readSessionStats", () => {
  test("returns null for a missing, unparseable, or tokenless file", () => {
    expect(readSessionStats(65_000)).toBeNull();

    writeFileSync(tokenFile, "not json");
    expect(readSessionStats(65_000)).toBeNull();

    writeTokenFile({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    expect(readSessionStats(65_000)).toBeNull();
  });

  test("treats the literal unknown context window as unavailable, not NaN", () => {
    writeTokenFile({ context_window: "unknown" });

    const stats = readSessionStats(65_000);
    expect(stats?.contextWindow).toBeNull();
    expect(stats?.contextUsed).toBeNull();
  });

  test("never reports a negative duration when timestamps are equal or reversed", () => {
    for (const updatedAt of [1_000, 999]) {
      writeTokenFile({ started_at: 1_000, updated_at: updatedAt });
      expect(readSessionStats(65_000)?.durationMs).toBe(0);
    }
  });

  test("rescales the published-rate split onto the authoritative billed total", () => {
    writeTokenFile({
      billed_input_tokens: 1_000_000,
      input_tokens: 10_000,
      output_tokens: 1_000_000,
      total_cost: 7,
      input_per_m: 1,
      output_per_m: 1,
    });

    const stats = readSessionStats(65_000)!;
    expect(stats.inputCostUsd + stats.outputCostUsd).toBeCloseTo(stats.costUsd, 12);
    expect(stats.inputCostUsd).toBeCloseTo(3.5, 12);
    expect(stats.outputCostUsd).toBeCloseTo(3.5, 12);
  });

  test("uses a zero cost split when rates are absent or the billed cost is zero", () => {
    writeTokenFile({ input_per_m: undefined, output_per_m: undefined, total_cost: 4 });
    let stats = readSessionStats(65_000)!;
    expect(stats.inputCostUsd).toBe(0);
    expect(stats.outputCostUsd).toBe(0);

    writeTokenFile({ total_cost: 0, input_per_m: 2, output_per_m: 10 });
    stats = readSessionStats(65_000)!;
    expect(stats.inputCostUsd).toBe(0);
    expect(stats.outputCostUsd).toBe(0);
  });

  test("prefers billed input tokens and falls back for older token files", () => {
    writeTokenFile({ input_tokens: 10_000, billed_input_tokens: 90_000 });
    expect(readSessionStats(65_000)?.billedInputTokens).toBe(90_000);

    writeTokenFile({ input_tokens: 10_000 });
    expect(readSessionStats(65_000)?.billedInputTokens).toBe(10_000);
  });

  test("computes savings from cumulative billed input, not the final context size", () => {
    const currentInput = 100_000;
    const billedInput = 1_000_000;
    const output = 1;
    writeTokenFile({
      input_tokens: currentInput,
      billed_input_tokens: billedInput,
      output_tokens: output,
      total_cost: 0.25,
    });

    const stats = readSessionStats(65_000)!;
    if (stats.savings.length === 0) return;

    const billedBasis = computeSavings(billedInput, output, stats.costUsd);
    const currentContextBasis = computeSavings(currentInput, output, stats.costUsd);
    expect(stats.savings).toHaveLength(billedBasis.length);
    for (let i = 0; i < stats.savings.length; i++) {
      expect(stats.savings[i]!.baselineUsd).toBeCloseTo(billedBasis[i]!.baselineUsd, 12);
      expect(stats.savings[i]!.baselineUsd).not.toBeCloseTo(
        currentContextBasis[i]!.baselineUsd,
        12
      );
    }
  });

  test("drops invalid tool calls and totals only surviving entries", () => {
    writeTokenFile({
      tool_calls: [
        { name: "Read", count: 3 },
        { name: "Write", count: 2 },
        { name: 42, count: 9 },
        { name: "Zero", count: 0 },
        { name: "Negative", count: -1 },
        { name: "String count", count: "4" },
      ],
    });

    const stats = readSessionStats(65_000)!;
    expect(stats.toolCalls).toEqual([
      { name: "Read", count: 3 },
      { name: "Write", count: 2 },
    ]);
    expect(stats.toolCallTotal).toBe(5);
  });
});

describe("computeSavings", () => {
  test("preserves the sign and exact baseline-minus-actual arithmetic", () => {
    const savings = computeSavings(1, 1, 1_000_000);
    if (savings.length === 0) return;

    for (const saving of savings) {
      expect(saving.savedUsd).toBeCloseTo(saving.baselineUsd - 1_000_000, 12);
      expect(saving.savedUsd).toBeLessThan(0);
    }
  });
});
