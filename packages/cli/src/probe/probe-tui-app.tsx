/** @jsxImportSource @opentui/react */
/**
 * Probe TUI — React component tree rendered with @opentui/react.
 *
 * Renders the LIVE phase only: banner, pipeline steps, and animated progress
 * bars. Once all probes settle, cli.ts shuts down this OpenTUI renderer and
 * prints the static results table via `probe-results-printer.ts`. Doing the
 * final render as plain ANSI avoids an OpenTUI in-place reconciliation bug
 * that garbled the results panel when the component tree changed shape
 * between phases.
 */

import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  A,
  C,
  latencyBg,
  latencyFg,
  formatLatency,
  STAGE_BG,
  STAGE_FG,
  throughputFg,
  timelineBarCells,
  splitStageCells,
  tokBarCells,
} from "../tui/theme.js";
import { STREAM_MS_FLOOR, type ProbeTiming } from "../providers/probe-live.js";
import { VERSION } from "../version.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ProbeStepState {
  name: string;
  status: "pending" | "running" | "done" | "error";
}

export interface ProbeLinkState {
  id: string;
  /** Grouping key — the user-facing model input, e.g. "gpt-4o" */
  model: string;
  /** Provider display name, e.g. "LiteLLM" */
  displayName: string;
  /** Pinned model spec, e.g. "litellm@gpt-4o" */
  modelSpec: string;
  status: "waiting" | "probing" | "live" | "failed";
  startTime?: number;
  endTime?: number;
  error?: string;
  /** Granular timing breakdown — present on "live" links (threaded from cli.ts). */
  timing?: ProbeTiming;
}

export interface ProbeAppState {
  steps: ProbeStepState[];
  links: ProbeLinkState[];
}

// ── External store ──────────────────────────────────────────────────

/**
 * A tiny observable state holder. Lives outside React so imperative async
 * code in cli.ts can mutate state via setState() and trigger re-renders.
 */
export class ProbeStore {
  private state: ProbeAppState;
  private listeners: Set<() => void> = new Set();

  constructor(initial: ProbeAppState) {
    this.state = initial;
  }

  getState(): ProbeAppState {
    return this.state;
  }

  setState(updater: (prev: ProbeAppState) => ProbeAppState): void {
    this.state = updater(this.state);
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export function useProbeStore(store: ProbeStore): ProbeAppState {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.getState();
}

/** Bumps a counter every 100ms while active — used for progress bar animation and elapsed timers. */
export function useAnimationFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % 1_000_000), 100);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

// ── Helpers ────────────────────────────────────────────────────────

const ANIM_FRAMES = ["\u2593", "\u2592", "\u2591", "\u2592"]; // ▓ ▒ ░ ▒
// Aligned-columns layout (>=100 cols). The narrow-degradation ladder shrinks /
// drops these per terminal width (see deriveLayout below).
const TIMELINE_BAR_FULL = 24; // B
const TIMELINE_BAR_NARROW = 12; // B when <80 cols
const TOK_BAR_FULL = 14; // T
const TOTAL_COL = 7; // right-aligned "14.34s"
// Each stage number is right-aligned to STAGE_NUM_W so the inner net/srv/str
// columns line up across rows. W=6 fits the realistic worst case "21.05s".
const STAGE_NUM_W = 6;
// Breakdown column = "  net " (6) + W + " srv " (5) + W + " str " (5) + W.
const BREAKDOWN_COL = 16 + 3 * STAGE_NUM_W;
const TOK_VALUE_COL = 7; // right-aligned "999 t/s"
const TRACK_CHAR = "·"; // · dim idle track
const BAR_FILL = "█"; // █ tok/s fill mark

/** Per-width layout tier for the aligned-columns probe rows. */
interface ProbeLayout {
  /** Timeline bar width B (0 = drop the timeline bar entirely). */
  barWidth: number;
  /** Tok/s bar width T (0 = drop the tok/s bar, keep the number). */
  tokWidth: number;
  /** Whether to render the colored net/srv/str breakdown column. */
  showBreakdown: boolean;
  /** Whether to fall back to today's single latency pill (<60 cols). */
  pillFallback: boolean;
}

