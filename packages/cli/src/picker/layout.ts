/**
 * picker/layout.ts — every column budget the picker spends, in one place.
 *
 * Flexbox owns the BOXES; arithmetic owns the widths of the data widgets, because
 * `Meter`/`MeterSpan`/`Sparkline`/`StackedBar` take a numeric cell count and a
 * number cannot `flexGrow` (bunjs:tui `react-patterns.md`). So a full-width
 * visual is a column budget, and a budget that lives at its call site drifts.
 *
 * THE CONTEXT METER IS THE ELASTIC CELL, and that is the whole design of
 * `deriveRowLayout`. Every other cell is fixed per tier; the meter takes the
 * surplus up to its tier maximum and hands any remainder to the model id. Two
 * consequences, both load-bearing:
 *
 *   1. A row is EXACTLY `rowCells` wide at every width — no unpainted tail, which
 *      is the gap a colour screenshot fails a panel for.
 *   2. A row NEVER carries fewer than `MIN_CTX_CELLS` meter cells, at any width,
 *      which is what keeps every visible model row a GRAPHICS row at 80 columns.
 *      The whole-frame density count depends on that and on nothing else.
 *
 * The ladder is a table of tiers rather than a formula because the cells it drops
 * are editorial, not arithmetic: the release date goes first (it is chrome), then
 * the price METER (the numeral stays — the number is the fact, the bar is the
 * comparison), then the capability column, then the id shrinks. Nothing here drops
 * the context meter.
 */

/**
 * The floor on the context meter, in cells.
 *
 * FOUR, not one: a one-cell meter is a coloured dot, and `rampFor` would blend a
 * whole gradient down to a single colour — the "single-colour bar" the aesthetic
 * contract names as a negative control. Four cells still read as a fill and still
 * carry four distinct ramp colours.
 */
export const MIN_CTX_CELLS = 4;

/** The smallest model-id column worth rendering. Below this a row is unreadable. */
const MIN_ID_CELLS = 8;

/**
 * One model row's cells, left to right. Every number is COLUMNS, and they sum to
 * exactly `rowCells` — asserted over the whole width range by `layout.test.ts`.
 *
 * A zero means the cell is DROPPED at this width (and its separator with it), not
 * that it renders empty: an empty cell would still eat its columns.
 */
export interface RowLayout {
  /** Total columns the row must paint, exactly. */
  rowCells: number;
  /** `▶ ` / `  ` — the cursor gutter, which carries its own trailing space. */
  cursor: number;
  /** Model id, padded/truncated. Absorbs the surplus the meter cannot use. */
  id: number;
  /** The context-window gradient meter. The elastic cell; never below `MIN_CTX_CELLS`. */
  ctx: number;
  /** `padStartTo`-ed context numeral (`256K`). */
  ctxNum: number;
  /** The price meter. 0 at narrow widths — the numeral survives instead. */
  price: number;
  /** `padStartTo`-ed price numeral, or the `SUB` chip's column. */
  priceNum: number;
  /** Capability column — `[TRV]`, five columns, identical at every width (`rows.tsx`). */
  caps: number;
  /**
   * The provenance chip's column (` CAT `), reserved ONLY for a fallback list.
   *
   * INSIDE THE BUDGET, and that is a correction to a measured bug: the chip was first
   * rendered after the last cell, outside the row's width, on the reasoning that a
   * provenance mark should not re-size the cells and make a fallback list
   * geometrically incomparable to a live one. The model panel is `overflow="hidden"`,
   * so the chip was clipped away ENTIRELY — the single highest-value signal in the
   * feature, invisible, in the exact state the feature exists for. Comparability lost
   * to visibility; the two lists are never on screen at the same time anyway.
   */
  mark: number;
  /** Release date, `padStartTo`-ed. 0 below the widest tier — it is chrome. */
  date: number;
  /** Single-space separators the renderer emits. Part of the sum. */
  gaps: number;
}

/** A tier of the ladder: everything fixed, plus the elastic cell's bounds. */
interface Tier {
  cursor: number;
  ctxNum: number;
  price: number;
  priceNum: number;
  caps: number;
  date: number;
  gaps: number;
  /** Nominal id width. The meter only grows past its minimum once this is satisfied. */
  id: number;
  ctxMin: number;
  ctxMax: number;
}

/**
 * The ladder. `min` is inclusive and the rows are ordered widest-first, so the
 * first match wins.
 *
 * `gaps` is the number of single-space separators the row renderer emits between
 * the cells this tier keeps — one fewer than the number of cells, because the
 * cursor gutter carries its own space. It is counted here rather than derived so
 * that `fixedCells` (below) is the single number the elastic split works from; the
 * renderer and this table are kept in step by the exact-sum test, which would fail
 * the instant one emitted a separator the other had not budgeted.
 */
