/** @jsxImportSource @opentui/react */
import { createTextAttributes } from "@opentui/core";

/**
 * btop-inspired color palette — true black base, vivid neon colors.
 *
 * 3 text tiers: white (primary) → gray (secondary) → dark-gray (tertiary)
 * Bluish selection highlight like btop.
 */
export const C = {
  bg: "#000000",
  bgAlt: "#111111",
  bgHighlight: "#1e3a5f",
  bgError: "#3a0a14", // faint red-tinted band for failed test rows

  fg: "#ffffff",
  fgMuted: "#a0a0a0",
  dim: "#555555",

  border: "#333333",
  focusBorder: "#57a5ff",

  green: "#39ff14",
  brightGreen: "#55ff55",
  red: "#ff003c",
  yellow: "#fce94f",
  cyan: "#00ffff",
  blue: "#0088ff",
  magenta: "#ff00ff",
  orange: "#ff8800",
  white: "#ffffff",
  black: "#000000",

  // Unified tab theme based on blue
  tabActiveBg: "#0088ff",
  tabInactiveBg: "#001a33",
  tabActiveFg: "#ffffff",
  tabInactiveFg: "#0088ff",

  // Muted pill backgrounds for AUTH column tags. The standard `green` / `cyan`
  // are neon-bright and cause eye strain when used as a solid fill. These
  // are lower-saturation forest/teal versions, contrast-tuned for white text.
  pillKeyBg: "#2d6e3e", // forest green; white text reads cleanly
  pillOauthBg: "#1f6d75", // muted teal; white text reads cleanly

  // Monochrome two-tone footer chip. The key sits on the LIGHTER segment and
  // the label on the DARKER segment; the two abut into one connected pill.
  // Neutral gray (no per-hotkey color) — emphasis comes from text brightness
  // (bright key vs. muted label), not hue.
  chipKeyBg: "#3a3a3a", // lighter gray — key segment
  chipLabelBg: "#222222", // darker gray — label segment
} as const;

const bold = createTextAttributes({ bold: true });

export const A = {
  bold,
  boldIf: (enabled: boolean): number | undefined => (enabled ? bold : undefined),
} as const;

// ---------------------------------------------------------------------------
// Latency → background color buckets
// ---------------------------------------------------------------------------
//
// Used wherever a probe/test latency is shown (--probe TUI chain rows + final
// static table). The `ms` token gets a SOLID background so a fast response and
// a slow-but-successful response read differently at a glance — status color
// (green=live / red=error) alone can't carry "this worked but took 14s".
//
// DISCRETE BUCKETS, not a smooth gradient: a continuous green→red ramp made
// adjacent latencies (976ms vs 2519ms vs 4713ms) look nearly identical. Buckets
// pick visibly DIFFERENT colors per band. Each fill is a mid-lightness color
// chosen to stay readable under white text (neon foregrounds like C.green are
// too bright as a fill — same reasoning as pillKeyBg above).
//
// Thresholds (good → bad):
//   < 500ms        bright green
//   500ms – 1s     green
//   1s   – 3s      yellow
//   3s   – 6s      orange
//   > 6s           red

interface LatencyBucket {
  /** Inclusive upper bound in ms; Infinity for the last bucket. */
  maxMs: number;
  /** `#rrggbb` for OpenTUI `<span bg>`. */
  hex: string;
}

const LATENCY_BUCKETS: LatencyBucket[] = [
  { maxMs: 500, hex: "#1f8f3b" }, // bright green
  { maxMs: 1000, hex: "#2d6e3e" }, // green (matches pillKeyBg family)
  { maxMs: 3000, hex: "#8a7d1e" }, // yellow/olive
  { maxMs: 6000, hex: "#b5651d" }, // orange
  { maxMs: Number.POSITIVE_INFINITY, hex: "#9e2b2b" }, // red
];

function latencyBucket(ms: number): LatencyBucket {
  const v = Math.max(0, ms);
  for (const b of LATENCY_BUCKETS) {
    if (v < b.maxMs) return b;
  }
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]!;
}

/**
 * Human-readable latency: under 1s → "399ms"; 1s and over → "14.34s" (2 dp).
 * No padding — callers pad to align.
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Background color for a latency value as a `#rrggbb` hex string (discrete
 * bucket), suitable for an OpenTUI `<span bg={...}>`.
 */
