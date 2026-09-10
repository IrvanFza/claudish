/** @jsxImportSource @opentui/react */
/**
 * picker/rows.tsx — one model row, one provider rail row, and the pure arithmetic
 * behind both.
 *
 * A RENDERING CHANGE, NOT A DATA CHANGE — which is the single largest risk
 * reduction available in this feature. The row the old picker printed was
 * `kimi@kimi-k3 ($9.00/1M, 1M [TRV], 2026-07)`: a price, a context window, three
 * capability flags and a release date, four visual encodings concatenated into one
 * parenthetical string. Every value a rich row needs therefore ALREADY reaches the
 * view, so this file adds no fetch, no field and no plumbing, and a row regression
 * can only ever be visual.
 *
 * ONE `<text>` PER ROW, ALWAYS. Yoga claws columns back from the LAST `<text>`
 * child of a row, which is how a branch name once rendered as `mai` with thirty
 * free columns beside it (`resume-picker.tsx:473-484`). So every cell is a
 * `<span>` inside a single text node, and the widgets used here are the `*Span`
 * twin `MeterSpan` — never `Meter`, which is a `<text>` and
 * cannot nest.
 *
 * COLOUR IS READ AT RENDER TIME, never captured in a module-level `const`:
 * `C`/`tokens` are reassigned in place when the terminal theme is detected, and a
 * snapshot taken at import would ship the dark palette to a light terminal. That
 * bug has been found six times in this repo, once visible only in a live
 * screenshot.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { A, C } from "../tui/theme.js";
import { padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import { MeterSpan } from "../tui/viz/widgets.js";
import type { BillingMode } from "./PickerDataSource.js";
import type { RailLayout, RowLayout } from "./layout.js";

/** Readiness, in `ProvidersContent.tsx:225`'s exact vocabulary. */
export type Readiness = "pending" | "ready" | "missing";

/**
 * LOG-SCALED, and that is not a refinement — it is what makes the column readable.
 *
 * A picker list spans 8 K (a small local pull) to 1 M (Gemini): two and a half
 * decades. On a linear scale every model except the top one paints at or near zero,
 * so the meter would carry no information for 95% of the rows while looking like it
 * did. On a log scale the decades are evenly spaced and a 128 K model reads as
 * visibly larger than a 32 K one.
 *
 * Bounds come from the CURRENTLY FILTERED list, so the column re-scales as the user
 * narrows it — the comparison a reader is making is always against what they can
 * see. A degenerate range (one row, or every row identical) yields 100: a full bar
 * is the honest answer when the largest thing visible is also the smallest.
 *
 * THE SCALE'S FLOOR IS AT LEAST SIX DOUBLINGS BELOW THE LARGEST, never simply the
 * list's own minimum — MEASURED on the first capture. A roster of 250 K and 1 M models
 * scaled to its own bounds paints every 250 K row at exactly 0%: an empty track, which
 * is the glyph `Meter` uses for "nothing", under a numeral that says 250 K. The column
 * stops carrying information precisely when the list is homogeneous, which is most
 * lists. Anchoring the floor at `max / 64` makes the bar mean something stable — "how
 * big, on a log scale spanning at least six doublings" — and the 250 K row reads at two
 * thirds instead of at zero.
 *
 * `NaN` for an absent window, deliberately: `MeterSpan` paints `NaN` as a dim `╌`
 * run, while 0 paints the same full `░` track a healthy-but-tiny window paints.
 * Absent data and small data must not look alike.
 */
export function contextMeterPct(ctx: number | undefined, min: number, max: number): number {
  if (!ctx || !Number.isFinite(ctx) || ctx <= 0) return Number.NaN;
  if (!Number.isFinite(max) || max <= 0) return 100;
  const lo = Math.min(Number.isFinite(min) && min > 0 ? min : max, max / 64);
  if (max <= lo) return 100;
  const pct = (100 * (Math.log(ctx) - Math.log(lo))) / (Math.log(max) - Math.log(lo));
  return Math.min(100, Math.max(0, pct));
}

