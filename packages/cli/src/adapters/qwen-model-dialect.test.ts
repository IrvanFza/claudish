import { describe, expect, test } from "bun:test";
import { EFFORT_LEVELS, type EffortLevel } from "./base-api-format.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";

interface PreparedQwenRequest {
  enable_thinking?: boolean;
  reasoning_effort?: string;
  thinking?: unknown;
  thinking_budget?: number;
}

function prepareWithIncomingReasoningEffort(effort: EffortLevel): PreparedQwenRequest {
  return new QwenModelDialect("qwen3.7-plus").prepareRequest(
    { messages: [], reasoning_effort: "high" },
    { output_config: { effort }, messages: [] }
  );
}

describe("QwenModelDialect reasoning request cleanup", () => {
  test("removes incoming reasoning_effort when enabling thinking with a budget", () => {
    const cases = [
      { effort: "high", thinkingBudget: 24576 },
      { effort: "medium", thinkingBudget: 8192 },
    ] as const;

    for (const { effort, thinkingBudget } of cases) {
      const out = prepareWithIncomingReasoningEffort(effort);

      expect(out.reasoning_effort).toBeUndefined();
      expect(out.enable_thinking).toBe(true);
      expect(out.thinking_budget).toBe(thinkingBudget);
      expect(typeof out.thinking_budget).toBe("number");
    }
  });

  test("removes incoming reasoning_effort when disabling thinking without a budget", () => {
    for (const effort of ["minimal", "none"] as const) {
      const out = prepareWithIncomingReasoningEffort(effort);

      expect(out.reasoning_effort).toBeUndefined();
      expect(out.enable_thinking).toBe(false);
      expect(out.thinking_budget).toBeUndefined();
    }
  });

  test("never sends reasoning_effort together with thinking_budget at any supported effort", () => {
    for (const effort of EFFORT_LEVELS) {
      const out = prepareWithIncomingReasoningEffort(effort);

      // DashScope hard-400s this exact pair; it does not silently ignore either field.
      expect(!(out.reasoning_effort !== undefined && out.thinking_budget !== undefined)).toBe(true);
    }
  });

  test("still removes a raw thinking object from the prepared request", () => {
    const rawThinking = { budget_tokens: 4096, type: "enabled" };
    const out = new QwenModelDialect("qwen3.7-plus").prepareRequest(
      { messages: [], thinking: rawThinking },
      { messages: [], output_config: { effort: "high" }, thinking: rawThinking }
    );

    expect(out.thinking).toBeUndefined();
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBe(24576);
  });
});