export function latencyBg(ms: number): string {
  return latencyBucket(ms).hex;
}

/**
 * Background color for a latency value as a raw ANSI truecolor SGR escape
 * (`\x1b[48;2;R;G;Bm`), for the static results printer which emits raw ANSI
 * (not OpenTUI). Pair with `LATENCY_FG_ANSI` + `ANSI_RESET`.
 */
export function latencyBgAnsi(ms: number): string {
  const hex = latencyBucket(ms).hex;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Foreground color to pair with `latencyBg`. Kept light/white across all
 * buckets so the number is always legible; the BACKGROUND carries the
 * good→bad signal, not the text color.
 */
export const latencyFg = "#ffffff";

/** ANSI counterparts for the raw-ANSI printer path. */
export const LATENCY_FG_ANSI = "\x1b[38;2;255;255;255m";
export const ANSI_RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Probe timeline stage colors (network → server → streaming)
// ---------------------------------------------------------------------------
//
// The --probe TUI breaks each successful link into 3 sequential stages and
// renders them as a stacked, shared-scale bar. Segment FILLS use DESATURATED
// mid-lightness backgrounds (not the neon C.cyan/C.blue/C.yellow — those are
// too harsh as solid fills; same rule as pillKeyBg/latencyBg). The breakdown
// NUMBERS use the bright foreground versions so number↔segment is unmistakable.
//
// cool → cool → warm: network (waiting on the wire) → server (model thinking)
// → streaming (the stage actually producing tokens, so it gets the warm hue).
// All three avoid the reserved status colors (green=live, red=fail) and leave
// cyan free for "probing".

// VIVID, saturated fills. These are bg-on-SPACES (no text sits on them), so the
// "desaturate for text readability" rule that governs pillKeyBg/latencyBg does
// NOT apply here — high-contrast hues are exactly what makes the segments pop
// and read distinctly next to each other on the black terminal background.
export const STAGE_BG = {
  network: "#00b3c4", // bright cyan
  server: "#2563ff", // bright blue
  streaming: "#ffcc00", // bright gold/yellow
} as const;

export const STAGE_FG = {
  network: C.cyan,
  server: C.blue,
  streaming: C.yellow,
} as const;

function hexToAnsiBg(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Truecolor FOREGROUND ANSI escape for a `#rrggbb` hex. The raw-ANSI printer
 * uses this for stage labels (STAGE_FG.*) and the tok/s bar/value
 * (throughputFg(ratio)) — so it never hand-rolls colors that drift from the
 * shared palette. Pair with `ANSI_RESET`.
 */
export function hexToAnsiFg(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** ANSI background escapes for the static printer's stage segments. */
export const STAGE_BG_ANSI = {
  network: hexToAnsiBg(STAGE_BG.network),
  server: hexToAnsiBg(STAGE_BG.server),
  streaming: hexToAnsiBg(STAGE_BG.streaming),
} as const;

export type ProbeStageKey = keyof typeof STAGE_BG;

/**
 * Throughput-heat color for a tokens/sec value, on an ABSOLUTE scale (t/s),
 * NOT relative to the run's fastest generator. Relative coloring made every
 * healthy model dim-red whenever one outlier set a high max; absolute coloring
 * reflects "is this throughput actually good." The tok/s BAR stays relative-to-max
 * (that's the comparison), while the COLOR is absolute (that's the health) — the
 * dual encoding is what lets a fast model read warm even next to a faster one.
 * Reuses the muted slow-red so neon C.red stays reserved for outright failure.
 */
export function throughputFg(tokensPerSec: number): string {
  if (tokensPerSec >= 100) return C.brightGreen;
  if (tokensPerSec >= 40) return C.orange;
  return "#9e2b2b"; // muted red (same as the slow latency bucket)
}

// ---------------------------------------------------------------------------
// Shared bar cell-math (pure) — used by BOTH the live TUI (probe-tui-app.tsx)
// and the static printer (probe-results-printer.ts). Centralised here so the
// two renderers can never drift: only the rendering (OpenTUI `<span bg>` vs raw
// ANSI escapes) differs; the cell counts are computed identically.
// ---------------------------------------------------------------------------

/** Per-stage cell counts for a timeline bar; sums exactly to `barCells`. */
export interface StageCells {
  network: number;
  server: number;
  streaming: number;
}

/**
 * Total bar length in cells under a SHARED GLOBAL SCALE: the slowest link in
 * the whole run fills `barWidth`; everything else is proportionally shorter.
 * Clamped to ≥1 so a live link never vanishes.
 *
 *   barCells = clamp(round(B * totalMs / maxTotalMs), 1, B)
 */
export function timelineBarCells(totalMs: number, maxTotalMs: number, barWidth: number): number {
  if (barWidth <= 0) return 0;
  const denom = maxTotalMs > 0 ? maxTotalMs : 1;
  const raw = Math.round((barWidth * Math.max(0, totalMs)) / denom);
  return Math.min(barWidth, Math.max(1, raw));
}

/**
 * Split `barCells` across the 3 sequential stages (network=ttfbMs,
 * server=ttftMs−ttfbMs, streaming=totalMs−ttftMs) by time share using
 * LARGEST-REMAINDER rounding so the parts sum EXACTLY to `barCells`.
 *
 * GUARD: when `barCells >= 3`, every stage with a positive duration gets ≥1
 * cell (stolen from the largest-allocated stage). Below 3 the guard is dropped
 * — the colored breakdown numbers carry the detail for tiny fast bars.
 */
export function splitStageCells(
  ttfbMs: number,
  ttftMs: number,
  totalMs: number,
  barCells: number
): StageCells {
  const net = Math.max(0, ttfbMs);
  const srv = Math.max(0, ttftMs - ttfbMs);
  const str = Math.max(0, totalMs - ttftMs);
  const durations = [net, srv, str];
  const sum = net + srv + str;

  if (barCells <= 0) return { network: 0, server: 0, streaming: 0 };
  if (sum <= 0) {
    // No measurable time — put everything in the first stage so the bar still
    // renders something rather than vanishing.
    return { network: barCells, server: 0, streaming: 0 };
  }

  // Largest-remainder: floor each share, then hand leftover cells to the
  // largest fractional remainders.
  const exact = durations.map((d) => (barCells * d) / sum);
  const floors = exact.map((e) => Math.floor(e));
  let used = floors[0] + floors[1] + floors[2];
  let leftover = barCells - used;
  const remainders = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; k < leftover; k++) {
    floors[remainders[k % 3].i] += 1;
  }

  // Min-1-cell guard for non-zero stages (only when there's room: barCells>=3).
  if (barCells >= 3) {
    for (let i = 0; i < 3; i++) {
      if (durations[i] > 0 && floors[i] === 0) {
        // Steal one cell from the currently largest-allocated stage.
        let donor = 0;
        for (let j = 1; j < 3; j++) {
          if (floors[j] > floors[donor]) donor = j;
        }
        if (floors[donor] > 1) {
          floors[donor] -= 1;
          floors[i] += 1;
        }
      }
    }
  }

  used = floors[0] + floors[1] + floors[2];
  leftover = barCells - used;
  // Safety: if rounding/guard drift left a tiny surplus or deficit, settle it
  // on the largest-duration stage so the parts still sum to barCells.
  if (leftover !== 0) {
    let big = 0;
    for (let j = 1; j < 3; j++) if (durations[j] > durations[big]) big = j;
    floors[big] = Math.max(0, floors[big] + leftover);
  }

  return { network: floors[0], server: floors[1], streaming: floors[2] };
}

/**
 * Tok/s bar length under a shared scale (opposite polarity — long = good):
 *
 *   tokCells = clamp(round(T * tokensPerSec / maxTokPerSec), 0, T)
 *
 * Note: the 50ms streaming floor is applied to the SCALE denominator
 * (`maxTokPerSec`) by the caller — NOT here. This uses the raw tokensPerSec;
 * the clamp absorbs any artifact link.
 */
export function tokBarCells(tokensPerSec: number, maxTokPerSec: number, tokWidth: number): number {
  if (tokWidth <= 0) return 0;
  const denom = maxTokPerSec > 0 ? maxTokPerSec : 1;
  const raw = Math.round((tokWidth * Math.max(0, tokensPerSec)) / denom);
  return Math.min(tokWidth, Math.max(0, raw));
}