/**
 * THE FILL IS CHEAPNESS, NOT COST, and the ramp is why.
 *
 * `ramps.savings` runs red → yellow → green, so a FULL bar is green. A meter
 * colours cells by position along the fill, so if length encoded cost the dearest
 * model on screen would paint a full green bar — red meaning "cheap" on one row and
 * green meaning "expensive" on the next, which is the one-colour-one-meaning rule
 * broken inside a single column. Encoding cheapness instead makes a long green bar
 * "costs you least" and a one-cell red stub "costs you most", which is both true
 * and the direction a reader scanning for a cheap model wants.
 *
 * Log-scaled for the same reason as the context meter: per-token prices on one
 * screen span $0.05 to $15 per million.
 */
export function priceMeterPct(price: number | undefined, min: number, max: number): number {
  if (price === undefined || !Number.isFinite(price) || price < 0) return Number.NaN;
  if (price === 0) return 100;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) return 100;
  const clamped = Math.min(Math.max(price, min), max);
  const t = (Math.log(clamped) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return Math.min(100, Math.max(0, 100 * (1 - t)));
}

/**
 * `$9.00/1M` → 9. `SUB`, `LOCAL`, `N/A` → undefined.
 *
 * Parsed rather than plumbed because `resolveProviderDisplayPrice` is the ONE
 * function allowed to decide what a row costs (its `isSubscriptionProvider`-first
 * rule is test-pinned), and it answers a display string. Re-deriving the number
 * from a second source would be a second opinion about money.
 */
