import { describe, expect, test } from "bun:test";
import { CODE_ASSIST_FALLBACK_CHAIN, rankCodeAssistModel } from "./gemini-oauth.js";

describe("rankCodeAssistModel", () => {
  test("orders pro before flash before flash-lite", () => {
    const pro = rankCodeAssistModel("gemini-2.5-pro");
    const flash = rankCodeAssistModel("gemini-2.5-flash");
    const flashLite = rankCodeAssistModel("gemini-2.5-flash-lite");

    expect(pro).toBeLessThan(flash);
    expect(flash).toBeLessThan(flashLite);
  });

  test("prefers newer versions within the same tier", () => {
    expect(rankCodeAssistModel("gemini-3.1-pro")).toBeLessThan(
      rankCodeAssistModel("gemini-2.5-pro")
    );
    expect(rankCodeAssistModel("gemini-3.1-flash-lite")).toBeLessThan(
      rankCodeAssistModel("gemini-2.5-flash-lite")
    );
  });

  test("detects flash-lite as lite rather than plain flash", () => {
    const flash = rankCodeAssistModel("gemini-2.5-flash");
    const flashLite = rankCodeAssistModel("gemini-2.5-flash-lite");

    expect(flashLite).not.toBe(flash);
    expect(flashLite).toBeGreaterThan(flash);
  });

  test("does not treat a date suffix as a model version", () => {
    const concreteModels = [
      "gemini-3.1-pro",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
    ];
    const unknownRank = rankCodeAssistModel("gemini-exp-1206");

    for (const model of concreteModels) {
      expect(unknownRank).toBeGreaterThan(rankCodeAssistModel(model));
    }
  });

  test("sorts the fallback chain by tier and then newest version", () => {
    const sorted = CODE_ASSIST_FALLBACK_CHAIN.slice().sort(
      (a, b) => rankCodeAssistModel(a) - rankCodeAssistModel(b)
    );

    expect(sorted).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
    ]);
  });
});
