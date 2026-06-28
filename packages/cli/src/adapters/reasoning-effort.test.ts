/**
 * Regression: Claude Code effort → OpenAI reasoning_effort mapping.
 *
 * Claude Code (Opus 4.7/4.8) conveys effort via `output_config.effort` (a string
 * level: none/low/medium/high/xhigh/max). Previously claudish only mapped the
 * legacy `thinking.budget_tokens`, gated to o1/o3 models, so for gpt-5.5 the
 * effort was silently DROPPED (no reasoning_effort reached OpenAI) — and the
 * legacy mapping could emit `minimal`, which gpt-5.x REJECTS.
 *
 * Valid OpenAI reasoning_effort values for gpt-5.x (verified against the live
 * API): none | low | medium | high | xhigh. (minimal and max are rejected.)
 */

import { describe, expect, test } from "bun:test";
import { OpenAIAPIFormat } from "./openai-api-format.js";

function reasoningEffortFor(modelId: string, effort: string): string | undefined {
  const fmt = new OpenAIAPIFormat(modelId);
  const req: any = { output_config: { effort }, max_tokens: 100, temperature: 1 };
  // buildChatCompletionsPayload is the ComposedHandler path that sets the field.
  const payload = (fmt as any).buildChatCompletionsPayload(req, [], []);
  return payload.reasoning_effort;
}

describe("output_config.effort → reasoning_effort (gpt-5.5)", () => {
  test.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"], // gpt-5.5 supports xhigh — must pass through, not clamp to high
    ["none", "none"],
    ["minimal", "low"], // gpt-5.5 REJECTS "minimal" → map to "low"
    ["max", "xhigh"], // gpt-5.5 REJECTS "max" → xhigh is the ceiling
  ])("effort '%s' → reasoning_effort '%s'", (input, expected) => {
    expect(reasoningEffortFor("gpt-5.5-2026-04-23", input)).toBe(expected);
  });

  test("the bare rolling gpt-5.5 alias maps effort too", () => {
    expect(reasoningEffortFor("gpt-5.5", "xhigh")).toBe("xhigh");
  });

  test("o-series models still map effort", () => {
    expect(reasoningEffortFor("o3-mini", "high")).toBe("high");
  });

  test("legacy thinking.budget_tokens still maps (no minimal — gpt-5.x rejects it)", () => {
    const fmt = new OpenAIAPIFormat("gpt-5.5");
    const low = (fmt as any).buildChatCompletionsPayload(
      { thinking: { budget_tokens: 2000 }, max_tokens: 100 },
      [],
      []
    );
    expect(low.reasoning_effort).toBe("low"); // never "minimal"
    const high = (fmt as any).buildChatCompletionsPayload(
      { thinking: { budget_tokens: 40000 }, max_tokens: 100 },
      [],
      []
    );
    expect(high.reasoning_effort).toBe("high");
  });

  test("non-reasoning model (gpt-4-turbo) does NOT get reasoning_effort", () => {
    expect(reasoningEffortFor("gpt-4-turbo", "high")).toBeUndefined();
  });

  test("no effort signal → no reasoning_effort set", () => {
    const fmt = new OpenAIAPIFormat("gpt-5.5");
    const payload = (fmt as any).buildChatCompletionsPayload({ max_tokens: 100 }, [], []);
    expect(payload.reasoning_effort).toBeUndefined();
  });
});
