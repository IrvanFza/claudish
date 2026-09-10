/**
 * picker/layout.ts — every column and row budget the picker dialog spends, in one
 * place.
 *
 * Flexbox owns the BOXES; arithmetic owns the widths of the cells inside a row,
 * because a row is one `<text>` of `<span>`s and a span cannot `flexGrow`. So a
 * full-width row is a column budget, and a budget that lives at its call site
 * drifts between the header and the rows it labels.
 *
 * THE MODEL ID IS THE ELASTIC CELL, and every other cell is fixed at every width.
 * That is the whole difference from the two-pane build this replaces, whose five
 * responsive tiers existed to keep a gradient meter on every row down to 44
 * columns. There is no meter now, so there is no ladder: the four fixed cells are
 * the four facts a reader chooses on (which provider, how much context, what it
 * costs, and whether the row is verified), and the name takes everything left.
 * One layout at 80 columns and at 145.
 *
 * THE DIALOG IS CONTENT-SIZED, NOT SCREEN-SIZED. It renders INLINE
 * (`screenMode: "main-screen"`), so its height is rows it actually occupies in the
 * user's scrollback rather than a viewport it has taken over — which is why the
 * row budget below caps at `MAX_DIALOG_ROWS` and does not grow with the terminal.
 * A 45-row terminal gets the same 18-row dialog as a 24-row one, with the extra
 * rows left to the shell. The unpainted-black-hole failure of the previous build
 * cannot occur here: a short list makes a short box.
 */

/** The widest routing shortcut in the roster (`mistral@`), so the column never elides. */
const PROVIDER_CELLS = 8;
/** `262K`, `1M`, `N/A`. */
const CTX_CELLS = 6;
/** `$30.00`, `FREE`, `SUB`, `local`, `N/A`. */
const PRICE_CELLS = 9;
/** ` catalog` — reserved ONLY on a fallback list, so a live list is not indented. */
const MARK_CELLS = 8;
/** `▶ ` / `  ` — the cursor gutter, which carries its own trailing space. */
const CURSOR_CELLS = 2;
/** Air between the name and the provider column, and between the numeric columns. */
const GAP_AFTER_ID = 4;
const GAP_AFTER_PROVIDER = 4;
const GAP_AFTER_CTX = 5;
/** Below this the name is no longer a name. */
const MIN_ID_CELLS = 10;

/**
 * One model row's cells, left to right. Every number is COLUMNS, and they sum to
 * exactly `inner` — asserted over the whole width range by `layout.test.ts`.
 */
export interface RowLayout {
  /** Total columns the row must paint, exactly. */
  inner: number;
  cursor: number;
  /** Model id, padded/truncated. Absorbs every column the fixed cells do not use. */
  id: number;
  /** The routing shortcut, right-aligned: `or@`, `kc@`. */
  provider: number;
  /** Context window numeral, right-aligned. */
  ctx: number;
  /** Price / `SUB` / `FREE` / `local`, right-aligned. */
  price: number;
  /** ` catalog` — 0 on a live list. */
  mark: number;
  /** Single-space separators the renderer emits. Part of the sum. */
  gaps: number;
}

/**
 * The cell widths for a row `inner` columns wide.
 *
 * Clamped, never trusted: a caller that hands this a negative, fractional or
 * non-finite width gets a floor rather than NaN columns, because a NaN width
 * reaches `padTo` as a zero-width cell — nothing painted, nothing thrown.
 */
export function deriveRowLayout(inner: number, opts: { mark?: boolean } = {}): RowLayout {
  const cells = Number.isFinite(inner) ? Math.max(0, Math.floor(inner)) : 0;
  const mark = opts.mark === true ? MARK_CELLS : 0;
  const gaps = GAP_AFTER_ID + GAP_AFTER_PROVIDER + GAP_AFTER_CTX;

  // Everything except the elastic id. The mark carries no separator of its own —
  // the price column is right-aligned, so the gap is already inside it.
  let provider = PROVIDER_CELLS;
  let ctx = CTX_CELLS;
  let price = PRICE_CELLS;
  let id = cells - (CURSOR_CELLS + provider + ctx + price + mark + gaps);

  if (id < MIN_ID_CELLS) {
    // Absurdly narrow. The columns give way in the order they are least missed:
    // the mark's padding first (it is a whole-list property the title also
    // states), then the provider column, then the price. Nothing here drops the
    // CONTEXT numeral or the name, because those two are the row.
    const shortfall = MIN_ID_CELLS - id;
    const takeFromProvider = Math.min(provider, shortfall);
    provider -= takeFromProvider;
    const stillShort = shortfall - takeFromProvider;
    const takeFromPrice = Math.min(Math.max(0, price - 4), stillShort);
    price -= takeFromPrice;
    id = cells - (CURSOR_CELLS + provider + ctx + price + mark + gaps);
  }
  if (id < 0) {
    // Narrower than the fixed cells themselves. Give the name what is left and
    // let the row paint short rather than overflow, which Yoga would claw back
    // from whichever cell it liked.
    ctx = Math.max(0, ctx + id);
    id = 0;
  }

  return { inner: cells, cursor: CURSOR_CELLS, id, provider, ctx, price, mark, gaps };
}

/** Sum of every cell plus the separators — must equal `inner`. */
export function rowLayoutTotal(l: RowLayout): number {
  return l.cursor + l.id + l.provider + l.ctx + l.price + l.mark + l.gaps;
}

