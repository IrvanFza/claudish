/**
 * session-summary — the bordered card claudish prints when a session ends.
 *
 * Printed as raw ANSI after the proxy has shut down, so it lands in the scrollback and
 * survives scrolling back to it later. Same pattern, and same reason, as
 * `probe-results-printer.ts`.
 *
 * THE RESUME COMMAND IS DELIBERATELY OUTSIDE THE BOX. Inside it would be framed by `│`
 * on both sides, and selecting a line in a terminal takes the whole row — so copying it
 * would drag the border characters along and the pasted command would not run. It is
 * printed as one bare, unstyled line below the card, which is the only form that
 * double-click-and-copy handles cleanly.
 *
 * The visual contract this follows (from the `opentui-tui` skill, which claudish's probe
 * UI already follows): a bounded value gets a GRADIENT METER rather than a bare number,
 * a category distribution gets a STACKED BAR rather than `name: count` lines, and a
 * discrete status gets a BADGE. No emoji anywhere — ambiguous width breaks column
 * alignment, and Jack asked for the probe TUI's look, which uses none.
 */

import { C } from "../tui/theme.js";
import { padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import {
  type BarSegment,
  RESET,
  badge,
  compact,
  duration,
  meter,
  padVisible,
  paint,
  stackedBar,
  usd,
  visibleWidth,
} from "./ansi-viz.js";
import type { SessionStats } from "./session-stats.js";

/**
 * Category colours for the tool distribution, in assignment order.
 *
 * These identify categories, they do not grade them — so they are drawn from `C`'s
 * distinguishable hues and deliberately EXCLUDE red and green, which carry "error" and
 * "ok" everywhere else in claudish. A red slice of a tool bar would read as a failure.
 */
const TOOL_COLORS: readonly string[] = [
  C.blue,
  C.cyan,
  "#8a7d1e",
  "#1f6d75",
  C.magenta,
  "#2d6e3e",
  C.orange,
];
/** Anything past `TOOL_COLORS` is pooled into one "other" slice in this grey. */
const TOOL_OTHER = C.dim;

const MIN_W = 62;
const MAX_W = 96;
/** Border + one space of padding on each side. */
const CHROME = 4;

function cardWidth(): number {
  const cols = process.stdout.columns || 80;
  return Math.max(MIN_W, Math.min(MAX_W, cols - 2));
}

/** Rule 4: labels are abbreviated so the columns, not the prose, carry the meaning. */
const LABEL_W = 10;

export interface SummaryInput {
  stats: SessionStats;
  /** What to LABEL the session with. May be a bare model name; display only. */
  modelSpec: string;
  /**
   * The exact spec to put after `--model` in the resume command, or null to omit the
   * flag entirely.
   *
   * Deliberately separate from `modelSpec`. The label can be the bare name the token
   * file records, but the resume command cannot: a bare name is re-ROUTED from scratch,
   * and for providers reachable only by prefix it can silently land somewhere else —
   * `dv@claude-opus-5` stripped to `claude-opus-5` matches native Anthropic's
   * `/^claude-/i` rule and resumes against a different provider and a different bill.
   * When the session was driven by profile role mappings there is no single spec to
   * print at all, so the honest output is `claudish --resume <id>`, which re-reads the
   * same profile rather than guessing one flag for it.
   */
  resumeModelSpec: string | null;
  /** Session UUID to resume, when one could be found. */
  resumeId: string | null;
  /** Non-zero when the child exited badly — the card says so instead of implying success. */
  exitCode: number;
}

/**
 * Render the card and the resume line. Returns the lines to print, without a trailing
 * newline, so the caller decides the stream (stdout when interactive, stderr in print
 * mode, where stdout belongs to the machine-readable output).
 */
export function renderSessionSummary(input: SummaryInput): string[] {
  const { stats, modelSpec, resumeModelSpec, resumeId, exitCode } = input;
  const W = cardWidth();
  const inner = W - CHROME;
  const out: string[] = [];

  const dim = (s: string) => paint(s, tokens.subtle);
  const body = (s: string) => paint(s, tokens.text);

  // ── chrome ────────────────────────────────────────────────────────────────
  const titleText = exitCode === 0 ? " session " : " session · failed ";
  const titleHex = exitCode === 0 ? tokens.accent : tokens.error;
  const rule = "─".repeat(Math.max(0, W - 2 - visibleWidth(titleText) - 1));
  out.push(paint("╭─", tokens.border) + paint(titleText, titleHex) + paint(rule + "╮", tokens.border));

  const row = (s: string): void => {
    out.push(`${paint("│", tokens.border)} ${padVisible(s, inner)} ${paint("│", tokens.border)}`);
  };
  const blank = (): void => row("");

  // ── identity + duration ───────────────────────────────────────────────────
  // The model is a BADGE rather than plain text: it is the one discrete fact that
  // identifies the whole run, and a chip is what makes it findable when scrolling back
  // through a long terminal history.
  const chips: string[] = [badge(truncate(modelSpec, 34), tokens.accent)];
  if (stats.isFree) chips.push(badge("FREE", C.pillKeyBg));
  else if (stats.isEstimated) chips.push(badge("EST", "#8a7d1e"));
  if (exitCode !== 0) chips.push(badge(`EXIT ${exitCode}`, "#9e2b2b"));

  const left = chips.join(" ");
  const right = body(duration(stats.durationMs));
  const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
  row(left + " ".repeat(gap) + right);
  if (stats.providerName) row(dim(truncate(stats.providerName, inner)));
  blank();

  // Every data row is `label | bar | right-aligned values`, with the bar taking all the
  // space the other two do not. Sizing the bar to the leftovers is what keeps the card
  // free of the dead gutter a fixed-width bar leaves down the right-hand side.
  const VALUE_W = 24;
  const barW = Math.max(12, inner - LABEL_W - VALUE_W);
  const dataRow = (label: string, bar: string, values: string): void => {
    row(dim(padTo(label, LABEL_W)) + bar + padVisible(values, VALUE_W, "right"));
  };

  // ── context ───────────────────────────────────────────────────────────────
  // A bounded ratio, so it is a gradient meter on the `load` ramp: a full bar means the
  // window is nearly gone, which is genuinely bad, so ending red is the right polarity.
  if (stats.contextUsed !== null && stats.contextWindow) {
    const pct = stats.contextUsed * 100;
    dataRow(
      "context",
      meter(pct, barW, ramps.load),
      body(padStartTo(`${Math.round(pct)}%`, 4)) +
        dim(`  ${compact(stats.inputTokens)}/${compact(stats.contextWindow)}`)
    );
  }

  // ── tokens, and what they actually cost ───────────────────────────────────
  //
  // These two bars are a PAIR and only work as one. Tokens are wildly lopsided —
  // hundreds of thousands in against tens of thousands out — so on its own the token bar
  // is a flat blue rectangle with a sliver on the end, which is exactly the
  // "single-colour bar" the visual contract calls a failure.
  //
  // The cost bar inverts it. Output is priced 4–5x input across every provider claudish
  // routes to, so the tiny output slice is usually the LARGER share of the bill. Shown
  // together and in the same two colours, the pair states something neither number does:
  // the few tokens the model wrote are where the money went.
  dataRow(
    "tokens",
    stackedBar(
      [
        { value: stats.inputTokens, color: C.blue },
        { value: stats.outputTokens, color: C.cyan },
      ],
      barW
    ),
    dim("in ") + body(compact(stats.inputTokens)) + dim(" out ") + body(compact(stats.outputTokens))
  );
  if (!stats.isFree && stats.inputCostUsd + stats.outputCostUsd > 0) {
    dataRow(
      "spend",
      stackedBar(
        [
          { value: stats.inputCostUsd, color: C.blue },
          { value: stats.outputCostUsd, color: C.cyan },
        ],
        barW
      ),
      dim("in ") + body(usd(stats.inputCostUsd)) + dim(" out ") + body(usd(stats.outputCostUsd))
    );
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  if (stats.toolCallTotal > 0) {
    const shown = stats.toolCalls.slice(0, TOOL_COLORS.length);
    const rest = stats.toolCalls.slice(TOOL_COLORS.length).reduce((a, t) => a + t.count, 0);
    const segs: BarSegment[] = shown.map((t, i) => ({ value: t.count, color: TOOL_COLORS[i]! }));
    if (rest > 0) segs.push({ value: rest, color: TOOL_OTHER });

    dataRow(
      "tools",
      stackedBar(segs, barW),
      body(padStartTo(String(stats.toolCallTotal), 4)) + dim(" calls")
    );
    // The legend is the only place the bar's colours acquire meaning, so it is not
    // optional decoration — each name is painted in its slice's colour.
    const legend = shown
      .map((t, i) => paint(`${t.name} ${t.count}`, TOOL_COLORS[i]!))
      .concat(rest > 0 ? [paint(`other ${rest}`, TOOL_OTHER)] : []);
    for (const line of wrapStyled(legend, dim(" · "), inner - LABEL_W)) {
      row(" ".repeat(LABEL_W) + line);
    }
  }
  blank();

  // ── cost and savings ──────────────────────────────────────────────────────
  row(
    dim(padTo("cost", LABEL_W)) +
      paint(stats.isFree ? "free" : usd(stats.costUsd), stats.isFree ? tokens.success : tokens.text, true) +
      (stats.isEstimated && !stats.isFree ? dim("  estimated") : "")
  );

  for (const s of stats.savings) {
    const label = padTo(`vs ${s.label}`, LABEL_W);
    if (s.savedUsd >= 0) {
      // Fraction of the baseline price avoided — bounded, so: gradient meter, on the
      // REVERSED ramp, because here a full bar is the best outcome.
      const pct = s.baselineUsd > 0 ? (s.savedUsd / s.baselineUsd) * 100 : 0;
      dataRow(
        label,
        meter(pct, barW, ramps.savings),
        paint(padStartTo(`${Math.round(pct)}%`, 4), tokens.success) +
          dim(" saved ") +
          paint(usd(s.savedUsd), tokens.success)
      );
    } else {
      // Costing MORE than Claude is a real outcome and is reported as one. The row keeps
      // its shape but the meter is empty and the wording flips, so the sign can never be
      // misread as a saving.
      dataRow(
        label,
        meter(0, barW, ramps.savings),
        dim("over by ") + paint(usd(-s.savedUsd), tokens.error)
      );
    }
  }

  out.push(paint(`╰${"─".repeat(W - 2)}╯`, tokens.border));

  // ── the copyable line, outside the box ────────────────────────────────────
  if (resumeId) {
    out.push("");
    out.push(dim("Resume this session with:"));
    // Unstyled ON PURPOSE. Colour codes survive a copy in some terminals and paste as
    // literal escapes; a bare line always pastes as a runnable command.
    //
    // `--model` is omitted rather than guessed when the routed spec is unknown — see
    // `resumeModelSpec`. A resume that re-reads the user's profile is correct; one that
    // pins a bare name can route to a different provider than the session used.
    const modelFlag = resumeModelSpec ? `--model ${resumeModelSpec} ` : "";
    out.push(`claudish ${modelFlag}--resume ${resumeId}`);
  }

  return out;
}

/**
 * Wrap already-styled chips onto lines of at most `width` columns.
 *
 * Measured with `visibleWidth`, so the SGR bytes in each chip cost nothing and a CJK
 * tool name costs two columns per glyph — the two things a `.length`-based wrap gets
 * wrong in opposite directions.
 */
function wrapStyled(chips: string[], sep: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  const sepW = visibleWidth(sep);
  for (const chip of chips) {
    const w = visibleWidth(chip);
    if (cur && curW + sepW + w > width) {
      lines.push(cur);
      cur = chip;
      curW = w;
    } else {
      cur = cur ? cur + sep + chip : chip;
      curW = cur === chip ? w : curW + sepW + w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Render and write the summary. No-op when there is nothing worth reporting. */
export function printSessionSummary(input: SummaryInput, write: (line: string) => void): void {
  for (const line of renderSessionSummary(input)) write(line);
  write(RESET);
}
