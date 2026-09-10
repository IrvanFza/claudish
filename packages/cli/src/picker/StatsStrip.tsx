/** @jsxImportSource @opentui/react */
/**
 * picker/StatsStrip.tsx — the graphics panel that carries the WHOLE-FRAME density
 * count.
 *
 * IT IS HERE PRE-EMPTIVELY, not after a failed screenshot. The aesthetic contract
 * counts graphics rows against text rows twice: once per panel, and then again over
 * the entire capture — and the skill records a build where every panel passed the
 * first count and the frame was still 28 of 38 rows of text. The provider rail is
 * text (a glyph is not a graphic) and the filter, header and footer are text, so a
 * frame of model rows alone sits near the line. Three rows of bar, spark and meter
 * put it clear of it, and they are rows a reader genuinely uses: what the visible
 * list is made of.
 *
 * THE COLLAPSE IS GATED ON HEIGHT, NOT WIDTH. At 80 columns the right-hand column
 * still has ~57 usable cells — ample for a stacked bar and a sparkline. What is
 * scarce at 80×24 is ROWS. So a short terminal drops the BORDER and the `shown` row
 * (whose count the filter strip already prints) and keeps both graphics rows; an
 * earlier design collapsed on width, to one row, and cost the frame exactly the
 * density this panel exists to supply.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { C, isLightTheme } from "../tui/theme.js";
import { darken, lighten } from "../tui/viz/color.js";
import { padStartTo, padTo } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import { Meter, Panel, Sparkline, StackedBar } from "../tui/viz/widgets.js";
import { parseDisplayPrice } from "./rows.js";

/**
 * PRICE BANDS — the second distribution, and the one that replaced a capability bar.
 *
 * MEASURED, twice. The capability mix is a single category on a subscription roster (the
 * discovery path resolves `supportsTools` and nothing else) AND on every aggregator list
 * (the slim catalog carries no `tools` flag at all), so its bar painted one flat
 * rectangle on both — the aesthetic contract's own negative control, twice over, for a
 * fact the per-row `[TRV]` column already states. Price spreads on every real list, it
 * is what a reader is choosing on, and it complements the context bands rather than
 * repeating them.
 *
 * Fixed absolute edges, not quantiles: "under a dollar per million" is a threshold a
 * reader already holds, while a quantile scale would move under them as the list
 * filtered.
 */
const PRICE_BANDS: ReadonlyArray<{ label: string; max: number }> = [
  { label: "free", max: 0.0001 },
  { label: "<$1", max: 1 },
  { label: "<$5", max: 5 },
  { label: "$5+", max: Number.POSITIVE_INFINITY },
];

/**
 * Models with a per-token rate, bucketed. Flat-rate and unpriced rows are excluded.
 *
 * `priceOf` IS THE CALLER'S, and it must be the same function the ROWS print — MEASURED:
 * reading `m.pricing.average` directly banded all 349 of OpenRouter's models as
 * "unpriced" while every row on screen showed a dollar figure, because an aggregator's
 * real rate lives in its `aggregators[]` entry and `resolveProviderDisplayPrice` is the
 * one function allowed to resolve it. A panel that disagrees with the rows above it is
 * worse than no panel.
 */
export function priceMix(
  models: readonly ModelInfo[],
  priceOf: (m: ModelInfo) => string = (m) => m.pricing?.average ?? ""
): number[] {
  const out = PRICE_BANDS.map(() => 0);
  for (const m of models) {
    const display = priceOf(m);
    // `FREE` is the catalog's own normalisation of `$0.00/1M` (`model-loader.ts:550`),
    // so it carries no digits to parse — and dropping it would hide the cheapest band
    // from the bar that exists to show it. `SUB`/`LOCAL` stay excluded: a flat-rate plan
    // has no point on a per-token axis, and putting it at zero would claim it is free.
    const n = display === "FREE" ? 0 : parseDisplayPrice(display);
    if (n === undefined) continue;
    const i = PRICE_BANDS.findIndex((b) => n < b.max);
    out[i < 0 ? PRICE_BANDS.length - 1 : i]! += 1;
  }
  return out;
}