/** The separators, named so the renderer and the budget cannot disagree. */
export const GAPS = {
  afterId: GAP_AFTER_ID,
  afterProvider: GAP_AFTER_PROVIDER,
  afterCtx: GAP_AFTER_CTX,
} as const;

/** The widest the dialog is ever drawn, however wide the terminal is. */
export const MAX_DIALOG_WIDTH = 92;
/** The tallest the dialog is ever drawn, however tall the terminal is. */
export const MAX_DIALOG_ROWS = 18;
/** The most model rows the list ever shows at once. Scroll, do not grow. */
export const MAX_LIST_ROWS = 11;
/** Fewer than this and the list stops being a list. */
const MIN_LIST_ROWS = 3;
/** Below this the dialog cannot carry its own chrome plus a usable list. */
const MIN_DIALOG_ROWS = 11;

/**
 * Chrome rows the populated dialog ALWAYS spends: two border rows, the filter
 * row, the column header, the status row, the rule, the selection detail line
 * and the key hints.
 *
 * "ALWAYS" IS THE LOAD-BEARING WORD. The status row is rendered even when it is
 * blank, so that a list which starts overflowing (or a credential sweep that
 * finishes) does not shove every row below it by one. What is deliberately NOT
 * fixed is the LIST's height: it is content-sized up to `listRows`, because the
 * failure state's whole point is a four-row fallback list that reads as four rows
 * rather than as four rows in a panel built for eleven — the unpainted hole the
 * rejected build produced, which the reader read as "this provider has nothing".
 *
 * The banner's rows come OUT of the list's budget rather than being added to the
 * box, so the dialog is bounded above in every state and only ever SHRINKS from
 * its cap. Shape changes between phases are remounted with `key={…}`, which is
 * the documented cure for inline reconciliation tearing.
 */
export const CHROME_ROWS = 8;

export interface DialogLayout {
  /** Outer width including the border columns. */
  width: number;
  /** Columns of terminal to the left of the border. */
  marginLeft: number;
  /** Usable content columns: `width` less two border columns and two of padding. */
  inner: number;
  /** How many model rows fit. The list scrolls within this. */
  listRows: number;
}

/**
 * Size the dialog for a terminal, and for however many rows a banner has taken.
 *
 * `extraRows` is the honest coupling between the failure banner and the list: a
 * five-row 401 explanation and eleven model rows do not both fit, and the rows that
 * must give way are the list's — the banner is the REASON the list is short, so
 * hiding the banner to show more of an unverified list would invert the whole point
 * of the state.
 *
 * MEASURED, AND IT BOUNDS WHAT "INLINE" BUYS AT THIS PIN. `screenMode: "main-screen"`
 * still sizes the renderer to `stdout.rows` — `CliRendererConfig` at
 * `@opentui/core@0.1.107` carries no `width`/`height` key at all, whatever the
 * upstream option table says — so the picker owns the whole terminal while it is up,
 * and the banner above scrolls with the rest of the scrollback. What inline still
 * buys, and it is the reason for choosing it: nothing is SWAPPED, so the final frame
 * survives `destroy()` and the shell prompt returns directly under the dialog rather
 * than under a restored screen that never showed it. Capping the dialog at
 * `MAX_DIALOG_ROWS` is what keeps that owned region small instead of filling 45 rows.
 */
export function deriveDialogLayout(
  termWidth: number,
  termHeight: number,
  extraRows = 0
): DialogLayout {
  const w = Number.isFinite(termWidth) ? Math.max(24, Math.floor(termWidth)) : 80;
  const h = Number.isFinite(termHeight) ? Math.floor(termHeight) : 24;
  const width = Math.min(w - 4, MAX_DIALOG_WIDTH);
  // Two columns of margin at 80, centred once the terminal is wider than the cap.
  const marginLeft = Math.max(2, Math.floor((w - width) / 2));
  // `- 6`: the shell prompt and the claudish banner keep their rows wherever the
  // terminal is tall enough to spare them.
  const budget = Math.min(MAX_DIALOG_ROWS, Math.max(MIN_DIALOG_ROWS, h - 6));
  const listRows = Math.max(
    MIN_LIST_ROWS,
    Math.min(MAX_LIST_ROWS, budget - CHROME_ROWS - Math.max(0, Math.floor(extraRows)))
  );
  return { width, marginLeft, inner: Math.max(8, width - 4), listRows };
}

/**
 * The scroll window for a cursor in a list — the offset that keeps the cursor
 * visible while moving the viewport as little as possible.
 *
 * Pure, and computed rather than held in a ref, because there is no `<scrollbox>`
 * here: eleven rows are sliced out of the array and rendered as plain `<text>`
 * rows. That deletes two measured OpenTUI traps at once — a scrollbox's intrinsic
 * height is its WHOLE content, which starves every sibling in the same column, and
 * its reconciler desyncs when a content-derived key changes under it.
 */
export function scrollWindow(cursor: number, total: number, rows: number): number {
  const size = Math.max(1, Math.floor(rows));
  if (total <= size) return 0;
  const c = Math.max(0, Math.min(total - 1, Math.floor(cursor)));
  // Keep the cursor one row inside the window where there is room, so the next
  // press reveals a row rather than only moving the highlight.
  const top = Math.min(Math.max(0, c - Math.floor(size / 2)), total - size);
  return Math.max(0, top);
}