const TIERS: ReadonlyArray<{ min: number; tier: Tier }> = [
  {
    // ≥ 96: everything — both meters, the capability column, the release date.
    min: 96,
    tier: {
      cursor: 2,
      ctxNum: 6,
      price: 10,
      priceNum: 9,
      caps: 5,
      date: 10,
      gaps: 6,
      id: 36,
      ctxMin: 10,
      ctxMax: 24,
    },
  },
  {
    // 70–95: the release date goes first — it is the one cell that is pure chrome.
    min: 70,
    tier: {
      cursor: 2,
      ctxNum: 6,
      price: 8,
      priceNum: 9,
      caps: 5,
      date: 0,
      gaps: 5,
      id: 32,
      ctxMin: 8,
      ctxMax: 16,
    },
  },
  {
    // 56–69 — the 80-column tier, and the one the density count turns on. The
    // price METER goes; its numeral stays, because the number is the fact and the
    // bar is only the comparison.
    min: 56,
    tier: {
      cursor: 2,
      ctxNum: 6,
      // NINE, not eight: `$30.00/1M` is nine columns and an eight-column cell rendered
      // it `$30.00/…`. A truncated PRICE is the one truncation this row cannot afford —
      // it is the number the user is choosing on, and a clipped one reads as a
      // different, smaller number.
      price: 0,
      priceNum: 9,
      caps: 6,
      date: 0,
      gaps: 4,
      id: 23,
      ctxMin: 6,
      ctxMax: 10,
    },
  },
  {
    // 44–55: the id gives way before the meter does.
    min: 44,
    tier: {
      cursor: 2,
      ctxNum: 6,
      price: 0,
      priceNum: 9,
      caps: 6,
      date: 0,
      gaps: 4,
      id: 17,
      ctxMin: 5,
      ctxMax: 10,
    },
  },
  {
    // < 44: id, meter, two numerals. `id: MIN_ID_CELLS` makes the meter pin to
    // `ctxMax` and the id take every remaining column — "id: rest".
    min: 0,
    tier: {
      cursor: 2,
      ctxNum: 5,
      price: 0,
      priceNum: 7,
      caps: 0,
      date: 0,
      gaps: 3,
      id: MIN_ID_CELLS,
      ctxMin: MIN_CTX_CELLS,
      ctxMax: MIN_CTX_CELLS,
    },
  },
];

/** Everything in a tier except the id and the context meter. */
function fixedCells(t: Tier): number {
  return t.cursor + t.ctxNum + t.price + t.priceNum + t.caps + t.date + t.gaps;
}

/**
 * The cell widths for a model row `rowCells` columns wide.
 *
 * Clamped, never trusted: a caller that hands this a negative, fractional or
 * non-finite width gets the narrowest tier rather than NaN columns, because a NaN
 * width reaches `Meter` as a zero-width widget — nothing painted, nothing thrown.
 */
export function deriveRowLayout(rowCells: number, opts: { mark?: boolean } = {}): RowLayout {
  const cells = Number.isFinite(rowCells) ? Math.max(0, Math.floor(rowCells)) : 0;
  const t = (TIERS.find((row) => cells >= row.min) ?? TIERS[TIERS.length - 1]!).tier;
  // ` CAT ` plus its separator, and only when the list is a fallback. It comes out of
  // the ID, which is the one cell with slack — never out of the context meter.
  const mark = opts.mark === true && cells >= 44 ? MARK_CELLS + 1 : 0;
  const fixed = fixedCells(t) + mark;

  // `id + ctx` is whatever the fixed cells leave. Split it so the id gets its
  // nominal width first, the meter takes the surplus up to its tier maximum, and
  // any remainder goes back to the id — which is what makes a 145-column row sum
  // exactly rather than leaving a dead tail where the meter stopped growing.
  const budget = Math.max(0, cells - fixed);
  let ctx = Math.min(Math.max(budget - t.id, MIN_CTX_CELLS), t.ctxMax);
  let id = budget - ctx;

  if (id < MIN_ID_CELLS) {
    // Too narrow for both. The id keeps its floor and the meter gives way down to
    // its own floor; below that the id pays, because a 3-cell meter is still a
    // meter and a 2-column id is not a name.
    id = Math.min(MIN_ID_CELLS, budget);
    ctx = Math.max(0, budget - id);
    if (ctx < MIN_CTX_CELLS) {
      ctx = Math.min(MIN_CTX_CELLS, budget);
      id = Math.max(0, budget - ctx);
    }
  }

  return {
    rowCells: cells,
    cursor: t.cursor,
    id,
    ctx,
    ctxNum: t.ctxNum,
    price: t.price,
    priceNum: t.priceNum,
    caps: t.caps,
    date: t.date,
    gaps: t.gaps,
    mark,
  };
}

/** ` CAT ` — `BadgeSpan` pads one column each side of the label, outside the fill. */
const MARK_CELLS = 5;

