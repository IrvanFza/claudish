/**
 * ansi-viz — the viz widgets, rendered as raw ANSI instead of OpenTUI renderables.
 *
 * The session summary prints AFTER the proxy and any renderer are gone, straight into
 * the user's scrollback, so it cannot use `tui/viz/widgets.tsx` — those are React
 * components and there is no renderer left to mount them in. claudish already has this
 * exact split for the probe (`probe-results-printer.ts` prints static ANSI once the
 * OpenTUI phase ends), and it already has the rule that keeps the two honest:
 *
 *   SHARE THE CELL MATHS, NEVER THE DRAWING.
 *
 * So every function here imports the SAME `rampFor` / `fillCells` / `splitCells` /
 * `pickInk` / `displayWidth` the React widgets use, and differs only in emitting
 * `\x1b[38;2;…m` where the widget emits `<span fg=…>`. Two renderers that round
 * independently drift by a cell; two that share the maths cannot.
 */

import { C } from "../tui/theme.js";
import { pickInk } from "../tui/viz/color.js";
import { displayWidth, splitCells } from "../tui/viz/text.js";
import { type Ramp, ramps, tokens } from "../tui/viz/tokens.js";
import { fillCells, rampFor } from "../tui/viz/widgets.js";

export const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const FILL = "█";
const TRACK = "░";
const NODATA = "╌";

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Truecolor foreground SGR for a `#rrggbb`. */
export function fg(hex: string): string {
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Truecolor background SGR for a `#rrggbb`. */
export function bg(hex: string): string {
  const [r, g, b] = rgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Colourise a plain string. */
export function paint(text: string, hex: string, bold = false): string {
  return `${bold ? BOLD : ""}${fg(hex)}${text}${RESET}`;
}

/**
 * Gradient meter — one colour per cell, exactly like `<Meter>`.
 *
 * `pct` is 0..100. `NaN` is ABSENT data and draws a dim `╌` row rather than a track,
 * keeping the widget's distinction between "nothing to report" and "genuinely zero".
 */
export function meter(pct: number, width: number, ramp: Ramp = ramps.load): string {
  const cells = Math.floor(width);
  if (!Number.isFinite(cells) || cells <= 0) return "";
  if (Number.isNaN(pct)) return paint(NODATA.repeat(cells), tokens.dead);

  const cols = rampFor(cells, ramp);
  const filled = fillCells(pct, cells);
  let out = "";
  let last = "";
  for (let i = 0; i < cells; i++) {
    const hex = i < filled ? cols[i]! : tokens.border;
    // Emit an SGR only when the colour actually changes. A 40-cell meter is 40 escapes
    // otherwise, and the unfilled track is one flat colour that never needs repeating.
    if (hex !== last) {
      out += fg(hex);
      last = hex;
    }
    out += i < filled ? FILL : TRACK;
  }
  return out + RESET;
}

/** One category of a `stackedBar`. */
export interface BarSegment {
  value: number;
  color: string;
}

/**
 * Stacked bar — consecutive coloured-space runs, exactly like `<StackedBar>`.
 * Always EXACTLY `width` columns, so nothing to its right can drift.
 */
export function stackedBar(segments: readonly BarSegment[], width: number): string {
  const cells = Math.floor(width);
  if (!Number.isFinite(cells) || cells <= 0 || segments.length === 0) return "";
  const split = splitCells(
    segments.map((s) => s.value),
    cells
  );
  if (split.reduce((a, b) => a + b, 0) === 0) return paint(TRACK.repeat(cells), tokens.border);
  let out = "";
  for (let i = 0; i < split.length; i++) {
    const n = split[i]!;
    if (n > 0) out += `${bg(segments[i]!.color)}${" ".repeat(n)}`;
  }
  return out + RESET;
}

/**
 * Status chip — dark-or-light ink chosen by measured contrast, one space of padding
 * each side, same as `<Badge>`. The ink comes from `pickInk`, so a chip can never end
 * up illegible on a saturated fill the way a fixed threshold allowed.
 *
 * The LIGHT candidate is `C.ink` (white in BOTH themes), not `pickInk`'s default
 * `tokens.text`: on the light palette `tokens.text` is near-black `#1f2937`, which left
 * `pickInk` choosing between two dark inks — a deep fill like the EXIT badge's `#9e2b2b`
 * came out black-on-maroon at 2.8:1. With white as a genuine second candidate the
 * EXIT/FREE fills take white ink (7.4:1 / 6.2:1 on light) and the olive EST fill keeps
 * black (5.0:1); on the dark palette `C.ink === tokens.text` (#ffffff), so the output
 * is byte-identical to what always shipped.
 */
export function badge(label: string, hex: string): string {
  return `${BOLD}${fg(pickInk(hex, tokens.ink, C.ink))}${bg(hex)} ${label} ${RESET}`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI requires them
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Drop SGR sequences so a styled string can be measured. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Display columns of a styled string.
 *
 * Uses `displayWidth` (i.e. `Bun.stringWidth`) rather than `.length`, which is the
 * difference between a box that closes and one that does not: a session title can carry
 * CJK or emoji, where a code-unit count is half or double the real column count.
 * claudish's older `probe-results-printer.ts` helper counts code units and would
 * mis-measure exactly those titles.
 */
export function visibleWidth(s: string): number {
  return displayWidth(stripAnsi(s));
}

/**
 * Clip a STYLED string to `width` visible columns, keeping its escapes intact.
 *
 * `truncate` in `tui/viz/text.ts` cannot do this — it sanitises ESC to a space, which is
 * correct for its contract (plain text in, one clean line out) and destructive here.
 * This walks the string instead, copying SGR sequences through at zero width and
 * counting only what the terminal paints, so a clipped row keeps its colours and always
 * ends with a reset rather than leaking style into the border that follows it.
 *
 * Wide glyphs are never split: a CJK character that would straddle the edge is dropped
 * whole, so the result may be one column short of `width` but is never over.
 */
export function clipStyled(s: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1); // an SGR run costs no columns
      i = end + 1;
      continue;
    }
    const ch = [...s.slice(i)][0] ?? "";
    const cw = displayWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + RESET;
}

/**
 * Pad a styled string to exactly `width` columns, clipping when it is already wider.
 *
 * CLIPPING IS THE POINT, and it was missing. This only ever padded, so every caller was
 * silently trusted to have produced something short enough — and one that did not (a
 * long `mcp__server__tool_name` in the summary's tool legend) pushed a row past the card
 * edge, wrapped it, and destroyed the right border for every row below it.
 */
export function padVisible(s: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = clipStyled(s, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  return align === "left" ? clipped + " ".repeat(pad) : " ".repeat(pad) + clipped;
}

/** Compact byte/'000s formatting: 1_234_567 → "1.2M". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** `12m 34s`, `1h 02m`, `8s`. Zero renders as `—` (not measured), never `0s`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** USD with a precision that suits the magnitude — sub-cent runs are common. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (a < 0.01) return `$${n.toFixed(4)}`;
  if (a < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
