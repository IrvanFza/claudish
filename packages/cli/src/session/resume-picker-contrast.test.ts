import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getThemeMode, setThemeMode } from "../theme/theme-mode.js";
import { C } from "../tui/theme.js";
import {
  CHIP,
  CHIP_LIGHT,
  CHIP_MIN_CONTRAST,
  CHIP_MIN_CONTRAST_LIGHT,
  CHIP_MIN_INK_CONTRAST,
  GH_LEVELS,
  GH_LEVELS_LIGHT,
  SELECTABLE_CHIPS,
  chips,
  ghLevels,
} from "./resume-picker.js";

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

  it("serves the dark palettes while the mode is unknown or dark", () => {
    const prev = getThemeMode();
    try {
      setThemeMode(null);
      expect(ghLevels()).toBe(GH_LEVELS);
      expect(chips()).toBe(CHIP);
      setThemeMode("dark");
      expect(ghLevels()).toBe(GH_LEVELS);
      expect(chips()).toBe(CHIP);
    } finally {
      setThemeMode(prev);
    }
  });
});

describe("resume picker chip contrast — light terminal", () => {
  // Restored by VALUE, not via resetThemeModeForTests(): the reset also clears the
  // listener list, which would disconnect theme.ts's palette refresher for every test
  // that runs after this file in the same process. The light surfaces are asserted
  // against LITERALS (#bfdbfe, #ffffff, #f3f4f6) rather than through `C` so this suite
  // cannot pass — or fail — through a sibling's listener state; the literals are the
  // published light palette values from tui/theme.ts.
  let prev: ReturnType<typeof getThemeMode>;
  beforeAll(() => {
    prev = getThemeMode();
    setThemeMode("light");
  });
  afterAll(() => {
    setThemeMode(prev);
  });

  const LIGHT_HIGHLIGHT = "#bfdbfe";
  const LIGHT_PAGE = "#ffffff";
  const LIGHT_BG_ALT = "#f3f4f6";
  // pickInk's light-theme candidates are #000000 (`tokens.ink`) and the near-black
  // `#1f2937` (`tokens.text`); black wins on every mid fill, so black IS the picked ink.
  const DARK_INK = "#000000";

  it("serves the light palettes once the mode is light", () => {
    expect(ghLevels()).toBe(GH_LEVELS_LIGHT);
    expect(chips()).toBe(CHIP_LIGHT);
  });

  for (const name of SELECTABLE_CHIPS) {
    it(`${name} reads as a block on the light selection wash`, () => {
      expect(contrastRatio(CHIP_LIGHT[name], LIGHT_HIGHLIGHT)).toBeGreaterThanOrEqual(
        CHIP_MIN_CONTRAST_LIGHT
      );
    });

    it(`${name} reads as a block on the white page`, () => {
      expect(contrastRatio(CHIP_LIGHT[name], LIGHT_PAGE)).toBeGreaterThanOrEqual(
        CHIP_MIN_CONTRAST_LIGHT
      );
    });
  }

  for (const name of Object.keys(CHIP_LIGHT) as Array<keyof typeof CHIP_LIGHT>) {
    it(`${name} takes legible dark ink`, () => {
      expect(contrastRatio(CHIP_LIGHT[name], DARK_INK)).toBeGreaterThanOrEqual(
        CHIP_MIN_INK_CONTRAST
      );
      // Same boundary the dark set honours: dipping under would flip pickInk's verdict
      // row to row down the age column.
      expect(relativeLuminance(CHIP_LIGHT[name])).toBeGreaterThan(0.179);
    });
  }

  it("uses the light calendar's one green scale for fresh and clean state", () => {
    expect(GH_LEVELS_LIGHT).toContain(CHIP_LIGHT.fresh);
    expect(GH_LEVELS_LIGHT).toContain(CHIP_LIGHT.clean);
  });

  it("keeps empty calendar days visible on the light panel", () => {
    expect(contrastRatio(GH_LEVELS_LIGHT[0], LIGHT_BG_ALT)).toBeGreaterThanOrEqual(1.2);
  });

  it("reserves red for real errors on the light palette too", () => {
    // C.red's light value, as a literal for the sibling-listener reason above.
    expect(Object.values(CHIP_LIGHT)).not.toContain("#dc2626");
  });
});
