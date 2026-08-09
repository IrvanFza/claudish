import { describe, expect, test } from "bun:test";
import { MODEL_CHAIN_SEPARATOR, parseModelChain, parseModelSpec } from "./model-parser.js";

describe("parseModelChain", () => {
  test("splits a chain in order", () => {
    expect(parseModelChain("zgo@a+mm@b+or@v/c")).toEqual(["zgo@a", "mm@b", "or@v/c"]);
  });

  test("returns a one-element array for a plain spec", () => {
    expect(parseModelChain("gc@glm-5.2")).toEqual(["gc@glm-5.2"]);
  });

  test("trims separator whitespace and drops empty segments", () => {
    expect(parseModelChain(" zgo@a + mm@b + or@v/c ")).toEqual(["zgo@a", "mm@b", "or@v/c"]);
    expect(parseModelChain("a++b")).toEqual(["a", "b"]);
    expect(parseModelChain("a+")).toEqual(["a"]);
  });

  test("falls back to the original value when only separators remain", () => {
    expect(parseModelChain("+")).toEqual(["+"]);
    expect(parseModelChain("++")).toEqual(["++"]);
  });

  test("keeps every candidate in a realistic pinned chain explicit", () => {
    const chain = parseModelChain("zgo@minimax-m2.5+mm@MiniMax-M2.5+or@minimax/minimax-m2.5");

    expect(chain).toHaveLength(3);
    expect(chain.every((spec) => parseModelSpec(spec).isExplicitProvider)).toBe(true);
  });
});

describe("MODEL_CHAIN_SEPARATOR", () => {
  test("uses plus rather than the advisor/team list separator", () => {
    expect(MODEL_CHAIN_SEPARATOR).toBe("+");
    expect(MODEL_CHAIN_SEPARATOR).not.toBe(",");
  });
});