/** Sum of every cell plus the separators — must equal `rowCells`. */
export function rowLayoutTotal(l: RowLayout): number {
  return (
    l.cursor + l.id + l.ctx + l.ctxNum + l.price + l.priceNum + l.caps + l.date + l.gaps + l.mark
  );
}

/**
 * The two columns of the picker, and what each leaves for its content.
 *
 * `railW` is 19 / 24 per the design; the rest follows from the two chrome costs
 * the skill MEASURED and this repo re-measured: a `Panel` spends 2 columns of
 * border when `flush` (4 when not), and a `<scrollbox>` inside it spends 1 more
 * for the thumb. The one-column `gap` between the panes is real — it is set on the
 * flex row, so it has to come out of the budget here too.
 */
export interface PaneLayout {
  /** Outer width of the provider rail, borders included. */
  railW: number;
  /** Usable columns inside the rail's flush panel. */
  railInner: number;
  /** Outer width of the model panel. */
  panelOuter: number;
  /** Usable columns for one model row, inside the panel and beside the thumb. */
  rowCells: number;
}

export function derivePanes(width: number): PaneLayout {
  const w = Number.isFinite(width) ? Math.max(20, Math.floor(width)) : 80;
  const railW = w >= 100 ? 24 : 19;
  const panelOuter = Math.max(8, w - railW - 1);
  return {
    railW,
    // MINUS THREE, not two: the flush `Panel` spends 2 columns of border and the
    // `<scrollbox>` inside it spends 1 more for the thumb — the second cost measured by
    // the skill and re-measured here, where budgeting only the border clipped the
    // billing tag on every rail row (`SUB` painted as `SU`).
    railInner: Math.max(4, railW - 3),
    panelOuter,
    rowCells: Math.max(12, panelOuter - 3),
  };
}

/** One provider rail row's cells. The LABEL is the elastic cell here. */
export interface RailLayout {
  railInner: number;
  /** Readiness glyph — `●` / `○` / `◌`. */
  glyph: number;
  /** Provider name, truncated. */
  label: number;
  /** Right-aligned billing tag: `SUB` / `LOCAL` / `$`. */
  tag: number;
  /** Served-model count, or 0 when the rail is too narrow to carry one. */
  count: number;
  gaps: number;
}

/**
 * THE BILLING TAG IS PLAIN COLOURED TEXT, NOT A `BadgeSpan`, and that is a budget
 * decision taken against the skill's default ("discrete status → badge"). A chip
 * pays two columns of padding for its fill; the rail's whole inner width is 17 at
 * 80 columns, so those two columns come straight off the provider NAME — and a
 * rail whose names are all elided has lost more than a chip gains. The readiness
 * glyph and the tag's own colour carry the status, and the model panel spends its
 * chips where there is room for them. §5.3's own mock renders the bare form.
 */
const TAG_CELLS = 5;

export function deriveRailLayout(railInner: number): RailLayout {
  const inner = Number.isFinite(railInner) ? Math.max(4, Math.floor(railInner)) : 17;
  // The count needs a rail wide enough that the NAME does not pay for it.
  const count = inner >= 20 ? 3 : 0;
  let gaps = count > 0 ? 3 : 2;
  let tag = TAG_CELLS;
  let label = inner - 1 - tag - count - gaps;
  if (label < 3) {
    // Absurdly narrow: the tag goes before the name does. A rail of billing tags with
    // no provider names in it is not a rail. `Math.max(1, …)` on the label instead
    // would have kept the tag and OVERFLOWED the row — measured: 9 cells rendered into
    // an 8-column rail, which Yoga then claws back from whichever cell it likes.
    tag = 0;
    gaps = 1;
    label = inner - 1 - count - gaps;
  }
  if (label < 1) {
    gaps = 0;
    label = Math.max(0, inner - 1 - count);
  }
  return { railInner: inner, glyph: 1, label, tag, count, gaps };
}

/** Sum of a rail row's cells — must equal `railInner`. */
export function railLayoutTotal(l: RailLayout): number {
  return l.glyph + l.label + l.tag + l.count + l.gaps;
}

/**
 * Chrome that is HEIGHT-gated, not width-gated — the scarce axis at 80×24 is rows.
 *
 * Each threshold is named once here because every one of them is a row the model
 * list does not get, and §4.6's whole-frame density arithmetic is built on these
 * exact numbers.
 */
export const CHROME = {
  /** Two header rows (identity + context) above this height, one below. */
  headerTwoRows: 30,
  /** `StatsStrip` takes a bordered `Panel` with three rows at or above this. */
  statsPanel: 34,
  /** The discovery banner takes a full border (2 rows of chrome) at or above this. */
  bannerBordered: 30,
  /**
   * The two pinned detail blocks appear at or above this height.
   *
   * Below it every row belongs to a list: a detail block would trade two model rows —
   * two GRAPHICS rows — for two rows of prose, which is the wrong direction for the
   * whole-frame density count on the terminal where that count is tightest.
   */
  detail: 26,
} as const;
