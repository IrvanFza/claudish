import { afterEach, describe, expect, it } from "bun:test";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import { C, STAGE_BG, STAGE_FG, latencyBg, latencyFg } from "./theme.js";
import type { TuiPalette } from "./theme.js";
import { ramps, tokens } from "./viz/tokens.js";

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #rrggbb, received ${hex}`);

  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

// Independent of production color helpers so the palette cannot agree with a broken formula.
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

resetThemeModeForTests();
const INITIAL_DARK_PALETTE: TuiPalette = { ...C };

afterEach(() => {
  resetThemeModeForTests();
});

describe("light TUI palette contrast", () => {
  const pageTextAccents = [
    "fg",
    "fgMuted",
    "dim",
    "strong",
    "green",
    "brightGreen",
    "red",
    "yellow",
    "cyan",
    "blue",
    "magenta",
    "orange",
    "tabInactiveFg",
  ] as const satisfies ReadonlyArray<keyof TuiPalette>;

  for (const accent of pageTextAccents) {
    it(`keeps ${accent} at 4.5:1 or better on the page`, () => {
      setThemeMode("light");
      expect(C.bg).toBe("#ffffff");
      expect(contrastRatio(C[accent], C.bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  const ownedFills = ["pillKeyBg", "pillOauthBg", "tabActiveBg"] as const satisfies ReadonlyArray<
    keyof TuiPalette
  >;

  for (const fill of ownedFills) {
    it(`keeps ink legible on ${fill}`, () => {
      setThemeMode("light");
      expect(contrastRatio(C.ink, C[fill])).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const latency of [100, 700, 2000, 4000, 10000]) {
    it(`keeps latency ink legible at ${latency}ms`, () => {
      setThemeMode("light");
      expect(contrastRatio(latencyFg, latencyBg(latency))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps both selection text roles legible on a visible wash", () => {
    setThemeMode("light");
    expect(contrastRatio(C.strong, C.bgHighlight)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(C.fg, C.bgHighlight)).toBeGreaterThanOrEqual(4.5);
    expect(C.bgHighlight).not.toBe(C.bg);
  });

  for (const stage of Object.keys(STAGE_BG) as Array<keyof typeof STAGE_BG>) {
    it(`keeps the ${stage} stage block visible on the page`, () => {
      setThemeMode("light");
      expect(contrastRatio(STAGE_BG[stage], C.bg)).toBeGreaterThanOrEqual(1.7);
    });
  }

  it("keeps normal text legible on the error wash", () => {
    setThemeMode("light");
    expect(contrastRatio(C.fg, C.bgError)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps both footer chip segments legible", () => {
    setThemeMode("light");
    expect(contrastRatio(C.fg, C.chipKeyBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(C.fgMuted, C.chipLabelBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("re-snapshots semantic tokens and ramps", () => {
    setThemeMode("light");
    expect(tokens.success).toBe(C.green);
    expect(tokens.bgPanel).toBe(C.bgAlt);
    expect(ramps.load[0]).toBe(C.green);
  });
});

describe("dark TUI palette identity", () => {
  it("pins the shipped dark values", () => {
    resetThemeModeForTests();
    expect(C.bg).toBe("#000000");
    expect(C.green).toBe("#39ff14");
    expect(C.fg).toBe("#ffffff");
    expect(STAGE_BG.streaming).toBe("#ffcc00");
  });

  it("restores every palette field after a light-to-dark flip", () => {
    setThemeMode("light");
    expect(C).not.toEqual(INITIAL_DARK_PALETTE);

    setThemeMode("dark");
    expect(C).toEqual(INITIAL_DARK_PALETTE);
  });

  it("refreshes stage foregrounds after a light-to-dark flip", () => {
    setThemeMode("light");
    expect(STAGE_FG.network).toBe(C.cyan);
    expect(STAGE_FG.server).toBe(C.blue);
    expect(STAGE_FG.streaming).toBe(C.yellow);

    setThemeMode("dark");
    expect(STAGE_FG.network).toBe(C.cyan);
    expect(STAGE_FG.server).toBe(C.blue);
    expect(STAGE_FG.streaming).toBe(C.yellow);
  });
});