/**
 * Fit a series to a column budget, because a `Sparkline` paints ONE COLUMN PER
 * SAMPLE and cannot apportion (`Meter` and `StackedBar` can; these two cannot).
 *
 * 342 models in a 48-column slot would paint 342 columns and overflow the panel;
 * 12 models in a 48-column slot paint 12 and leave a 36-column hole that a
 * screenshot fails the panel for. So: bucket-average when there are more samples
 * than columns, and hold each sample for several columns when there are fewer.
 * Averaging rather than sampling every Nth, because a decimated series drops the
 * outlier that was the only interesting thing in it.
 */
export function resample(values: readonly number[], width: number): number[] {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0 || values.length === 0) return [];
  if (values.length === cells) return [...values];
  return values.length > cells ? bucketMeans(values, cells) : holdEach(values, cells);
}

/** Mean of the FINITE samples in `[from, to)`, or `NaN` when the bucket has none. */
function meanOf(values: readonly number[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let j = from; j < to && j < values.length; j++) {
    const v = values[j]!;
    if (!Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  return n > 0 ? sum / n : Number.NaN;
}

/** More samples than columns: one bucket per column, averaged. */
function bucketMeans(values: readonly number[], cells: number): number[] {
  const per = values.length / cells;
  const out: number[] = [];
  for (let i = 0; i < cells; i++) {
    const from = Math.floor(i * per);
    out.push(meanOf(values, from, Math.max(from + 1, Math.floor((i + 1) * per))));
  }
  return out;
}

/** Fewer samples than columns: hold each one for as many columns as it is owed. */
function holdEach(values: readonly number[], cells: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells; i++) {
    out.push(values[Math.min(values.length - 1, Math.floor((i * values.length) / cells))]!);
  }
  return out;
}

/**
 * CONTEXT-WINDOW DECADE BUCKETS — a category distribution, which is what a stacked bar
 * is for, and the row that keeps this panel informative on a HOMOGENEOUS list.
 *
 * MEASURED: a subscription roster's capability mix is a single category (the discovery
 * path resolves `supportsTools` and nothing else), so the caps bar alone painted one
 * flat green rectangle — the aesthetic contract's own negative control. Context windows
 * spread across decades on almost every list, including that one (1M × 19, 250K × 2,
 * 131K × 1), so this row carries shape where the other one cannot.
 *
 * Fixed decade edges rather than quantiles of the visible window: the reader is
 * comparing against absolute sizes they already know ("is this a 128 K model or a 1 M
 * one"), and a quantile scale would relabel the same model differently on two screens.
 */
const CTX_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: "<32K", max: 32_000 },
  { label: "128K", max: 200_000 },
  { label: "512K", max: 600_000 },
  { label: "1M+", max: Number.POSITIVE_INFINITY },
];

export function ctxMix(models: readonly ModelInfo[]): number[] {
  const out = CTX_BUCKETS.map(() => 0);
  for (const m of models) {
    const n = m.contextLength ?? 0;
    if (n <= 0) continue;
    const i = CTX_BUCKETS.findIndex((b) => n < b.max);
    out[i < 0 ? CTX_BUCKETS.length - 1 : i]! += 1;
  }
  return out;
}

const LABEL_W = 6;

export interface StatsStripProps {
  /** The list as the user currently sees it — every number here is about THAT. */
  shown: readonly ModelInfo[];
  /** Before the filter, so `shown / total` is a real fraction. */
  total: number;
  /** Outer columns the strip occupies (the model panel's width). */
  width: number;
  /** `true` above `CHROME.statsPanel` rows: a bordered panel and the third row. */
  panelled: boolean;
  /** The SAME price resolver the rows print with — see `priceMix`. */
  priceOf?: (m: ModelInfo) => string;
}

/**
 * Three rows when there is room, two when there is not — and both survivors are
 * graphics rows, which is the property §4.6's arithmetic depends on.
 *
 * Each row is a flex ROW of a label `<text>`, a widget and a legend `<text>`, which
 * is the composition the skill prescribes and the one case where sibling `<text>`s
 * are correct: `flexDirection="row"` means three one-row children need exactly the
 * one row they have, so they cannot starve. The widths are arithmetic because the
 * widgets take cell counts, and they are computed from ONE inner width so the three
 * rows cannot drift apart.
 */
