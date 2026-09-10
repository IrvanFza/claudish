import { describe, expect, test } from "bun:test";
/**
 * The column ladder, asserted so it can FAIL ON ITS OWN DEFECT.
 *
 * An earlier formulation of this test checked only that a row's cells did not EXCEED
 * the budget. That would have passed the very configuration the screenshot gate fails:
 * a row that sums to 39 columns short of its width leaves a dead tail, and a row whose
 * context meter has collapsed to one cell is a coloured dot. A test that cannot fail on
 * the defect it guards is not a guard.
 *
 * So the three claims are: the cells sum EXACTLY to the row width, the context meter
 * never drops below `MIN_CTX_CELLS`, and no cell is ever negative — over every width
 * from 40 to 200, which covers both mandatory capture sizes and everything between.
 */
import {
  CHROME,
  MIN_CTX_CELLS,
  derivePanes,
  deriveRailLayout,
  deriveRowLayout,
  railLayoutTotal,
  rowLayoutTotal,
} from "./layout.js";

const WIDTHS = Array.from({ length: 161 }, (_, i) => i + 40);

describe("deriveRowLayout", () => {
  test("cells sum EXACTLY to the row width at every width in [40, 200]", () => {
    const wrong = WIDTHS.map((w) => ({ w, sum: rowLayoutTotal(deriveRowLayout(w)) })).filter(
      ({ w, sum }) => sum !== w
    );
    expect(wrong).toEqual([]);
  });

  test("the context meter never drops below the floor", () => {
    const thin = WIDTHS.map((w) => ({ w, ctx: deriveRowLayout(w).ctx })).filter(
      ({ ctx }) => ctx < MIN_CTX_CELLS
    );
    expect(thin).toEqual([]);
  });

  test("no cell is ever negative", () => {
    const bad = WIDTHS.flatMap((w) =>
      Object.entries(deriveRowLayout(w)).filter(([, v]) => (v as number) < 0)
    );
    expect(bad).toEqual([]);
  });

  test("the ladder drops cells in the stated order as the width shrinks", () => {
    // Widest: everything. The release date is the first thing to go, then the price
    // METER — never its numeral, and never the context meter.
    expect(deriveRowLayout(117).date).toBeGreaterThan(0);
    expect(deriveRowLayout(80).date).toBe(0);
    expect(deriveRowLayout(80).price).toBeGreaterThan(0);
    expect(deriveRowLayout(57).price).toBe(0);
    expect(deriveRowLayout(57).priceNum).toBeGreaterThan(0);
    expect(deriveRowLayout(40).ctx).toBeGreaterThanOrEqual(MIN_CTX_CELLS);
  });

  test("a non-finite or negative width yields the narrowest tier, never NaN columns", () => {
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
      const l = deriveRowLayout(w);
      expect(Object.values(l).every((v) => Number.isFinite(v))).toBe(true);
      expect(l.ctx).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("derivePanes", () => {
  test("the two mandatory capture widths land where the design says", () => {
    // 80 → a 19-column rail and 57 usable row cells; 145 → 24 and 117.
    expect(derivePanes(80)).toMatchObject({ railW: 19, panelOuter: 60, rowCells: 57 });
    expect(derivePanes(145)).toMatchObject({ railW: 24, panelOuter: 120, rowCells: 117 });
  });

  test("a tiny terminal still yields positive, finite budgets", () => {
    for (const w of [10, 20, Number.NaN]) {
      const p = derivePanes(w);
      expect(p.rowCells).toBeGreaterThan(0);
      expect(p.railInner).toBeGreaterThan(0);
    }
  });
});

describe("deriveRailLayout", () => {
  test("cells sum EXACTLY to the rail's inner width", () => {
    for (const inner of [8, 12, 17, 22, 30]) {
      expect(railLayoutTotal(deriveRailLayout(inner))).toBe(inner);
    }
  });

  test("the served count appears only when the rail is wide enough to hold one", () => {
    expect(deriveRailLayout(17).count).toBe(0);
    expect(deriveRailLayout(22).count).toBeGreaterThan(0);
  });
});

describe("CHROME", () => {
  test("every height gate is a distinct, ordered threshold", () => {
    // They are read as "at or above", so an out-of-order pair would silently make one
    // gate unreachable.
    expect(CHROME.detail).toBeLessThan(CHROME.headerTwoRows);
    expect(CHROME.headerTwoRows).toBeLessThanOrEqual(CHROME.bannerBordered);
    expect(CHROME.bannerBordered).toBeLessThan(CHROME.statsPanel);
  });
});
