import { describe, expect, test } from "bun:test";
import { resolveTargetForCatalog } from "./catalog-client.js";
import { parseModelSpec } from "./model-parser.js";

describe("resolveTargetForCatalog", () => {
  test("rewrites a changed explicit MiniMax spec and returns its resolution", () => {
    const resolution = {
      resolvedId: "MiniMax-M2.5",
      wasResolved: true,
      sourceLabel: "minimax catalog",
    };

    const result = resolveTargetForCatalog(
      "mm@minimax-m2.5",
      true,
      "minimax-m2.5",
      "minimax",
      () => resolution
    );

    expect(result).toEqual({
      target: "minimax@MiniMax-M2.5",
      resolution,
    });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(true);
  });

  test("preserves a bare MiniMax name and never resolves it", () => {
    let resolveCalls = 0;
    const result = resolveTargetForCatalog("minimax-m2.5", false, "minimax-m2.5", "minimax", () => {
      resolveCalls += 1;
      return {
        resolvedId: "MiniMax-M2.5",
        wasResolved: true,
        sourceLabel: "minimax catalog",
      };
    });

    // Rewriting this bare name would yield `minimax@MiniMax-M2.5`, which
    // parseModelSpec reads as an explicit provider and makes proxy-server skip
    // the routing chain. MiniMax is the only measured family whose wire id
    // differs from the typed name, so unaffected passthrough models cannot catch
    // this regression.
    expect(result).toEqual({ target: "minimax-m2.5", resolution: null });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(false);
    expect(resolveCalls).toBe(0);
  });

  test("keeps an unchanged explicit target but returns its resolution", () => {
    const resolution = {
      resolvedId: "glm-5.2",
      wasResolved: false,
      sourceLabel: "passthrough",
    };

    const result = resolveTargetForCatalog("glm@glm-5.2", true, "glm-5.2", "glm", () => resolution);

    expect(result).toEqual({ target: "glm@glm-5.2", resolution });
  });

  for (const [model, provider] of [
    ["glm-5.2", "glm"],
    ["kimi-k2.7", "kimi"],
  ] as const) {
    test(`leaves unaffected ${model} explicit and bare forms unchanged`, () => {
      const passthrough = () => ({
        resolvedId: model,
        wasResolved: false,
        sourceLabel: "passthrough",
      });
      const explicitTarget = `${provider}@${model}`;

      const explicit = resolveTargetForCatalog(explicitTarget, true, model, provider, passthrough);
      const bare = resolveTargetForCatalog(model, false, model, provider, passthrough);

      expect(explicit.target).toBe(explicitTarget);
      expect(explicit.resolution).not.toBeNull();
      expect(bare).toEqual({ target: model, resolution: null });
    });
  }
});
