import { afterEach, describe, expect, it } from "bun:test";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import { C, CONTRAST_REFERENCE, STAGE_BG, STAGE_FG, latencyBg, latencyFg } from "./theme.js";
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

/**
 * CIELAB, for the one question WCAG cannot answer.
 *
 * A contrast ratio is a function of LUMINANCE alone, so two fills of the same
 * lightness and wildly different hue score 1.0:1 against each other — indistinguishable
 * by that measure and obviously different to a reader. The picker's status column
 * needs exactly that distinction (a green chip alternating with a grey one), and the
 * luminance band an owned fill may occupy is too narrow to carry it, so the assertion
 * has to be perceptual. Written out here rather than imported for the same reason the
 * luminance formula is: the palette must not be able to agree with a broken helper.
 */
function lab(hex: string): [number, number, number] {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** How LOUD a colour is — zero for any grey, ~52 for the green this fill replaced. */
function chroma(hex: string): number {
  const [, a, b] = lab(hex);
  return Math.hypot(a, b);
}

/** CIE76 perceptual distance. ~2.3 is a just-noticeable difference. */
function deltaE76(first: string, second: string): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
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

  const ownedFills = [
    "pillKeyBg",
    "pillMutedBg",
    "pillOauthBg",
    "tabActiveBg",
  ] as const satisfies ReadonlyArray<keyof TuiPalette>;

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

  it("RAISES the keycap chip off the panel it is drawn on", () => {
    // Legible ink is only half of a keycap: the chip also has to be visibly
    // raised off the band beneath it or it reads as a tinted word rather than as
    // a key you press. The owner reported exactly that from a live light-theme
    // run, and the old `#d1d5db` measured 1.32:1 against `bgAlt` — under the
    // 1.7:1 this file already requires of every stage block.
    setThemeMode("light");
    expect(contrastRatio(C.chipKeyBg, C.bgAlt)).toBeGreaterThanOrEqual(1.7);
  });

  it("keeps the detail pane's dim tiers legible on the PANEL — there is no band", () => {
    // The detail rows sit on the dialog's own `bgAlt`, with no fill of their own: a
    // pane separated by an absolute fill fights whichever theme we guessed, and the
    // owner rejected exactly that ("all text in description has different background
    // colours... please remove"). Receding is the TEXT's job, so the two tiers that
    // do the receding still have to clear a text-grade ratio on the panel itself.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, ratio: contrastRatio(C.fgMuted, C.bgAlt) >= 4.5 }).toEqual({
        mode,
        ratio: true,
      });
    }
  });

  it("re-snapshots semantic tokens and ramps", () => {
    setThemeMode("light");
    expect(tokens.success).toBe(C.green);
    expect(tokens.bgPanel).toBe(C.bgAlt);
    expect(ramps.load[0]).toBe(C.green);
  });
});

/**
 * Every fill WE paint, measured against BOTH reference terminals — the rule claudeup
 * enforces in `theme-adaptive-colors.test.ts` and the one this repo was breaking.
 *
 * A chip lands on a page we do not control. `theme-mode.ts` detects light vs dark and
 * we tune two palettes, but detection can fail (an unknown answer resolves to DARK),
 * tmux can lie about `COLORFGBG`, and a cream or solarized page is neither of our two
 * references. So a fill has to separate from BOTH or it is invisible somewhere real:
 * the rejected keycap grey measured 1.50:1 on the dark reference, which is a chip that
 * is not a chip.
 *
 * 3:1, NOT 4.5:1, AND THAT IS NOT A RELAXATION. No single colour can clear 4.5:1
 * against both a cream and a near-black page — the luminance bands do not overlap —
 * and 3:1 is WCAG's own bar for a UI component, which is what a chip is. The ink ON
 * the chip is held to 4.5:1 separately, and it is plain white, because we own both
 * sides of a fill and its contrast should not be a function of the user's theme.
 */