/**
 * Narrow-degradation ladder, keyed on terminal width:
 *   >=100 -> B=24, T=14, full breakdown
 *   <100  -> drop tok/s BAR (keep the number)
 *   <80   -> shrink B 24->12, drop BREAKDOWN
 *   <60   -> drop timeline bar too; single latency pill
 * PROV + TOTAL + status never drop.
 */
function deriveLayout(width: number): ProbeLayout {
  if (width < 60) {
    return { barWidth: 0, tokWidth: 0, showBreakdown: false, pillFallback: true };
  }
  if (width < 80) {
    return {
      barWidth: TIMELINE_BAR_NARROW,
      tokWidth: 0,
      showBreakdown: false,
      pillFallback: false,
    };
  }
  if (width < 100) {
    return {
      barWidth: TIMELINE_BAR_FULL,
      tokWidth: 0,
      showBreakdown: true,
      pillFallback: false,
    };
  }
  return {
    barWidth: TIMELINE_BAR_FULL,
    tokWidth: TOK_BAR_FULL,
    showBreakdown: true,
    pillFallback: false,
  };
}

/** Compute the full row width for a given layout + name column width, so the
 *  model header bar spans exactly the row. */
function computeRowWidth(layout: ProbeLayout, maxNameLen: number): number {
  // [4 indent][5 MM:SS][2 gap][N name][2 gap]
  let w = 4 + 5 + 2 + maxNameLen + 2;
  if (layout.pillFallback) {
    // name + total pill only (status carried by the pill / status text).
    w += TOTAL_COL + 2 + 25; // total + gap + generous status span
    return w;
  }
  // [B timeline][2 gap][7 TOTAL]
  w += layout.barWidth + 2 + TOTAL_COL;
  if (layout.showBreakdown) {
    // BREAKDOWN_COL already includes its own leading "  " gap (the "  net …").
    w += BREAKDOWN_COL;
  } else {
    // No breakdown → the 2-space gap before the tok column lives here instead.
    w += 2;
  }
  if (layout.tokWidth > 0) {
    // [T TOK bar][1 gap]
    w += layout.tokWidth + 1;
  }
  // [7 t/s value]
  w += TOK_VALUE_COL;
  return w;
}

/** Right-align a plain string into `n` columns (truncate if longer). */
function padStartSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(s.length - n);
  return " ".repeat(n - s.length) + s;
}

/** Breakdown number for one stage: bare integer ms, or formatLatency form
 *  (e.g. "3.10s") once it crosses 1000ms. */
