import { describe, expect, it } from "bun:test";
import { formatListingPrice } from "./model-loader.js";

const swe17Entry = {
  pricing: { input: "N/A", output: "N/A", average: "N/A" },
  subscription: { prefix: "dv", plan: "Devin", command: "dv@swe-1.7" },
};

const glm53Entry = {
  pricing: { input: "N/A", output: "N/A", average: "N/A" },
};

const claudeCodeSubscription = {
  plan: "Claude Code",
  command: "claude-fable-5",
};

describe("formatListingPrice", () => {
  it("passes through a real rate and preserves FREE and varies normalization", () => {
    expect(formatListingPrice({ pricing: { average: "$1.32/1M" } })).toBe("$1.32/1M");
    expect(formatListingPrice({ pricing: { average: "$0.00/1M" } })).toBe("FREE");
    expect(formatListingPrice({ pricing: { average: "-1000000" } })).toBe("varies");
  });

  it("renders swe-1.7's subscription plan when its rate is unavailable", () => {
    expect(formatListingPrice(swe17Entry)).toBe("SUB (Devin)");
  });

  it("renders compact swe-1.7 pricing as SUB", () => {
    expect(formatListingPrice(swe17Entry, { compact: true })).toBe("SUB");
  });

  it("keeps glm-5.3's unknown price as N/A in both display modes", () => {
    expect(formatListingPrice(glm53Entry)).toBe("N/A");
    expect(formatListingPrice(glm53Entry, { compact: true })).toBe("N/A");
  });

  it("prefers a real rate over a subscription plan", () => {
    expect(
      formatListingPrice({
        pricing: { average: "$1.32/1M" },
        subscription: claudeCodeSubscription,
      })
    ).toBe("$1.32/1M");
  });
});
