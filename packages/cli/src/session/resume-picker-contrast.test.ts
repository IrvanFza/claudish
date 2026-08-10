import { describe, expect, it } from "bun:test";
import { C } from "../tui/theme.js";
import { CHIP, CHIP_MIN_CONTRAST, GH_LEVELS, SELECTABLE_CHIPS } from "./resume-picker.js";

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #rrggbb, received ${hex}`);

  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

// This stays independent of viz/color.ts so a regression in production contrast math
// cannot make the palette and its test agree on the same incorrect answer.
function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: string, second: string): number {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

describe("resume picker chip contrast", () => {
  for (const name of SELECTABLE_CHIPS) {
    it(`${name} remains visible on the selected-row highlight`, () => {
      expect(contrastRatio(CHIP[name], C.bgHighlight)).toBeGreaterThanOrEqual(CHIP_MIN_CONTRAST);
    });

    it(`${name} keeps dark ink across fresh and stale rows`, () => {
      // Crossing this boundary would make the age column alternate ink colours by age.
      expect(relativeLuminance(CHIP[name])).toBeGreaterThan(0.179);
    });
  }

  it("uses the calendar's one green scale for fresh and clean state", () => {
    expect(GH_LEVELS).toContain(CHIP.fresh);
    expect(GH_LEVELS).toContain(CHIP.clean);
  });

  it("reserves red for real errors instead of ordinary branch divergence", () => {
    expect(CHIP.behind).not.toBe(C.red);
    expect(CHIP.ahead).not.toBe(C.red);
    expect(Object.values(CHIP)).not.toContain(C.red);
  });

  it("keeps empty calendar days visible without GitHub's gutters", () => {
    expect(contrastRatio(GH_LEVELS[0], C.bgAlt)).toBeGreaterThanOrEqual(1.2);
  });
});