export function parseDisplayPrice(display: string): number | undefined {
  const m = /\d+(\.\d+)?/.exec(display);
  if (!m) return undefined;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** The rail's billing tag — right-aligned text, the colour carrying the meaning. */
export function billingTag(mode: BillingMode): { text: string; fg: string } {
  if (mode === "sub") return { text: "SUB", fg: tokens.success };
  if (mode === "local") return { text: "LOCAL", fg: tokens.running };
  return { text: "$", fg: tokens.subtle };
}

/** `●` ready · `○` needs a key · `◌` probe in flight — `ProvidersContent.tsx:225`. */
export function readinessGlyph(r: Readiness): { glyph: string; fg: string } {
  if (r === "ready") return { glyph: "●", fg: tokens.success };
  if (r === "missing") return { glyph: "○", fg: tokens.dead };
  return { glyph: "◌", fg: tokens.warn };
}

/** Where a list came from — the one value that drives all three fallback encodings. */
export type ListOrigin = "roster" | "catalog";

/**
 * A flat-rate price gets a dim `╌` run where the METER would be, and its word in
 * `tokens.success` where the numeral would be — never a 0% or zero-width meter. A
 * subscription has no per-token number, and an empty bar in the cheapness column would
 * read as "the cheapest thing on screen", which is a different claim from "this is not
 * billed per token". `Meter` makes the same distinction for `NaN`, in the same glyph.
 *
 * NOT A `BadgeSpan`, AND THAT IS MEASURED. The first capture rendered ` SUB ` as a chip
 * on all 21 rows of a subscription provider's roster, and the chips — adjacent rows,
 * same fill, no gap between them — fused into one solid green RECTANGLE down the price
 * column with the labels floating in it. That is the failure `viz/widgets.tsx` records
 * for 24 `UP` chips in a service list, arriving vertically instead of horizontally. A
 * chip is for a status that DISTINGUISHES a row; when every row carries it, the chip is
 * a wall. The rail's per-provider `SUB` tag already says it once, where it is true of
 * the provider rather than of each model.
 */
function isFlatRateLabel(priceText: string): boolean {
  return priceText === "SUB" || priceText === "LOCAL" || priceText === "FREE";
}

/** Flat rate is `success` (it costs nothing more), absent is `dead`, a rate is body ink. */
function priceFg(priceText: string, flat: boolean): string {
  if (flat) return tokens.success;
  return priceText === "N/A" ? tokens.dead : tokens.text;
}

export interface ModelRowProps {
  model: ModelInfo;
  layout: RowLayout;
  cursor: boolean;
  /** 0–100, or `NaN` for an absent window. From `contextMeterPct`. */
  ctxPct: number;
  /** 0–100, `NaN` when there is no per-token rate to compare. */
  pricePct: number;
  /** Whatever `resolveProviderDisplayPrice` said — `SUB`, `$1.25/1M`, `N/A`. */
  priceText: string;
  /** `catalog` adds the `CAT` chip that says this row is not the live roster. */
  origin: ListOrigin;
}

export function ModelRow({
  model,
  layout,
  cursor,
  ctxPct,
  pricePct,
  priceText,
  origin,
}: ModelRowProps): ReactNode {
  // Render-time reads — see the file header.
  const idFg = cursor ? C.strong : tokens.text;
  const flat = isFlatRateLabel(priceText);

  // THE WASH LIVES ON THE BOX, not on the `<text>`: a text node is only as wide as
  // its content, so a row highlighted that way stops at its last glyph and reads as
  // a floating chip rather than as a bar. The box fills the panel's width — which is
  // why the panel is `flush`, so there is no padding gutter to break the band — and
  // `height={1}` keeps a row from overprinting its neighbour. Same construction as
  // `resume-picker.tsx:999`.
  return (
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        <span fg={idFg}>{padTo(model.id, layout.id)}</span>
        <span> </span>
        <MeterSpan pct={ctxPct} width={layout.ctx} ramp={ramps.volume} />
        <span> </span>
        <span fg={tokens.subtle}>{padStartTo(model.context || "N/A", layout.ctxNum)}</span>
        {layout.price > 0 ? <span> </span> : null}
        {layout.price > 0 && flat ? <span fg={tokens.dead}>{"╌".repeat(layout.price)}</span> : null}
        {layout.price > 0 && !flat ? (
          <MeterSpan pct={pricePct} width={layout.price} ramp={ramps.savings} />
        ) : null}
        <span> </span>
        <span fg={priceFg(priceText, flat)}>{padStartTo(priceText, layout.priceNum)}</span>
        {layout.caps > 0 ? <span> </span> : null}
        {layout.caps > 0 ? capsCell(model, layout.caps) : null}
        {layout.date > 0 ? <span> </span> : null}
        {layout.date > 0 ? (
          <span fg={tokens.trace}>
            {padStartTo(model.releaseDate ? model.releaseDate.slice(0, 7) : "—", layout.date)}
          </span>
        ) : null}
        {layout.mark > 0 ? <span> </span> : null}
        {layout.mark > 0 ? (
          <span fg={tokens.warn} attributes={A.boldIf(origin === "catalog")}>
            {padStartTo(origin === "catalog" ? "cat" : "", layout.mark - 1)}
          </span>
        ) : null}
      </text>
    </box>
  );
}

/**
 * THE `cat` MARK SAYS "THIS ROW IS NOT THE LIVE ROSTER", in the warn colour, on every
 * row of a fallback list — and it is TEXT rather than a chip for the third time in this
 * file, for the reason the other two record.
 *
 * MEASURED: as a `BadgeSpan` it was right on the four-row Kimi fallback and wrong on the
 * seventeen-row OpenRouter one, where seventeen identical orange chips in adjacent rows
 * fused into a solid slab down the panel — louder than the list it was annotating, and
 * no longer reading as seventeen labels. A chip marks a row that DIFFERS from its
 * neighbours; a whole-list property gets a coloured word. The loud encodings of this
 * same fact are the panel title and the banner, which appear once each.
 *
 * The column is reserved on BOTH kinds of list (it renders blank on a live one), so the
 * cells left of it do not move between them.
 *
 * Defect 4 of the measured failure is that a cloud-catalog fallback list renders
 * identically to a healthy roster — prices, descriptions, the lot — so the eye goes
 * to the list, the list looks fine, and it is simply short. That is the user's
 * complaint verbatim. Three encodings fix it and all three derive from ONE value (the
 * outcome variant that produced the list): the panel title, the banner's provenance
 * sentence, and this chip.
 *
 * Outside the budget because the budget is EXACT: a provenance cell that consumed
 * columns would re-size every other cell between a live list and a fallback list, so
 * the two would not be visually comparable. Overflow clips at the panel edge, which
 * is the failure mode every widget in `viz/` prefers — visible, and attributable to
 * the row.
 */

/**
 * `[TRV]` — one letter per capability, bright when present, `tokens.dead` when not.
 * Five columns for all three flags, identical at every width.
 *
 * DELIBERATELY NOT `BadgeSpan` CHIPS, AND THAT IS MEASURED. The first wide capture
 * rendered the capability column as three chips per row, and because every model in a
 * roster carries the same capability, the `T` chips down 21 adjacent rows fused into
 * one solid green RECTANGLE — `viz/widgets.tsx`'s measured 24-`UP`-chips failure,
 * arriving vertically. The general rule this settles: a chip marks a row that DIFFERS
 * from its neighbours; a per-row ATTRIBUTE column, where every row has a value, uses
 * coloured glyphs. The one chip left in a model row is `CAT`, which marks a whole list
 * whose provenance the reader must not miss.
 *
 * It still survives greyscale and colour-blindness, because the letters are the label:
 * `[T··]` and `[TRV]` differ in glyphs, not only in hue.
 */
function capsCell(model: ModelInfo, width: number): ReactNode {
  const flags: Array<{ label: string; on: boolean; color: string }> = [
    { label: "T", on: model.supportsTools === true, color: tokens.success },
    { label: "R", on: model.supportsReasoning === true, color: tokens.running },
    { label: "V", on: model.supportsVision === true, color: C.magenta },
  ];
  return (
    <>
      <span fg={tokens.trace}>{"["}</span>
      {flags.map((f) => (
        <span key={f.label} fg={f.on ? f.color : tokens.dead}>
          {f.label}
        </span>
      ))}
      <span fg={tokens.trace}>{"]"}</span>
      {width > 5 ? <span>{" ".repeat(width - 5)}</span> : null}
    </>
  );
}

export interface RailRowProps {
  label: string;
  readiness: Readiness;
  billing: BillingMode;
  /** Served-model count once a list for this provider has landed; `null` until then. */
  count: number | null;
  cursor: boolean;
  focused: boolean;
  layout: RailLayout;
}

/**
 * One provider. The glyph is readiness, the tag is billing, the count is how many
 * models this session has actually seen for it — `null`, drawn `—`, until a list
 * lands, because a count invented before the list is a number with no source.
 *
 * The cursor wash is `bgHighlight` while the rail has focus and the quieter `bgAlt`
 * while the model pane does, so the screen always shows exactly one active cursor.
 */
export function ProviderRailRow({
  label,
  readiness,
  billing,
  count,
  cursor,
  focused,
  layout,
}: RailRowProps): ReactNode {
  const { glyph, fg } = readinessGlyph(readiness);
  const tag = billingTag(billing);
  return (
    <box
      height={1}
      flexShrink={0}
      backgroundColor={cursor ? (focused ? C.bgHighlight : C.bgAlt) : undefined}
    >
      <text attributes={A.boldIf(cursor)}>
        <span fg={fg}>{glyph}</span>
        <span> </span>
        <span fg={cursor ? tokens.accent : tokens.text}>{padTo(label, layout.label)}</span>
        {layout.tag > 0 ? <span> </span> : null}
        {layout.tag > 0 ? <span fg={tag.fg}>{padStartTo(tag.text, layout.tag)}</span> : null}
        {layout.count > 0 ? <span> </span> : null}
        {layout.count > 0 ? (
          <span fg={tokens.subtle}>
            {padStartTo(count === null ? "—" : String(count), layout.count)}
          </span>
        ) : null}
      </text>
    </box>
  );
}

/**
 * A dim, NON-SELECTABLE row for something the rail is deliberately not listing —
 * the providers with no credential, collapsed, and the local providers that are in
 * the catalog but not enabled in config.
 *
 * An unexplained absence is the defect class this whole feature is about, so the
 * rail says the number out loud. It stays unselectable because a row that cannot be
 * picked must not look like one that can: offering it would trade a silent absence
 * for a dead end.
 */
export function RailHintRow({ text, width }: { text: string; width: number }): ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.trace}>{truncate(text, width)}</span>
      </text>
    </box>
  );
}