function breakdownNum(ms: number): string {
  if (ms >= 1000) return formatLatency(ms);
  return `${Math.round(Math.max(0, ms))}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function padEndSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ── Banner ─────────────────────────────────────────────────────────

function Banner() {
  // Big "CLAUD" in orange block letters (6 rows, ~42 cols wide), with a smaller
  // "ish" in green half-block letters — matching the official claudish wordmark
  // where "ish" sits as a small lowercase suffix at the baseline of CLAUD.
  //
  // The "ish" letters use half-block Unicode chars (▀▄█) to pack 6 pixel rows
  // into 3 terminal rows — giving the same vertical pixel density as CLAUD
  // while being visually half the height. "ish" is placed on rows 4-6 of the
  // 6-row CLAUD block (baseline-aligned to CLAUD's bottom).
  const claudLines = [
    "   \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D",
    "   \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D ",
  ];

  // "ish" rendered as 4 rows of clean serifed ASCII text. Positioned on rows
  // 3-6 of the 6-row CLAUD block (one row lower than before, baseline-aligned
  // to CLAUD's bottom). Each row is wrapped in a brown-background box.
  //
  //   _    _
  //  (_)__| |_
  //  | (_-< ' \
  //  |_/__/_||_|
  const ishLines = [
    "  _    _    ",
    " (_)__| |_  ",
    " | (_-< ' \\ ",
    " |_/__/_||_|",
  ];

  const ishPad = "  "; // 2 spaces between CLAUD and "ish"
  const ishGreen = "#00ff7f"; // bright spring green — pops against dark terminal bg

  // Render one banner row as: orange CLAUD text + gap + bold bright-green ish text.
  const renderBannerRow = (claudLine: string, ishLine: string | null, key: number) => (
    <box key={key} flexDirection="row">
      <text><span fg={C.orange}>{claudLine}</span></text>
      {ishLine !== null && (
        <>
          <text>{ishPad}</text>
          <text><span fg={ishGreen} attributes={A.bold}>{ishLine}</span></text>
        </>
      )}
    </box>
  );

  return (
    <box flexDirection="column">
      {renderBannerRow(claudLines[0], null, 0)}
      {renderBannerRow(claudLines[1], null, 1)}
      {renderBannerRow(claudLines[2], ishLines[0], 2)}
      {renderBannerRow(claudLines[3], ishLines[1], 3)}
      {renderBannerRow(claudLines[4], ishLines[2], 4)}
      {renderBannerRow(claudLines[5], ishLines[3], 5)}
      <text>
        <span fg={C.dim}>{"  Provider Routing Probe"}</span>
        <span fg={C.dim}>{" ".repeat(38)}</span>
        <span fg={C.dim}>{`v${VERSION}`}</span>
      </text>
    </box>
  );
}

// ── Step indicator ─────────────────────────────────────────────────

function StepIndicator({ step }: { step: ProbeStepState }) {
  const iconMap: Record<ProbeStepState["status"], string> = {
    pending: "\u25CB",
    running: "\u25CC",
    done: "\u2713",
    error: "\u2717",
  };
  const colorMap: Record<ProbeStepState["status"], string> = {
    pending: C.dim,
    running: C.cyan,
    done: C.green,
    error: C.red,
  };
  return (
    <text>
      <span>{"  "}</span>
      <span fg={colorMap[step.status]}>
        {iconMap[step.status]} {step.name}
      </span>
    </text>
  );
}

// ── Progress bar row ───────────────────────────────────────────────

/**
 * One aligned-columns row per link. Layout (>=100 cols):
 *
 *   [4 indent][5 MM:SS][2][N name][2][B TIMELINE bar][2][7 TOTAL][2]
 *   [22 BREAKDOWN][2][T TOK/S bar][1][7 "NNN t/s"]
 *
 * - TIMELINE bar: stacked 3-segment bg-on-spaces bar on a shared global scale
 *   (slowest link in the run = full B). Trailing cells = dim track.
 * - TOK/S bar: fg block on a dim track, shared scale (fastest generator = full
 *   T). A brightGreen dot follows the t/s value of the run-fastest live link.
 * - Non-live rows keep the columns but blank both bars to a dim track.
 */
function ProgressBar({
  link,
  animFrame,
  maxNameLen,
  layout,
  maxTotalMs,
  maxTokPerSec,
  isRunFastest,
}: {
  link: ProbeLinkState;
  animFrame: number;
  maxNameLen: number;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
  isRunFastest: boolean;
}) {
  const elapsedMs =
    link.status === "waiting"
      ? 0
      : link.startTime
        ? (link.endTime ?? Date.now()) - link.startTime
        : 0;
  const elapsed = formatElapsed(elapsedMs);
  const displayName = padEndSafe(link.displayName, maxNameLen);

  const prefix = (
    <>
      <span fg={C.dim}>{`    ${elapsed}  `}</span>
      <span fg={C.fg}>{displayName}</span>
      <span fg={C.dim}>{"  "}</span>
    </>
  );

  // \u2014\u2014 <60 col fallback: name + single latency pill (today's behavior) \u2014\u2014
  if (layout.pillFallback) {
    if (link.status === "live") {
      const latency = link.timing?.totalMs ?? elapsedMs;
      return (
        <text>
          {prefix}
          <span fg={C.green}>{"\u2713 live \u00B7 "}</span>
          <span fg={latencyFg} bg={latencyBg(latency)}>
            {` ${formatLatency(latency)} `}
          </span>
        </text>
      );
    }
    return (
      <text>
        {prefix}
        {renderNonLiveStatus(link, /* hasSlot */ false)}
      </text>
    );
  }

  // \u2014\u2014 Non-live rows: blank both bars to a track, keep alignment \u2014\u2014
  // The TIMELINE slot carries the failed reason, so the status is a bare \u2717.
  if (link.status !== "live" || !link.timing) {
    return (
      <text>
        {prefix}
        {renderTimelineSlot(link, animFrame, layout.barWidth)}
        <span fg={C.dim}>{"  "}</span>
        {renderNonLiveStatus(link, /* hasSlot */ true)}
      </text>
    );
  }

  // \u2014\u2014 Live row: full aligned columns \u2014\u2014
  const t = link.timing;
  const barCells = timelineBarCells(t.totalMs, maxTotalMs, layout.barWidth);
  const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
  const trackCells = Math.max(0, layout.barWidth - barCells);

  const netMs = Math.max(0, t.ttfbMs);
  const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
  const strMs = Math.max(0, t.totalMs - t.ttftMs);

  // Bar length relative-to-max (comparison); color absolute (throughput health).
  const tokColor = throughputFg(t.tokensPerSec);
  const tokCells =
    layout.tokWidth > 0
      ? tokBarCells(t.tokensPerSec, maxTokPerSec, layout.tokWidth)
      : 0;
  const tokTrack = Math.max(0, layout.tokWidth - tokCells);
  const tokValue = padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, TOK_VALUE_COL);

  // BREAKDOWN: build the three colored numbers, then pad the whole column to a
  // FIXED BREAKDOWN_COL width with a trailing dim spacer so every column to the
  // right stays aligned (and the row never exceeds rowWidth, which would break
  // the header bar span). A stage \u22651000ms can widen a number, so the spacer is
  // clamped to \u22650.
  // Each number is right-aligned to a FIXED sub-width so the net/srv/str inner
  // columns line up across every row (e.g. "srv 1" / "srv 310" / "srv 939" all
  // end at the same x). Without per-field padding the labels after them drift
  // row-to-row — that was the visible misalignment. STAGE_NUM_W fits "21.05s".
  const netStr = padStartSafe(breakdownNum(netMs), STAGE_NUM_W);
  const srvStr = padStartSafe(breakdownNum(srvMs), STAGE_NUM_W);
  const strStr = padStartSafe(breakdownNum(strMs), STAGE_NUM_W);

  return (
    <text>
      {prefix}
      {/* TIMELINE bar \u2014 bg-on-spaces segments + dim track */}
      {stages.network > 0 && (
        <span bg={STAGE_BG.network}>{" ".repeat(stages.network)}</span>
      )}
      {stages.server > 0 && (
        <span bg={STAGE_BG.server}>{" ".repeat(stages.server)}</span>
      )}
      {stages.streaming > 0 && (
        <span bg={STAGE_BG.streaming}>{" ".repeat(stages.streaming)}</span>
      )}
      {trackCells > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(trackCells)}</span>}
      <span fg={C.dim}>{"  "}</span>
      {/* TOTAL \u2014 right-aligned, white */}
      <span fg={C.white}>{padStartSafe(formatLatency(t.totalMs), TOTAL_COL)}</span>
      {/* BREAKDOWN \u2014 net/srv/str, each number STAGE_FG-colored, padded to a
          fixed BREAKDOWN_COL width via a trailing dim spacer. */}
      {layout.showBreakdown && (
        <>
          <span fg={C.dim}>{"  net "}</span>
          <span fg={STAGE_FG.network}>{netStr}</span>
          <span fg={C.dim}>{" srv "}</span>
          <span fg={STAGE_FG.server}>{srvStr}</span>
          <span fg={C.dim}>{" str "}</span>
          <span fg={STAGE_FG.streaming}>{strStr}</span>
        </>
      )}
      {/* TOK/S bar \u2014 fg block on dim track, heat-colored */}
      {layout.tokWidth > 0 && (
        <>
          <span fg={C.dim}>{"  "}</span>
          {tokCells > 0 && <span fg={tokColor}>{BAR_FILL.repeat(tokCells)}</span>}
          {tokTrack > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(tokTrack)}</span>}
          <span fg={C.dim}>{" "}</span>
        </>
      )}
      {layout.tokWidth === 0 && <span fg={C.dim}>{"  "}</span>}
      {/* TOK/S value \u2014 same heat color; brightGreen dot if run-fastest */}
      <span fg={tokColor}>{tokValue}</span>
      {isRunFastest && <span fg={C.brightGreen}>{" \u25CF"}</span>}
    </text>
  );
}

/** TIMELINE slot for a non-live link \u2014 keeps the bar column aligned. */
function renderTimelineSlot(
  link: ProbeLinkState,
  animFrame: number,
  barWidth: number,
) {
  if (barWidth <= 0) return null;
  switch (link.status) {
    case "probing": {
      let animated = "";
      for (let i = 0; i < barWidth; i++) {
        animated += ANIM_FRAMES[(animFrame + i) % ANIM_FRAMES.length];
      }
      return <span fg={C.cyan}>{animated}</span>;
    }
    case "failed":
      return (
        <span fg={C.red}>
          {padEndSafe(`\u2717 ${stripAnsi(link.error || "failed")}`, barWidth)}
        </span>
      );
    case "waiting":
    default:
      return <span fg={C.dim}>{"\u2591".repeat(barWidth)}</span>;
  }
}

/**
 * Status text for a non-live link (probing / waiting / failed).
 *
 * `hasSlot` = true when a TIMELINE slot is also rendered for this row (the
 * normal layout): in that case the failed REASON already lives in the slot, so
 * the status is a bare red `\u2717` marker \u2014 no duplicate error text. When `hasSlot`
 * is false (the <60-col pill fallback, no slot), the status carries the full
 * reason itself.
 */
function renderNonLiveStatus(link: ProbeLinkState, hasSlot: boolean) {
  switch (link.status) {
    case "probing": {
      const elapsedMs = link.startTime ? Date.now() - link.startTime : 0;
      return (
        <span fg={C.cyan}>{`\u23F3 probing ${formatElapsed(elapsedMs)}`}</span>
      );
    }
    case "failed":
      return hasSlot ? (
        <span fg={C.red}>{"\u2717"}</span>
      ) : (
        <span fg={C.red}>{`\u2717 ${stripAnsi(link.error || "failed")}`}</span>
      );
    case "waiting":
    default:
      return <span fg={C.dim}>{"\u23F3 waiting\u2026"}</span>;
  }
}

// ── Model progress group ───────────────────────────────────────────

function ModelGroup({
  model,
  links,
  animFrame,
  maxNameLen,
  rowWidth,
  isLast,
  layout,
  maxTotalMs,
  maxTokPerSec,
  fastestLinkId,
}: {
  model: string;
  links: ProbeLinkState[];
  animFrame: number;
  maxNameLen: number;
  rowWidth: number;
  isLast: boolean;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
  fastestLinkId: string | null;
}) {
  // Center the model name in a colored header bar that spans the full row width.
  // Use a 2-char left margin so the header aligns with the bar rows below.
  const headerWidth = rowWidth - 2;
  const totalPad = Math.max(0, headerWidth - model.length);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  const headerText = " ".repeat(leftPad) + model + " ".repeat(rightPad);

  return (
    <box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      {/* Section header — colored bar with centered model name, left-aligned with bars below */}
      <box flexDirection="row">
        <text>{"  "}</text>
        <box backgroundColor="#1e3a5f">
          <text>
            <span fg="#ffffff" attributes={A.bold}>
              {headerText}
            </span>
          </text>
        </box>
      </box>
      {links.map((link) => (
        <ProgressBar
          key={link.id}
          link={link}
          animFrame={animFrame}
          maxNameLen={maxNameLen}
          layout={layout}
          maxTotalMs={maxTotalMs}
          maxTokPerSec={maxTokPerSec}
          isRunFastest={fastestLinkId === link.id}
        />
      ))}
    </box>
  );
}

// ── Main app ───────────────────────────────────────────────────────

// Banner is 6 CLAUD rows + 1 subtitle row = 7. Steps block has paddingY={1}
// (top+bottom = 2) plus one row per step. We reserve that fixed chrome so the
// scrollable model list gets the remaining terminal rows as its viewport.
const BANNER_ROWS = 7;
const SCROLL_HINT_ROWS = 1;
const LEGEND_ROWS = 3; // 2 dim lines + 1 dim rule
const MIN_LIST_H = 4;

/**
 * Top legend (2 dim lines + a dim rule), rendered once above the scrollbox.
 * Line 1 = stage swatches + idle; line 2 = how to read the bars.
 */
function Legend({ rowWidth }: { rowWidth: number }) {
  const ruleWidth = Math.max(1, Math.min(rowWidth, 120));
  return (
    <box flexDirection="column">
      <text>
        <span fg={C.dim}>{"  Stages:  "}</span>
        <span bg={STAGE_BG.network}>{"  "}</span>
        <span fg={STAGE_FG.network}>{" network   "}</span>
        <span bg={STAGE_BG.server}>{"  "}</span>
        <span fg={STAGE_FG.server}>{" server   "}</span>
        <span bg={STAGE_BG.streaming}>{"  "}</span>
        <span fg={STAGE_FG.streaming}>{" streaming        "}</span>
        <span fg={C.dim}>{"·· idle"}</span>
      </text>
      <text>
        <span fg={C.dim}>
          {"  bar length = total time, shared scale (slowest link = full bar)  ·  tok/s scaled to fastest"}
        </span>
      </text>
      <text>
        <span fg={C.dim}>{"  " + "─".repeat(ruleWidth)}</span>
      </text>
    </box>
  );
}

export function ProbeApp({ store }: { store: ProbeStore }) {
  const state = useProbeStore(store);
  const animFrame = useAnimationFrame(true);
  const { height: termHeight, width: termWidth } = useTerminalDimensions();

  // Ref to the native OpenTUI scrollbox. We scroll it IMPERATIVELY from the
  // keyboard handler below (rather than relying on focus routing reaching the
  // box) — this is the same proven pattern the config TUI uses, and it works in
  // inline (non-alternate-screen) mode where focus-based key delivery is unreliable.
  const listScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Keyboard-driven scrolling — complements the mouse wheel (the focused
  // scrollbox handles wheel MouseEvents itself; useMouse is enabled in
  // probe-tui-runtime). Arrows / j-k / PgUp-PgDn / g-G also drive the box.
  useKeyboard((key) => {
    const sb = listScrollRef.current;
    if (!sb) return;
    const page = Math.max(1, sb.viewport.height - 1);
    switch (key.name) {
      case "up":
      case "k":
        sb.scrollBy(-1);
        break;
      case "down":
      case "j":
        sb.scrollBy(1);
        break;
      case "pageup":
        sb.scrollBy(-page);
        break;
      case "pagedown":
      case "space":
        sb.scrollBy(page);
        break;
      case "home":
        sb.scrollTo(0);
        break;
      case "end":
        sb.scrollTo(sb.content.height);
        break;
      case "g":
        // OpenTUI delivers letter keys with a lowercase `name` and shift tracked
        // separately, so an uppercase `case "G"` is unreachable. Branch on shift:
        // Shift+G → bottom (vim convention), g → top.
        sb.scrollTo(key.shift ? sb.content.height : 0);
        break;
    }
  });

  // Group links by model preserving insertion order
  const groups: Array<{ model: string; links: ProbeLinkState[] }> = [];
  for (const link of state.links) {
    let group = groups.find((g) => g.model === link.model);
    if (!group) {
      group = { model: link.model, links: [] };
      groups.push(group);
    }
    group.links.push(link);
  }

  // Shared max name length so bars align across all groups
  const maxNameLen = Math.min(
    25,
    Math.max(...state.links.map((l) => l.displayName.length), 12),
  );

  // Per-width layout tier (which bars/columns survive) + the matching row width
  // so the model header bar spans exactly the active row.
  const layout = deriveLayout(termWidth || 100);
  const rowWidth = computeRowWidth(layout, maxNameLen);

  // Run-level shared scales (derived in-component each render — no store change).
  //   maxTotalMs   = slowest live link's totalMs → that link's timeline bar = full B.
  //   maxTokPerSec = fastest live generator → that link's tok/s bar = full T.
  // The tok/s SCALE denominator floors streaming time to ≥50ms so one artifact
  // link can't crush the scale; the per-row bar still uses the raw tokensPerSec.
  let maxTotalMs = 1;
  let maxTokPerSec = 1;
  let fastestLinkId: string | null = null;
  let fastestTokPerSec = -Infinity;
  for (const link of state.links) {
    if (link.status !== "live" || !link.timing) continue;
    const t = link.timing;
    if (t.totalMs > maxTotalMs) maxTotalMs = t.totalMs;
    const streamMs = Math.max(STREAM_MS_FLOOR, t.totalMs - t.ttftMs);
    const scaledTps = t.tokens > 0 ? (t.tokens / streamMs) * 1000 : 0;
    if (scaledTps > maxTokPerSec) maxTokPerSec = scaledTps;
    if (t.tokensPerSec > fastestTokPerSec) {
      fastestTokPerSec = t.tokensPerSec;
      fastestLinkId = link.id;
    }
  }
  // No live generator produced tokens → no fastest crown.
  if (fastestTokPerSec <= 0) fastestLinkId = null;

  // Viewport height for the scrollable list = terminal rows minus the fixed
  // chrome (banner + steps block + top legend + scroll hint). Floored so a
  // short terminal can't produce a zero/negative height. The steps block is
  // paddingY(2) + N rows. The legend is 2 dim lines + 1 rule.
  const stepsRows = state.steps.length + (state.steps.length > 0 ? 2 : 0);
  const listH = Math.max(
    MIN_LIST_H,
    termHeight - BANNER_ROWS - stepsRows - LEGEND_ROWS - SCROLL_HINT_ROWS,
  );

  return (
    <box flexDirection="column">
      <Banner />
      <box flexDirection="column" paddingY={1}>
        {state.steps.map((step, i) => (
          <StepIndicator key={`${step.name}-${i}`} step={step} />
        ))}
      </box>

      {groups.length > 0 ? (
        <>
          {/* Top legend — rendered once, above the scrollable list. */}
          <Legend rowWidth={rowWidth} />
          {/* Native OpenTUI scrollbox — the model list scrolls WITHIN a fixed
              viewport so a long probe run (many models) never pushes the banner
              off-screen. Scrolled imperatively via the keyboard handler above.
              The view starts at the TOP (first model) — all links are seeded up
              front at a constant height, so there's no streaming tail to follow;
              top-start matches how users read the list. */}
          <scrollbox
            ref={listScrollRef}
            scrollX={false}
            scrollY={true}
            focused={true}
            style={{ height: listH }}
          >
            {groups.map((g, idx) => (
              <ModelGroup
                key={g.model}
                model={g.model}
                links={g.links}
                animFrame={animFrame}
                maxNameLen={maxNameLen}
                rowWidth={rowWidth}
                isLast={idx === groups.length - 1}
                layout={layout}
                maxTotalMs={maxTotalMs}
                maxTokPerSec={maxTokPerSec}
                fastestLinkId={fastestLinkId}
              />
            ))}
          </scrollbox>
          <text>
            <span fg={C.dim}>{"  ↑↓ scroll · PgUp/PgDn page · g/G top/bottom"}</span>
          </text>
        </>
      ) : null}
    </box>
  );
}
