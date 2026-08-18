import { describe, expect, test } from "bun:test";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { parseModelSpec } from "./model-parser.js";

describe("SWE model routing", () => {
  test("auto-detects bare swe-* names as Devin without marking them explicit", () => {
    for (const modelId of ["swe-1.7", "SWE-1.7", "swe-2"]) {
      const parsed = parseModelSpec(modelId);

      expect(parsed.provider).toBe("devin");
      expect(parsed.isExplicitProvider).toBe(false);
    }
  });

  test("routes swe-* only to Devin with no fallback", () => {
    const routes = DEFAULT_ROUTING_RULES["swe-*"];

    expect(routes).toEqual(["devin"]);
    expect(routes).toHaveLength(1);
  });

  test("never auto-detects Devin's re-served vendor model collisions", () => {
    // Devin re-serves these other vendors' models under colliding UIDs. Auto-detecting
    // a bare name as Devin would let the wrong vendor answer the request.
    for (const modelId of [
      "claude-opus-5-medium",
      "gpt-5-6-luna-medium",
      "glm-5-2",
      "kimi-k3-high",
    ]) {
      expect(parseModelSpec(modelId).provider).not.toBe("devin");
    }
  });

  test("keeps explicit dv@swe-1.7 addressing working", () => {
    const parsed = parseModelSpec("dv@swe-1.7");

    expect(parsed.provider).toBe("devin");
    expect(parsed.model).toBe("swe-1.7");
    expect(parsed.isExplicitProvider).toBe(true);
  });
});