describe("owned chip fills clear 3:1 on BOTH reference terminals", () => {
  const chipFills = [
    "pillKeyBg", // FREE / SUB / local — the positive family
    "pillMutedBg", // the picker's metered `$` — the quiet half of the same column
    "pillOauthBg", // oauth pills in the config TUI's AUTH column
    "chipKeycapBg", // footer keycaps
    "tabActiveBg", // the active tab pill
    "red", // the `HTTP 401` chip and the discovery-failure rule
  ] as const satisfies ReadonlyArray<keyof TuiPalette>;

  for (const mode of ["light", "dark"] as const) {
    for (const fill of chipFills) {
      it(`separates ${fill} from both pages in the ${mode} palette`, () => {
        setThemeMode(mode);
        for (const page of Object.values(CONTRAST_REFERENCE)) {
          expect({ fill, page, ok: contrastRatio(C[fill], page) >= 3 }).toEqual({
            fill,
            page,
            ok: true,
          });
        }
      });
    }
  }

  it("keeps WHITE ink legible on every fill that carries a label", () => {
    // `C.ink` is `#ffffff` in both palettes for exactly this reason: where we choose
    // the fill we choose the ink, so the ratio is deterministic instead of a function
    // of the user's page. TWO fills are excluded and each for its own reason: `C.red`
    // is a NEON on dark (`#ff003c`), bright enough that `pickInk` correctly puts DARK
    // ink on it, and `tabActiveBg` carries its own `tabActiveFg` rather than `C.ink`.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      for (const fill of ["pillKeyBg", "pillMutedBg", "pillOauthBg", "chipKeycapBg"] as const) {
        expect({ mode, fill, ok: contrastRatio(C.ink, C[fill]) >= 4.5 }).toEqual({
          mode,
          fill,
          ok: true,
        });
      }
    }
  });

  it("A KEYCAP IS NEVER THE NEUTRAL GREY AGAIN, in either palette", () => {
    // The regression this exists for shipped twice, once per palette: a grey keycap
    // reads as a faintly tinted word rather than as a key you press, and the owner
    // reported it from a live light-theme run. `chipKeyBg` survives as the config
    // TUI's two-tone footer segment, whose ink is theme-following `C.fg` and which is
    // measured against `bgAlt` above — a different object with a different contract.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, same: C.chipKeycapBg === C.chipKeyBg }).toEqual({ mode, same: false });
    }
  });

  it("HOLDS THE TWO HALVES OF THE STATUS COLUMN APART — the banding gate", () => {
    // The picker's billing column now carries a fill on EVERY row: `SUB`/`local` on
    // `pillKeyBg`, `$` on `pillMutedBg`. That is the shape that fused into one solid
    // vertical band when the prefix column was chipped — and what failed there was
    // that all 17 fills were the SAME colour. Here they alternate, so the whole
    // design rests on these two being visibly different fills.
    //
    // THE AXIS IS CHROMA, NOT LUMINANCE, AND THAT IS FORCED. Every owned fill must
    // sit in L 0.1351…0.1833 (3:1 on near-black below, white ink at 4.5:1 above), a
    // band only 1.26:1 wide — so two fills can differ in brightness by almost
    // nothing. MEASURED: `#3f7752` is C* 31.2 and `#6b7280` is C* 8.6, ΔE76 36.5
    // apart, where ~2.3 is a just-noticeable difference. The floor below is 20, well
    // under the measured value and far above a tweak that would collapse them.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({
        mode,
        distinct: C.pillKeyBg !== C.pillMutedBg,
        deltaE: deltaE76(C.pillKeyBg, C.pillMutedBg) >= 20,
        // And the METERED one is the QUIET one: a near-grey beside a green. If this
        // inverts, the column is telling the reader that the default state is the
        // notable one.
        quieter: chroma(C.pillMutedBg) < chroma(C.pillKeyBg) / 2,
      }).toEqual({ mode, distinct: true, deltaE: true, quieter: true });
    }
  });

  it("KEEPS THE POSITIVE FILL SOFTER THAN THE TEXT-GRADE GREEN IT CAME FROM", () => {
    // `pillKeyBg` was `#15803d` — claudeup's `success`, and also this palette's light
    // `green`, which is a TEXT accent held to 4.5:1 on white. The owner's verdict on
    // it as an AREA was "make sub badge not as bright, make it softer". Softness is
    // chroma: C* 52.5 → 31.2, with the page ratios held (4.70/3.39 → 4.95/3.22). The
    // pin is the comparison, not the hex — a future green may be softer still, but it
    // may not climb back to a foreground's saturation.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, softer: chroma(C.pillKeyBg) < chroma("#15803d") }).toEqual({
        mode,
        softer: true,
      });
      // A fill is never the neon/page-text green of its own palette either.
      expect(C.pillKeyBg).not.toBe(C.green);
    }
  });

  it("holds the POSITIVE family apart from the FAILURE hue", () => {
    // `SUB` shipped in `tokens.warn`, the hue this app spends on failure, under a
    // label that means the opposite of a failure. Three reviewers read it as correct,
    // so the separation is asserted rather than described.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect(C.pillKeyBg).not.toBe(C.red);
      expect(C.pillKeyBg).not.toBe(C.orange);
    }
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