export function StatsStrip({ shown, total, width, panelled, priceOf }: StatsStripProps): ReactNode {
  // `Panel` spends 4 columns (border ×2 + padding ×2); the borderless form spends
  // the 2 columns of `paddingX={1}`.
  const inner = Math.max(12, Math.floor(width) - (panelled ? 4 : 2));
  const prices = priceMix(shown, priceOf);
  const priceLegend = PRICE_BANDS.map((b, i) => `${b.label} ${prices[i]}`).join(" · ");
  const buckets = ctxMix(shown);
  const ctxLegend = CTX_BUCKETS.map((b, i) => `${b.label} ${buckets[i]}`).join(" · ");
  const priceW = Math.max(6, inner - LABEL_W - 1 - priceLegend.length - 1);
  const ctxW = Math.max(6, inner - LABEL_W - 1 - ctxLegend.length - 1);
  const shownLegend = `${shown.length} / ${total}`;
  // Two widgets share the third row, so the width is split between them: a sparkline
  // of the list in display order, then how much of the list the filter left.
  const trendW = Math.max(6, Math.floor((inner - LABEL_W - 4 - shownLegend.length) / 2));
  const meterW = Math.max(6, inner - LABEL_W - 4 - shownLegend.length - trendW);

  // EVERY FILL IS DARKENED, and that is the skill's rule 1 for fills rather than taste:
  // a neon token that reads beautifully as one letter is a slab when it is 40 columns
  // of solid background. MEASURED — the first wide capture painted `C.magenta` across
  // most of the ctx row and `C.green` across most of the caps row, and the two bars
  // became the loudest thing on a screen whose actual signal is the list above them.
  // Darkening keeps the hue identity (which is what the legend names) and returns the
  // contrast to the data. Same 0.45 for every segment, so the segments stay comparable.
  // LIGHTEN ON LIGHT, DARKEN ON DARK — `theming.md`'s `area()` rule, called at RENDER
  // time because `isLightTheme()` fails the same silent way `C.*` does: detection runs
  // after this module is imported, so a value captured at load is the pre-detection
  // default forever. Measured on a white page: the darkened fills read as heavy slabs,
  // which is Jack's recorded complaint about the session card's meters ("the colours are
  // too hard", "the progress bars are too heavy, getting all the attention").
  const fill = (c: string): string => (isLightTheme() ? lighten(c, 0.55) : darken(c, 0.45));
  // Cheap → dear, on the same ramp direction the per-row price meter reads.
  const priceSegments = [
    { value: prices[0]!, color: fill(tokens.success) },
    { value: prices[1]!, color: fill(C.yellow) },
    { value: prices[2]!, color: fill(tokens.warn) },
    { value: prices[3]!, color: fill(tokens.error) },
  ];
  // Small window → cool, large → warm, so the row reads left to right as "how big" —
  // the same direction the per-row context meter reads.
  const ctxSegments = [
    { value: buckets[0]!, color: tokens.border },
    { value: buckets[1]!, color: fill(tokens.running) },
    { value: buckets[2]!, color: fill(tokens.info) },
    { value: buckets[3]!, color: fill(C.magenta) },
  ];
  const ctxSeries = resample(
    shown.map((m) => m.contextLength ?? 0),
    trendW
  );

  const body = (
    <>
      <box flexDirection="row" height={1} gap={1} flexShrink={0}>
        <text fg={tokens.subtle}>{padTo("ctx", LABEL_W)}</text>
        <StackedBar segments={ctxSegments} width={ctxW} />
        <text fg={tokens.trace}>{ctxLegend}</text>
      </box>
      <box flexDirection="row" height={1} gap={1} flexShrink={0}>
        <text fg={tokens.subtle}>{padTo("price", LABEL_W)}</text>
        <StackedBar segments={priceSegments} width={priceW} />
        <text fg={tokens.trace}>{priceLegend}</text>
      </box>
      {panelled ? (
        <box flexDirection="row" height={1} gap={1} flexShrink={0}>
          <text fg={tokens.subtle}>{padTo("trend", LABEL_W)}</text>
          <Sparkline values={ctxSeries} fg={tokens.info} />
          <Meter
            pct={total > 0 ? (100 * shown.length) / total : 0}
            width={meterW}
            ramp={ramps.volume}
          />
          <text fg={tokens.trace}>{padStartTo(shownLegend, shownLegend.length)}</text>
        </box>
      ) : null}
    </>
  );

  if (!panelled) {
    return (
      <box flexDirection="column" paddingX={1} flexShrink={0}>
        {body}
      </box>
    );
  }
  return (
    <box flexShrink={0}>
      <Panel title="shape" flexGrow={1}>
        {body}
      </Panel>
    </box>
  );
}
