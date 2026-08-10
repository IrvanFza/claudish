/** @jsxImportSource @opentui/react */
/**
 * resume-picker — the interactive screen `claudish --resume` (with no id) opens.
 *
 * Claude Code's own `--resume` shows one flat list of the CURRENT directory's sessions.
 * Working in worktrees breaks that: each worktree is a separate project directory, so
 * the sessions you want are the ones `claude --resume` cannot see from where you are.
 * MEASURED on this machine — 1,907 sessions for this repository alone, spread across 18
 * worktrees, 12 of which git no longer lists. This screen is built around that shape:
 * worktrees on the left, their sessions on the right, a preview underneath, and a filter
 * over both.
 *
 * SURFACE: `@opentui/react`. Lowercase intrinsics only, one `<text>` per row (or
 * `<span>`s inside one `<text>`) — sibling `<text>`s in a starved box overprint.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { A, C } from "../tui/theme.js";
import { displayWidth, padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import { BadgeSpan, MeterSpan, Panel, Sparkline, SparklineSpan } from "../tui/viz/widgets.js";
import { ConversationReader, SPEAKER } from "./conversation-reader.js";
// Aliased: this file already has a `Conversation` — the preview PANEL below. TypeScript
// tolerates the collision because one is a type and one is a value, so `tsc` says nothing,
// but a reader hitting `Conversation` in this file should not have to work out which of the
// two senses is meant. The data keeps the qualified name; the component keeps the bare one.
import { type Conversation as ConversationData, readConversation } from "./conversation.js";
import {
  type SessionRow,
  type WorktreeGroup,
  hydrateConversation,
  hydrateSession,
  isActive,
  isAgentSession,
  sessionLabel,
} from "./session-discovery.js";

/**
 * `Panel` chrome. A padded panel costs 4 columns, a `flush` one only its 2 border
 * columns; a `<scrollbox>` inside either costs 1 more for the scrollbar track.
 *
 * BOTH LIST PANELS ARE FLUSH. Their rows paint their own full-width cursor highlight,
 * and a 1-column gutter turns that bar into a floating chip with an unpainted column on
 * each side — while also spending two columns of the worktree name, which is the single
 * field this screen is scanned by.
 */
const PANEL_CHROME = 4;
const PANEL_BORDER = 2;
const SCROLL_CHROME = 1;
/** Narrow terminals keep the compact sidebar; wide ones get room for branch + state. */
/**
 * The sidebar takes a THIRD of the screen, not a fixed 30 cells.
 *
 * Choosing the worktree is the first decision and the one this picker exists for, so its
 * pane is sized as a share of whatever the terminal gives rather than as a constant that
 * happened to fit one window. The clamps keep it usable at both extremes.
 */
const SIDEBAR_MIN = 28;
const SIDEBAR_MAX = 50;
/**
 * How many transcript turns the details panel shows, by terminal height — and with it the
 * panel's own height, which is `DETAIL_CHROME` (border, title, id, spacer) plus the turns.
 *
 * A CONSTANT 11 ROWS IS WRONG ON A SHORT TERMINAL, and measurably so: at 80×24 the two
 * detail panels took 15 of 24 rows and the session list — the thing this screen exists to
 * choose from — was left with two entries. The list is the primary surface; the detail is
 * confirmation of a choice already narrowed, so it is what gives way.
 */
const DETAIL_CHROME = 5;
function detailTurns(height: number): number {
  return height >= 40 ? 6 : height >= 30 ? 4 : 2;
}
/** Worktree details, spanning BOTH columns along the bottom. Two rows plus its border. */
const WORKTREE_DETAIL_H = 4;

/** Case-insensitive subsequence match — the same "typing narrows it" feel as the 1Password tab. */
function fuzzy(needle: string, hay: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let i = 0;
  for (let j = 0; j < h.length && i < n.length; j++) if (h[j] === n[i]) i++;
  return i === n.length;
}

/** `3m`, `4h`, `6d` — one glyph of unit, because this column is scanned, not read. */
function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Anything untouched for longer than this is filed under STALE. */
export const STALE_MS = 3 * 86_400_000;

/**
 * GitHub's contribution scale, empty → busiest. FIVE DISCRETE LEVELS, NOT A RAMP.
 *
 * A day's session count is a VALUE, so it buckets (`aesthetics-and-color.md`: "Colour
 * encodes a VALUE → discrete buckets"); the continuous single-hue brightness ramp this
 * replaces was the wrong encoding, and it showed — a 24-step ramp puts a quiet day and a
 * busy one within a step or two of each other, which is why the old ribbon read as one
 * smear. Five bands are five visibly different fills, which is the whole point of a band.
 *
 * THE EMPTY LEVEL IS `#21262d`, NOT GITHUB'S OWN `#161b22`. GitHub survives a 1.09:1 floor
 * against its page because it draws gutters and rounded corners — the GAPS define the grid,
 * not the fill. A terminal grid gets neither for free, so at `#161b22` every empty day
 * dissolved into the panel and the calendar lost its rectangle: measured against the panel
 * `#111111`, `#161b22` is 1.09:1 and `#21262d` is 1.24:1. The lift is half the fix; the
 * gutter column `ActivityCalendar` paints between weeks is the other half, and neither
 * works alone.
 *
 * It is declared ABOVE `CHIP` because two chips ARE members of it (`fresh` and `clean`
 * index into it directly). "One green scale" is then enforced by construction rather than
 * asserted in a comment — the thing that failed last time, when `#3fb950` sat at L*67
 * between this scale's L3 (L*60) and L4 (L*75): a sixth green wedged between two buckets of
 * the five-green scale printed a few rows beneath it.
 */
export const GH_LEVELS = ["#21262d", "#0e4429", "#006d32", "#26a641", "#39d353"] as const;

/**
 * ONE PALETTE FOR THE WHOLE SCREEN: GitHub's dark theme.
 *
 * The previous fills were mid-lightness versions of `C`'s neon tokens, chosen on the theory
 * that a badge is dark ink on a saturated fill and `C` at full strength glares. Two of them
 * were simply bad: `#2d6e3e` is a MUDDY green rather than a quiet one, and `#8a5a1d` is
 * brown — it reads as rust on a dark panel, not as amber. Darkening a hue is not the same
 * operation as choosing a quieter one, and this is what the difference looks like.
 *
 * GitHub's dark palette is the replacement rather than a hand-tuned set because the
 * activity calendar below is already GitHub's contribution scale, and two independently
 * tuned green families in one pane is exactly how a screen stops looking designed. These
 * are BRIGHT fills, so `pickInk` lands on dark ink and each label reads as a chip — the
 * badge form the skill actually describes, which the darkened set was only approximating.
 *
 * ── THE RULE: EVERY FILL THAT CAN LAND ON A SELECTED ROW CLEARS 4.0:1 AGAINST
 * `C.bgHighlight` (#1e3a5f), NOT MERELY AGAINST THE PANEL. ──────────────────────────
 *
 * The palette had only ever been tuned against the panel `#111111`, and a chip does not
 * spend its life there — the row the user is standing on paints `#1e3a5f` underneath it, in
 * BOTH lists. Measured (WCAG 2.x, the same `contrastRatio` `viz/color.ts` uses for
 * `pickInk`), old fill → new fill, against `#1e3a5f`:
 *
 *   fresh   #3fb950 4.53 → #39d353 5.82   (and now a member of `GH_LEVELS`)
 *   stale   #484f58 1.39 → #a1a9b3 4.84   ← the one that genuinely disappeared
 *   count   #388bfd 3.44 → #58a6ff 4.55
 *   dirty   #d29922 4.56 → unchanged
 *   ahead   #39c5cf 5.51 → #bc8cff 4.56
 *   behind  #f85149 3.43 → #d2a8ff 5.91
 *   clean   #3fb950 4.53 → #26a641 3.62   ← EXEMPT, see below
 *
 * `clean` is the one exemption and it is structural, not a fudge: it appears ONLY in the
 * worktree strip along the bottom, which has no cursor and therefore no highlight, so
 * `#1e3a5f` is not a background it can ever sit on. Against the panel it measures 5.95:1.
 * Any chip added to either LIST must clear 4.0 against `#1e3a5f` or the grid vanishes the
 * moment it is selected.
 *
 * `stale` also has to stay light enough to take DARK ink (`pickInk` flips above relative
 * luminance 0.179), because the age column alternates fresh and stale down the list and an
 * ink colour that flips row to row is a worse artefact than a dim fill. `#8b949e` — the
 * obvious Primer grey-3 — measures 3.74 and fails the rule; grey-2 `#b1bac4` measures 5.86
 * and matches `fresh`'s 5.82, which would destroy the brightness ordering the pair exists
 * to carry. `#a1a9b3` sits between the two Primer steps: clears the rule with margin,
 * stays a full L* below `fresh`, and reads as neutral rather than active because it is
 * desaturated, not because it is dark.
 *
 * `fresh` and `stale` are the same fact at two ends of one scale, so they differ by
 * brightness (and saturation) rather than by hue. `ahead` and `behind` share ONE hue at two
 * lightnesses because they are one fact — diverged from origin — and the `↑`/`↓` glyph is
 * the redundant second encoding for the direction. That hue is purple specifically because
 * it is otherwise unused here: `behind` used to be `#f85149`, and `C.red` is `tokens.error`
 * / `tokens.fatal` across the probe TUI, the config TUI and the results printer. A branch
 * two commits behind origin is not a failure, and spending red on it would leave this
 * screen no colour in which to show a real one.
 *
 * The purple pair is Primer's DARK purple scale at steps 3 and 2, not 4 and 2: `#a371f7`
 * (step 4) is the obvious "one hue, two lightnesses" pick and measures 3.43 against
 * `#1e3a5f`, so it fails the rule this block exists to state. `#bc8cff` is one step up the
 * same scale — 4.56, and still 8 L* below `#d2a8ff`, so the two ends stay tellable apart.
 */
export const CHIP = {
  fresh: GH_LEVELS[4], //  recently used — the calendar's brightest green, #39d353
  stale: "#a1a9b3", //     idle 3d+ — the neutral end of the same scale
  count: "#58a6ff", //     sessions
  dirty: "#d29922", //     uncommitted changes (was the disliked brown)
  clean: GH_LEVELS[3], //  nothing to commit — #26a641, one step down the same scale
  ahead: "#bc8cff", //     unpushed commits — purple, the darker end
  behind: "#d2a8ff", //    commits to pull — purple, the brighter end
} as const;

/**
 * The chips that can land on a SELECTED row — the ones the 4.0:1 rule binds.
 *
 * Exported with `CHIP` so the rule is a TEST rather than a claim in a comment: a palette
 * tuned only against the panel is exactly how this screen lost its chip grid the first
 * time, and a comment cannot fail. Adding a chip to either list means adding its name here;
 * `clean` is absent because the worktree strip has no cursor and therefore no highlight.
 */
export const SELECTABLE_CHIPS = ["fresh", "stale", "count", "dirty", "ahead", "behind"] as const;
/** The floor those fills must clear against `C.bgHighlight`, in WCAG contrast ratio. */
export const CHIP_MIN_CONTRAST = 4;

/**
 * "You are here", in the calendar's brightest green rather than in `C.green` (#39ff14).
 *
 * Same argument as `CHIP.fresh`: a sixth green wedged between two buckets of the five-green
 * scale printed a few rows above it is how a screen stops looking designed. `tokens.success`
 * keeps its neon everywhere else in claudish; inside this picker the green scale is the
 * calendar's.
 */
const HERE_FG = GH_LEVELS[4];

/** `● ` or the two columns that hold its place. Not a chip — it has no fill. */
const LIVE_W = 2;

/**
 * The prefix on an uncommitted-changes count. `+`, and NOT `✎` (U+270E).
 *
 * U+270E is East-Asian AMBIGUOUS width: one cell in some terminal fonts, two in others.
 * Yoga lays out cells and cannot correct a glyph that lies about its width, so a chip whose
 * label measures 3 columns in `displayWidth` and paints 4 pushes every chip to its left by
 * a column — on some machines and not others, which is the worst kind of layout bug. Both
 * the OpenTUI and the Go-TUI skills call this out as a hard rule. It also rendered as an
 * indistinct blob at terminal size, so nothing was lost: the amber fill already says
 * "uncommitted" and the numeral says how much.
 */
const DIRTY_GLYPH = "+";

/**
 * The chip grid's LABEL widths, measured from the list it is about to render.
 *
 * ALIGNMENT USED TO COME PARTLY FROM A GUTTER, AND NOW COMES ENTIRELY FROM THIS. The
 * previous version reserved a slot one column wider than its widest chip, so the columns
 * lined up at their LEFT edge while their right edges were a staircase — `3s` painting 4
 * cells beside `24d`'s 5. With the chips flush against one another there is no gutter left
 * to absorb that, so every label in a column has to render at the same width or the grid
 * visibly breaks. `padStartTo` before the label becomes a badge is the mechanism, and
 * right-aligned numerals are what rule 2 asks for anyway.
 *
 * MEASURED, NOT CONSTANT, because the widest member is a property of the data: a corpus
 * with a four-digit session count needs a wider count column than one without, and pinning
 * a constant either wastes columns forever or truncates the day it is exceeded. The file
 * already decided the unit form of a whole column by its widest member for the same reason.
 *
 * The pad lands INSIDE the fill, which is safe at this size and would not be at any other:
 * one or two cells right-aligning a numeral is not the six that fused a column of `UP`
 * chips into one solid green rectangle. What stays forbidden is padding a label out to a
 * whole reserved SLOT — which is exactly what is no longer needed, because the slot and the
 * fill are now the same thing.
 */
interface ChipCols {
  /** Widest rendered age (`3s`, `20h`, `24d`, `144d`). */
  age: number;
  /** Widest session count, in digits. */
  count: number;
  /** Widest uncommitted count in digits, or 0 when no visible worktree is dirty. */
  dirty: number;
  /** Widest ahead/behind count in digits, or 0 when nothing has diverged. */
  sync: number;
}

/** A chip paints its label plus one column of fill each side; a blank holds the same. */
function chipW(label: number): number {
  return label + 2;
}

/**
 * The session card's age chip, which is NOT part of the sidebar's flush run.
 *
 * It is one chip followed by a meter, so it keeps an OUTSIDE column (`BadgeSpan`'s `width`)
 * — the gutter is what stops the meter abutting the fill, and there is no neighbouring chip
 * for it to break away from. The label is still normalised, for the same reason as the
 * sidebar: an un-padded `3s` beside a `20h` moved the whole meter column by a cell.
 */
const SESSION_AGE_W = 3;
const SESSION_AGE_COL = SESSION_AGE_W + 3;

/**
 * The whole grid's width. A column with a zero label width is DROPPED, not blanked —
 * reserving space for a fact that appears nowhere in the list buys no alignment and costs
 * a permanent void, which is the rule the sync columns already followed.
 */
function blockWidth(c: ChipCols): number {
  return (
    LIVE_W +
    chipW(c.age) +
    chipW(c.count) +
    (c.dirty > 0 ? chipW(c.dirty + 1) : 0) +
    (c.sync > 0 ? 2 * chipW(c.sync + 1) : 0)
  );
}

/**
 * The metadata row's band — what makes a two-line row read as ONE row.
 *
 * The two lines of a worktree are equidistant: the gap from a name to its own chips is the
 * same one row as the gap from those chips to the NEXT name, so the pane could render as
 * two independent columns — a list of names, and a separate list of chip blocks stepping
 * down beside it — rather than as ten items.
 *
 * A BAND WAS TRIED FOR THIS AND REMOVED. Tinting the metadata row (`#151d28`) did pair each
 * name with its own chips, and cost more than it bought: because EVERY metadata row is
 * tinted rather than every other ITEM, ten worktrees rendered as twenty alternating
 * one-line stripes, and the pane read as banded rather than as grouped. What actually does
 * the pairing now is the chip run itself — it is one contiguous object hard against the
 * right edge, so it reads as an attachment to the name above it rather than as a row of its
 * own. If a stronger grouping is ever needed, a one-cell left rail down BOTH lines of an
 * item is the device to reach for; it costs one column and cannot stripe.
 */

/**
 * A transcript's size as a percentage — on a LOG scale, and that is not a refinement.
 *
 * MEASURED across this repository's own sessions: 28 KB to 8.4 MB, a 300× spread. On a
 * linear scale 28 KB fills 0.3% of the bar and 1.5 MB fills 18%, so one outlier flattens
 * every other row to an empty track and the column reads as broken rather than as data —
 * which is exactly why an earlier pass deleted the meter instead of rescaling it. Log
 * against a 16 KB floor puts the same two rows at 9% and 72%.
 *
 * The floor matters as much as the log: `log(0)` is `-Infinity`, and below about 16 KB a
 * transcript is a handful of turns where the difference between 4 KB and 8 KB is not a
 * fact worth a column of gradient.
 */
const SIZE_FLOOR_BYTES = 16 * 1024;
function sizePct(bytes: number, max: number): number {
  const lo = Math.log(SIZE_FLOOR_BYTES);
  const hi = Math.log(Math.max(max, SIZE_FLOOR_BYTES * 2));
  const v = Math.log(Math.max(bytes, SIZE_FLOOR_BYTES));
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

/**
 * One cell of the grid: a chip, or the blank that holds its place.
 *
 * The blank is the point. Without it the grid is not a grid, and `WorktreeRow`'s earlier
 * "omit what is absent" rule is exactly what made the counts unfindable. It is `label + 2`
 * wide — the same cells the chip would have painted — so a row missing its uncommitted
 * count leaves the ages and counts of every other row exactly where they were.
 *
 * NO `width` IS PASSED TO `BadgeSpan`. Its `width` prop pads OUTSIDE the fill, which is
 * what a reserved slot needed and what a flush grid must not have: an outside pad is an
 * unpainted gutter, and the chips are supposed to share an edge. The label arrives
 * already normalised, so fill and column are the same thing.
 */
function Slot({
  label,
  bg,
  labelW,
}: {
  label?: string;
  bg?: string;
  labelW: number;
}): React.ReactNode {
  if (!label || !bg) return <span>{" ".repeat(chipW(labelW))}</span>;
  return <BadgeSpan label={label} bg={bg} />;
}

/**
 * Secondary text — the un-chipped metadata beside a chip, and the model's prose.
 *
 * `C.fgMuted` read directly rather than through a token: claudish's palette has no
 * "secondary text" tier, `viz/tokens.ts` maps only `text` (#fff) and `subtle`/`trace`
 * (both #555), and a size column at #555 beside a chip is unreadable while at #fff it
 * competes with the title. `C` is the source of truth `viz/tokens.ts` itself adapts, so
 * this is the palette, not a stray literal.
 */
const MUTED = C.fgMuted;

/**
 * ONE `<text>` PER ROW, ALWAYS — the rule every row in this file now follows.
 *
 * A flex ROW of `<text>` siblings looks equivalent and is not: Yoga's default
 * `flexShrink: 1` claws columns back from `<text>` children the moment a row is one
 * column over budget, and it takes them off the LAST one. That is how the branch name
 * came to render as `⎇ mai` with thirty empty columns to its right, and how the session
 * id came to render as `951f9f6f-6d5f-4eef-8c50-`. The vendored widgets defend themselves
 * with `flexShrink={0}`; a bare `<text>` cannot, so the defence is to give it no siblings.
 * Where a row genuinely must hold a widget (`Sparkline` is a `<text>` and cannot nest),
 * every sibling carries `flexShrink={0}` AND an explicitly budgeted width.
 */

/**
 * One worktree: the NAME on its own line, its CHIP GRID on the next.
 *
 * The name gets the whole width and nothing shares its line — an earlier version put
 * chips beside it and padded whatever was absent, so every row was a truncated name
 * (`minimax-suppo…`) next to a void. Splitting by kind is what freed the name.
 *
 * THE CHIP BLOCK IS FLUSH RIGHT, and the SPARKLINE FILLS EVERYTHING TO ITS LEFT. Those two
 * facts are one decision. Measured on the colour capture at 145×45, sidebar inner 46
 * columns: the name ended around column 14 and the chips began at column 26, so every row
 * was ink top-left, ink bottom-right, and two complementary voids between — twelve blank
 * columns before every chip row, thirty-two after every name. Ten of those stacked into a
 * diagonal. The right-alignment was never the problem; the twelve dead columns in front of
 * it were, and a worktree's rhythm is a real time series with nowhere better to be. So the
 * trend is sized to exactly the room the block leaves and the row has no leading pad at all.
 *
 * That places the trend under the name, which an earlier pass rejected as reading like an
 * underline. What changed is the BAND: the metadata row now paints its own background, so
 * the two lines are visibly separate objects and a shape on the lower one cannot be read as
 * decoration of the upper one.
 *
 * THE CHIPS ARE FLUSH AGAINST EACH OTHER — no gutter column between adjacent fills, so the
 * block reads as one segmented strip rather than as loose confetti. That is only legible
 * because every label in a column is normalised to the same rendered width first
 * (`ChipCols`); butting a staircase of chip widths would have produced a ragged blob. A row
 * that lacks a fact still paints a BLANK of exactly that column's width — the run breaks
 * where a chip would have been, which is not a gap to be closed but the alignment itself.
 *
 * ORDER IS SPARSEST FIRST, AND THAT IS WHAT MAKES "RIGHT-ALIGNED" TRUE. Every reserved
 * column a row does not fill is a blank somewhere, and the only choice is where. Leading
 * with the age put the two chips EVERY row has at the left of the block and the rarest at
 * the right, so the blanks landed at the end: measured, `devin` ended thirteen columns short
 * of the edge while `(root)` reached it, and the block's right edge was a staircase — the
 * opposite of what right-alignment is for. Unpushed, unpulled and uncommitted are the sparse
 * facts, so they go first; the session count and the age are on every row, so they own the
 * last two columns and the right edge is a hard rule on all of them. The blanks pool into
 * ONE gap between the trend and the chips, bounded by ink on both sides, and any row that
 * does have a sparse fact fills it.
 *
 * Branch, path and created-date live in the worktree strip along the bottom, in full.
 */
function WorktreeRow({
  g,
  cursor,
  width,
  count,
  cols,
}: {
  g: WorktreeGroup;
  cursor: boolean;
  width: number;
  /** Sessions actually listed for this worktree — post agent-filter, not `g.sessions`. */
  count: number;
  /** Label widths for the whole list, so every row paints the same columns. */
  cols: ChipCols;
}): React.ReactNode {
  // No `▶` prefix and no indent: a conditional marker shifts every other name by two
  // columns to mark one row, and "you are here" is already carried by the green and
  // spelled out in the strip below. Deleted worktrees grey out, everything else is body
  // text — the name is the loudest thing in the pane by design.
  const nameColor = !g.live ? tokens.dead : g.current ? tokens.success : tokens.text;
  const stale = !g.lastActiveMs || Date.now() - g.lastActiveMs >= STALE_MS;
  // Exactly the room the flush-right block leaves, so `pad + spark + block === width` and
  // the row has no dead columns anywhere. One cell per day, and the window is identical on
  // every row because `cols` and `width` are decided once for the whole list — so a spike
  // sits at the same x on two rows if and only if it happened on the same day.
  // THE SPARKLINE'S WIDTH IS CONSTANT ACROSS THE LIST, and that is a correctness property
  // rather than a tidiness one: it is one cell per day, so a spike only sits at the same x
  // on two rows if it happened on the same day. Sizing it to each row's own leftover would
  // silently re-scale the axis per worktree and make the column uncomparable.
  const room = Math.max(0, width - blockWidth(cols));
  const series = room >= SPARK_MIN_DAYS ? activitySeries(g.sessions, room) : null;
  const spark = series && hasActivity(series) ? series : null;

  // The chips a row ACTUALLY has, packed in fixed order, sparsest first.
  const chips: Array<{ label: string; bg: string; labelW: number }> = [];
  if (cols.sync > 0 && g.ahead) {
    chips.push({
      label: `↑${padStartTo(String(g.ahead), cols.sync)}`,
      bg: CHIP.ahead,
      labelW: cols.sync + 1,
    });
  }
  if (cols.sync > 0 && g.behind) {
    chips.push({
      label: `↓${padStartTo(String(g.behind), cols.sync)}`,
      bg: CHIP.behind,
      labelW: cols.sync + 1,
    });
  }
  if (cols.dirty > 0 && g.dirty) {
    chips.push({
      label: `${DIRTY_GLYPH}${padStartTo(String(g.dirty), cols.dirty)}`,
      bg: CHIP.dirty,
      labelW: cols.dirty + 1,
    });
  }
  chips.push({ label: padStartTo(String(count), cols.count), bg: CHIP.count, labelW: cols.count });
  chips.push({
    label: padStartTo(g.lastActiveMs ? age(g.lastActiveMs) : "—", cols.age),
    bg: stale ? CHIP.stale : CHIP.fresh,
    labelW: cols.age,
  });

  // THE BLANKS GO OUTSIDE THE RUN, NOT INSIDE IT. Reserving a column per fact and blanking
  // the ones a row lacks aligned every column perfectly and split the group: `↓6` sat two
  // columns adrift of `67 21h` with the empty uncommitted slot between them, reading as a
  // stray chip rather than as part of the cluster. Packing the present chips together and
  // pooling every blank into ONE gap ahead of them keeps the two facts EVERY row has — the
  // count and the age — in hard columns against the right edge, because they are always
  // last and always the same width. Only the sparse chips shift, and they shift to stay
  // attached to the group, which is the whole point.
  const used = chips.reduce((w, c) => w + c.labelW + 2, 0) + LIVE_W;
  const gap = Math.max(0, width - room - used);

  return (
    <box flexDirection="column" height={2} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text>
        <span fg={nameColor} attributes={cursor || g.current ? A.bold : undefined}>
          {truncate(g.name, width)}
        </span>
      </text>
      <box height={1}>
        <text>
          {spark ? <SparklineSpan values={spark} fg={SPARK_FG} /> : <span>{" ".repeat(room)}</span>}
          <span>{" ".repeat(gap)}</span>
          <span fg={tokens.success}>{g.activeNow ? "● " : "  "}</span>
          {chips.map((c) => (
            <Slot key={c.bg + c.label} label={c.label} bg={c.bg} labelW={c.labelW} />
          ))}
        </text>
      </box>
    </box>
  );
}

/**
 * A quiet scrollbar. The default track paints a light grey column that, segmented one
 * cell per row against a dark panel, reads as a strip of broken blocks rather than as a
 * bar — visible in the first colour capture down the whole right edge of the session
 * list. Rule 6: the chrome recedes, the data does not.
 */
const SCROLLBAR = {
  showArrows: false,
  trackOptions: { backgroundColor: tokens.bgPanel, foregroundColor: tokens.border },
} as const;

/** A week per row in the activity calendar, and the days across it. */
const WEEK_DAYS = 7;
/**
 * Six weeks of history, FIXED — not derived from the pane's height.
 *
 * A window sized to whatever the terminal had left made the same repository show a
 * different span on two machines, and a twelve-week version spent its whole upper half at
 * the empty level because this corpus does not reach back that far. Six is also what the
 * strip this replaces effectively showed (45 days), so the calendar is a re-rendering of a
 * window the reader already had rather than a new one to learn.
 */
const ACTIVITY_WEEKS = 6;
/**
 * The branch marker — kept as `⎇`, and PAID FOR at its true width.
 *
 * U+2387 is East Asian AMBIGUOUS. `Bun.stringWidth("⎇")` answers 1, so every budget that
 * measured it believed one column while the terminal painted two; each branch row ran a
 * column over and clipped its own last character, rendering `main` as `mai` plus a sliver.
 * Nothing in the layout was wrong — the glyph misreports its size, and Yoga lays out cells,
 * so it cannot compensate.
 *
 * The first fix swapped in `·`, which is unambiguous but loses a marker worth having. The
 * better one is to keep the glyph and stop trusting `displayWidth` for it: `BRANCH_LEAD` is
 * what the whole `  ⎇ ` prefix ACTUALLY costs, counted by hand, and every caller subtracts
 * that constant rather than measuring the string. Same conclusion as `✎` — an
 * ambiguous-width glyph must never carry layout — reached without giving up the icon.
 *
 * If a terminal renders it single-width the row simply ends one column short of the edge,
 * which is invisible. Over-budgeting is safe; under-budgeting clips.
 */
const BRANCH_ICON = "⎇";
/** Columns of `  ⎇ ` — two spaces, the glyph at its WIDE rendering, one space. */
const BRANCH_LEAD = 5;
/**
 * The SESSION LIST reserves one more column than the strip, and pays it deliberately.
 *
 * `⎇` is East Asian AMBIGUOUS, so its width is not unknown so much as DISPUTED: measured
 * here, tmux lays the pane out believing one column while the terminal paints two. A budget
 * cannot satisfy both, and the honest response is to spend a column rather than lose a
 * character — over-reserving ends a row one column short of the edge, which nobody can see,
 * while under-reserving clips the branch name, which everybody can.
 *
 * The strip is one row with forty spare columns and needs no such insurance. A session row
 * is one of twenty, already carrying a chip, a meter and a size before the branch, so it
 * takes the wider reservation. The alternative — dropping the glyph in the dense list — was
 * tried and rejected: the symbol is worth a column.
 */
const BRANCH_LEAD_DENSE = 6;

/** Columns the week label owns — `-5w` / `now` plus one of gutter, left-aligned. */
const WEEK_LABEL_W = 4;
/**
 * Rows the calendar costs, in total: its blank spacer, its title rule, and one row per
 * week. FIXED, because the shape no longer flexes — see `ActivityCalendar`.
 */
const ACTIVITY_H = 2 + ACTIVITY_WEEKS;

/**
 * Daily session counts across EVERY listed worktree, oldest → newest.
 *
 * The per-worktree sparklines answer "which of these is hot"; this answers "when have I
 * been working at all" — the question the empty lower half of the sidebar was previously
 * answering with black. Levels rather than a curve because the signal is presence and
 * intensity per day, and a day's count is a value, so it buckets.
 */
function dailyActivity(groups: readonly WorktreeGroup[], days: number): number[] {
  const day = 86_400_000;
  const today = Math.floor(Date.now() / day);
  const buckets = new Array<number>(days).fill(0);
  for (const g of groups) {
    for (const s of g.sessions) {
      const idx = days - 1 - (today - Math.floor(s.mtimeMs / day));
      if (idx >= 0 && idx < days) buckets[idx]! += 1;
    }
  }
  return buckets;
}

/**
 * A day's count to a level of `GH_LEVELS`, by QUANTILE of the non-empty days on screen.
 *
 * Absolute thresholds would have to be hardcoded counts, which is model data by another
 * name: a repository doing two sessions a day and one doing thirty want different edges,
 * and whichever pair were written down would be wrong for one of them. Quantiles are also
 * what stops a single frantic day flattening the rest — the same failure the session-size
 * meter fixed with a log scale, and the same one that made the old continuous heat ramp
 * read as a smear.
 *
 * ZERO IS ITS OWN LEVEL and never shares a band with a worked day, so the quantiles are
 * taken over the non-empty days only. "Nothing happened" is a different statement from
 * "not much happened", and GitHub's grid is legible precisely because it keeps them apart.
 */
function activityLevels(days: readonly number[]): number[] {
  const nz = days.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return days.map(() => 0);
  const at = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))]!;
  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  return days.map((v) => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4));
}

/**
 * Six weeks of activity — ONE WEEK PER ROW, days running across, filling the pane's width.
 *
 * THIS SHAPE WAS CHOSEN OVER GITHUB'S OWN, DELIBERATELY, AND THE REASON IS THE WEEK COUNT.
 * GitHub's grid is one row per weekday with weeks as columns, and it is wide and short
 * because it shows fifty-two of them. Rotating to that orientation while keeping the six
 * weeks this window is fixed at produced a twelve-column fragment sitting in a forty-six
 * column pane — the right chart at the wrong scale, which reads as broken rather than as
 * sparse. Weeks cost COLUMNS in that layout and ROWS in this one, so the six-week cap and
 * the rotation pull against each other; with six fixed, a week per row is what fills the
 * space it is given.
 *
 * NO GUTTER CELLS. The gutter was borrowed from GitHub for a real reason — its empty level
 * is 1.09:1 against its page and survives only because the gaps carry the structure — but
 * at this cell size the gaps cost half the grid and read as stripes rather than as
 * separation. The floor stays lifted (`GH_LEVELS[0]` is `#21262d`, not `#161b22`), which is
 * the half of that fix that works without spending columns.
 *
 * `flexGrow` GRANTS ROWS, IT DOES NOT PAINT THEM, which is why this block exists at all:
 * ten worktrees are twenty-two rows of a thirty-seven-row pane, so without something pinned
 * under the list the sidebar ended in unpainted terminal beside a right-hand pane filled to
 * its border.
 *
 * NO DATE ARITHMETIC IS NEEDED and none is done. `days` is a today-ending series of exactly
 * `ACTIVITY_WEEKS * WEEK_DAYS` entries, so chunking it into sevens puts one week per row
 * with the current week last; index `w * 7 + d` is week `w`, day `d`.
 */
function ActivityCalendar({
  days,
  width,
}: {
  /** `dailyActivity` over exactly `ACTIVITY_WEEKS * WEEK_DAYS` days, oldest → newest. */
  days: readonly number[];
  width: number;
}): React.ReactNode {
  const levels = activityLevels(days);
  const title = `activity · ${ACTIVITY_WEEKS}w `;
  // Every column the label does not own goes to the grid, and the remainder is spread one
  // cell at a time across the leading days rather than left at the end — a short final day
  // would put a notch in the right edge of all six rows.
  const grid = Math.max(WEEK_DAYS, width - WEEK_LABEL_W);
  const base = Math.floor(grid / WEEK_DAYS);
  const extra = grid - base * WEEK_DAYS;
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text>
        <span fg={tokens.subtle} attributes={A.bold}>
          {title}
        </span>
        <span fg={tokens.border}>{"─".repeat(Math.max(0, width - title.length))}</span>
      </text>
      {Array.from({ length: ACTIVITY_WEEKS }, (_, w) => {
        const ago = ACTIVITY_WEEKS - 1 - w;
        return (
          // ONE <text> per row. The cells are coloured SPACES, so a column shaved off this
          // row by a flex sibling would leave a stub of background that only a colour
          // capture can see — hence label and grid share a single <text> of spans.
          // biome-ignore lint/suspicious/noArrayIndexKey: a calendar week is position-addressed — index IS identity
          <text key={w}>
            <span fg={tokens.trace}>{padTo(ago === 0 ? "now" : `-${ago}w`, WEEK_LABEL_W)}</span>
            {Array.from({ length: WEEK_DAYS }, (_, d) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a calendar day is position-addressed — index IS identity
              <span key={d} bg={GH_LEVELS[levels[w * WEEK_DAYS + d] ?? 0]}>
                {" ".repeat(base + (d < extra ? 1 : 0))}
              </span>
            ))}
          </text>
        );
      })}
    </box>
  );
}

/**
 * A non-selectable divider between the recent worktrees and the stale ones.
 *
 * Takes the finished string rather than `label` + `count`, because assembling them here
 * produced `stale · 3d+ 3` — a threshold and a tally jammed together with nothing to say
 * which was which. The caller knows what the number counts; let it say so.
 */
function SectionHeader({ label, width }: { label: string; width: number }): React.ReactNode {
  const text = `${label} `;
  return (
    // A blank row above it. One dim rule inside a wall of two-line rows reads as another
    // row, not as a boundary — the gap is what makes it a section break.
    <box flexDirection="column" height={2}>
      <text> </text>
      <text>
        <span fg={tokens.subtle} attributes={A.bold}>
          {text}
        </span>
        <span fg={tokens.border}>{"─".repeat(Math.max(0, width - text.length))}</span>
      </text>
    </box>
  );
}

/** Below a week there is no rhythm to see, only a handful of blocks. Draw nothing. */
const SPARK_MIN_DAYS = 7;

/**
 * Mid-tone blue for a trend line — bright enough to read as a shape, quiet enough to lose
 * to the worktree name beside it. `C.blue` at full strength out-shouted the name, which is
 * rule 6 (dim the chrome, saturate the signal) applied to the wrong one of the two.
 */
const SPARK_FG = "#3f6f9e";

/**
 * An all-zero series must render NOTHING, and this guard is not defensive tidying.
 *
 * `Sparkline` treats a constant series as constant and draws a flat MID-height row — right
 * for a genuinely steady metric, and a lie here: a worktree untouched for three weeks has
 * fourteen zeroes, `max === min`, and painted a solid mid bar reading as steady daily
 * activity. Measured on the first colour capture, where `agent-a9446b0dbea384afd` (one
 * session, 24 days ago) carried the widest bar in the pane.
 */
function hasActivity(series: readonly number[]): boolean {
  return series.some((v) => v > 0);
}

/**
 * Sessions per day over the last two weeks, oldest → newest.
 *
 * A worktree's rhythm is genuinely a time series, so it gets a sparkline rather than a
 * "last active 6d" line. Cheap: it reads only mtimes already collected by the list pass.
 */
function activitySeries(sessions: SessionRow[], days = WEEK_DAYS * 2): number[] {
  const day = 86_400_000;
  const today = Math.floor(Date.now() / day);
  const buckets = new Array<number>(days).fill(0);
  for (const s of sessions) {
    const idx = days - 1 - (today - Math.floor(s.mtimeMs / day));
    if (idx >= 0 && idx < days) buckets[idx]! += 1;
  }
  return buckets;
}

/**
 * One session, as two rows on a tinted card.
 *
 * ONE LINE PER SESSION READ AS A TRANSCRIPT, not as a list — twenty single lines of
 * sentence-case prose in one panel look like twenty messages in one conversation, which
 * is precisely the wrong mental model for a chooser. Two rows plus an alternating tint
 * makes each entry a discrete object: the title is the thing, the metadata line beneath
 * belongs to it, and the tint boundary says where the next one starts.
 *
 * `indent` sets agent children in from their parent node.
 */
function SessionRowView({
  row,
  cursor,
  width,
  even,
  indent = 0,
  maxSize,
  meterW,
}: {
  row: SessionRow;
  cursor: boolean;
  width: number;
  even: boolean;
  indent?: number;
  /** Largest transcript in the visible list — the top of the meter's log scale. */
  maxSize: number;
  meterW: number;
}): React.ReactNode {
  const live = isActive(row);
  const pad = " ".repeat(indent);
  const mb = row.sizeBytes / 1_048_576;
  const size =
    mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
  // A TWO-COLUMN marker, down from four. The cursor no longer needs a bar of its own —
  // the row's highlight background says which row it is — so the gutter is just the
  // live/idle dot and one space, and the title starts two columns further left.
  const titleW = Math.max(10, width - indent - 2);
  const metaPad = `${pad}  `;
  const SIZE_COL = 8;

  return (
    <box
      flexDirection="column"
      height={2}
      backgroundColor={cursor ? C.bgHighlight : even ? undefined : C.bgAlt}
    >
      <text>
        <span fg={live ? tokens.success : tokens.border}>{`${pad}${live ? "●" : "·"} `}</span>
        {/* The title is body text on EVERY row, not just the selected one. Dimming the
            unselected titles made the whole pane read as disabled and left the cursor
            doing two jobs; the highlight bar behind the row is already unambiguous, so
            the cursor only needs to add weight. */}
        <span fg={tokens.text} attributes={cursor ? A.bold : undefined}>
          {truncate(sessionLabel(row), titleW)}
        </span>
      </text>
      {/* ONE <text>, and that is load-bearing rather than tidy. As a flex row of a badge,
          a meter and a size+branch <text>, Yoga's default `flexShrink: 1` took a column
          off the LAST sibling and clipped `main` to `mai` while the row still had thirty
          free columns to its right. A single <text> has no siblings to lose to, so the
          age chip, the size column and the branch keep the grid they were given. */}
      <text>
        <span>{metaPad}</span>
        {/* Fresh-vs-stale on the SAME three-day rule the sidebar uses, not live-vs-not.
            Keying the fill on `isActive` (a 120-second window) painted every chip in the
            list grey except a session running at that instant, which threw away the
            recency gradient the column is sorted by. A colour means one thing app-wide;
            "running right now" is what the green dot on the title line is for. */}
        <BadgeSpan
          label={padStartTo(age(row.mtimeMs), SESSION_AGE_W)}
          bg={Date.now() - row.mtimeMs < STALE_MS ? CHIP.fresh : CHIP.stale}
          width={SESSION_AGE_COL}
        />
        {/* The bar is the comparison, the numeral is the label — and `padStartTo`, so a
            column of sizes cannot jitter at the decimal point as values change. */}
        <MeterSpan pct={sizePct(row.sizeBytes, maxSize)} width={meterW} ramp={ramps.volume} />
        <span fg={MUTED}>{padStartTo(size, SIZE_COL)}</span>
        {row.gitBranch ? (
          <span fg={tokens.trace}>{`  ${BRANCH_ICON} ${truncate(
            row.gitBranch,
            Math.max(
              6,
              width - indent - 2 - SESSION_AGE_COL - meterW - SIZE_COL - BRANCH_LEAD_DENSE
            )
          )}`}</span>
        ) : (
          <span />
        )}
      </text>
    </box>
  );
}

/** The collapsible node that holds everything claudish or an agent spawned. */
function AgentNode({
  count,
  open,
  cursor,
  width,
}: {
  count: number;
  open: boolean;
  cursor: boolean;
  width: number;
}): React.ReactNode {
  const label = `${count} agent session${count === 1 ? "" : "s"}`;
  const hint = open ? "enter to collapse" : "enter to expand · showing 3";
  return (
    <box height={1} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text>
        <span fg={cursor ? tokens.accent : tokens.trace}>{`${cursor ? "▍" : " "} `}</span>
        <span fg={tokens.warn}>{open ? "▾ " : "▸ "}</span>
        <span fg={cursor ? tokens.text : tokens.subtle}>{label}</span>
        <span fg={tokens.trace}>
          {truncate(`  ${hint}`, Math.max(0, width - label.length - 6))}
        </span>
      </text>
    </box>
  );
}

/** One row in the right pane: a session, the agent node, or one of its children. */
type PickerItem =
  | { kind: "session"; row: SessionRow }
  | { kind: "agents"; count: number }
  | { kind: "agent"; row: SessionRow };

export interface PickerProps {
  groups: WorktreeGroup[];
  /** Called with a session id to resume, or null when the user cancels. */
  onDone: (sessionId: string | null) => void;
}

export function ResumePicker({ groups, onDone }: PickerProps): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const [pane, setPane] = useState<"worktrees" | "sessions">("worktrees");
  const [wtCursor, setWtCursor] = useState(0);
  const [sessCursor, setSessCursor] = useState(0);
  const [filter, setFilter] = useState("");
  /**
   * Whether the agent subtree is expanded, for the worktree currently shown.
   *
   * Agent sessions are NOT a separate list and not a global toggle — they are a
   * collapsed node inside the session list, because that is what they are: work spawned
   * BY the sessions above them. Collapsed shows the count and the three most recent, so
   * they are discoverable without burying the 95% case (measured: 1,923 of 2,018
   * transcripts here are `sdk-cli`).
   */
  const [agentsOpen, setAgentsOpen] = useState(false);
  /**
   * The full-screen reader, or null when the picker owns the screen.
   *
   * `conv: null` is the LOADING state and it is a real state, not a placeholder: walking a
   * 73 MB transcript takes about 0.7s, and doing it inline in the keypress handler would
   * freeze the picker with no explanation. The row is kept beside the conversation so the
   * async result can be discarded if the user has already opened a different session.
   */
  const [reader, setReader] = useState<{ row: SessionRow; conv: ConversationData | null } | null>(
    null
  );
  // Re-render tick. Hydration mutates rows in place (they are shared with the caller),
  // so there is no new object for React to diff against — the counter is what tells it
  // the rows it already holds now say more than they did.
  const [, setTick] = useState(0);

  /** Human sessions per worktree — what the sidebar counts and the list leads with. */
  const listed = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const g of groups)
      m.set(
        g.name,
        g.sessions.filter((s) => !isAgentSession(s))
      );
    return m;
  }, [groups]);

  /**
   * Worktrees split by recency, most recently used first within each half.
   *
   * The cursor indexes the CONCATENATION (`fresh` then `stale`), so the section header
   * drawn between them is pure chrome and never has to be skipped over — the alternative,
   * making headers part of the list and teaching the cursor to hop them, is how the
   * 1Password picker ended up needing `nextSelectable`.
   */
  const { fresh, stale, visibleGroups } = useMemo(() => {
    const withSessions = groups.filter((g) => (listed.get(g.name)?.length ?? 0) > 0);
    const matching = filter ? withSessions.filter((g) => fuzzy(filter, g.name)) : withSessions;
    const now = Date.now();
    const byRecency = (a: WorktreeGroup, b: WorktreeGroup) => b.lastActiveMs - a.lastActiveMs;
    // The current worktree stays pinned to the top of `fresh` however long it has been
    // idle — it is where the user is standing, so it is never something to hunt for.
    const f = matching
      .filter((g) => g.current || now - g.lastActiveMs < STALE_MS)
      .sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : byRecency(a, b)));
    const st = matching
      .filter((g) => !g.current && now - g.lastActiveMs >= STALE_MS)
      .sort(byRecency);
    return { fresh: f, stale: st, visibleGroups: [...f, ...st] };
  }, [groups, filter, listed]);
  const group = visibleGroups[Math.min(wtCursor, visibleGroups.length - 1)];

  const sessions = useMemo(() => {
    if (!group) return [];
    const base = listed.get(group.name) ?? [];
    if (!filter) return base;
    // A filter that matches the worktree name keeps all its sessions; otherwise it
    // narrows within them. Typing "gemini" should show the gemini-fix worktree's whole
    // list, not just sessions that happen to repeat the word.
    if (fuzzy(filter, group.name)) return base;
    return base.filter((s) => fuzzy(filter, sessionLabel(s)));
  }, [group, filter, listed]);

  /** Agent sessions for the selected worktree, newest first. */
  const agentRows = useMemo(() => (group ? group.sessions.filter(isAgentSession) : []), [group]);

  /**
   * The right pane as a FLAT list of items the cursor walks.
   *
   * Flattening is what keeps the tree honest: the agent node is one item, its children
   * are items, and the cursor is a single index over all of them — so Enter means "open
   * this item" everywhere and there is no second navigation mode to get wrong.
   */
  const items = useMemo((): PickerItem[] => {
    const out: PickerItem[] = sessions.map((row) => ({ kind: "session", row }) as const);
    if (agentRows.length > 0 && !filter) {
      out.push({ kind: "agents", count: agentRows.length });
      // Collapsed still shows the three most recent, so the subtree is discoverable
      // rather than merely announced.
      for (const row of agentsOpen ? agentRows : agentRows.slice(0, 3)) {
        out.push({ kind: "agent", row });
      }
    }
    return out;
  }, [sessions, agentRows, agentsOpen, filter]);

  const cursorItem = items[Math.min(sessCursor, items.length - 1)];
  const selected = cursorItem && cursorItem.kind !== "agents" ? cursorItem.row : undefined;

  // Hydrate what is on screen, never the whole corpus. Each call is two bounded reads
  // and returns immediately once a row is done, so this stays cheap on every keystroke.
  const turns = detailTurns(height);
  const sessionDetailH = DETAIL_CHROME + turns;
  const listRows = Math.max(3, height - sessionDetailH - WORKTREE_DETAIL_H - 4);
  useEffect(() => {
    const start = Math.max(0, Math.min(sessCursor - 2, items.length - listRows));
    for (const it of items.slice(start, start + listRows + 2)) {
      if (it.kind !== "agents") hydrateSession(it.row);
    }
    if (selected) {
      hydrateSession(selected);
      // Only the SELECTED row pays for the deep search, and only once — see
      // `hydrateConversation`. Rows merely scrolled past keep the cheap window.
      hydrateConversation(selected);
    }
    setTick((t) => t + 1);
  }, [items, sessCursor, listRows, selected]);

  /**
   * Walk the transcript OFF the keypress, so the "reading transcript…" frame paints.
   *
   * `readConversation` is synchronous — it has to be, since every other transcript read in
   * this feature is — so the only way the loading state is ever visible is to let the
   * renderer have a turn first. A macrotask boundary is enough for that, and it also
   * means an accidental `v` on a huge session can be escaped before the read starts.
   */
  useEffect(() => {
    if (!reader || reader.conv) return;
    const file = reader.row.file;
    const timer = setTimeout(() => {
      const conv = readConversation(file);
      // The user may have closed the reader or opened another session while this ran.
      setReader((r) => (r && r.row.file === file && !r.conv ? { row: r.row, conv } : r));
    }, 0);
    return () => clearTimeout(timer);
  }, [reader]);

  const clamp = (v: number, len: number) => Math.max(0, Math.min(v, len - 1));

  useKeyboard((key) => {
    // `useKeyboard` is a BROADCAST — every mounted subscriber receives every key, with no
    // bubbling and no `stopPropagation` — so while the reader is up this handler has to
    // stand down explicitly or `v`'s own keys would also drive the picker underneath it.
    if (reader) return;
    const name = key.name;

    // Filter mode owns printable keys; everything else still works, so the user is
    // never trapped in the text field.
    if (name === "escape") {
      if (filter) {
        setFilter("");
        return;
      }
      onDone(null);
      return;
    }
    if (key.ctrl && name === "c") {
      onDone(null);
      return;
    }
    if (name === "return" || name === "enter") {
      if (pane === "worktrees") {
        setPane("sessions");
        setSessCursor(0);
        return;
      }
      // Enter on the agent node toggles it; on a session it resumes.
      if (cursorItem?.kind === "agents") {
        setAgentsOpen((v) => !v);
        return;
      }
      if (selected) onDone(selected.id);
      return;
    }
    if (name === "tab") {
      setPane((p) => (p === "worktrees" ? "sessions" : "worktrees"));
      return;
    }
    if (name === "left") {
      setPane("worktrees");
      return;
    }
    if (name === "right") {
      setPane("sessions");
      return;
    }
    if (name === "up" || name === "down") {
      const d = name === "up" ? -1 : 1;
      if (pane === "worktrees") {
        setWtCursor((c) => clamp(c + d, visibleGroups.length));
        setSessCursor(0);
      } else {
        setSessCursor((c) => clamp(c + d, items.length));
      }
      return;
    }
    // `a` and `v` are the two letters the filter does not get, because a command the user
    // cannot find is the same as no command. The footer advertises both.
    //
    // `v` OPENS THE READER; `⏎` STILL RESUMES. Enter is the primary action of this screen
    // and re-pointing it at a viewer would make resuming — the thing the picker exists for
    // — a two-key operation. `v` is what was free: `/` and every other printable key is
    // already the filter, and the arrows, tab, enter, escape and backspace are all bound.
    // THE COST IS REAL AND IS EXACTLY THE ONE `a` ALREADY PAYS, so it is stated rather
    // than hidden: `v` is a command wherever it is pressed, so a filter can never contain
    // one, and typing `devin` opens the reader at the `v`. It survives because the filter
    // is a SUBSEQUENCE match — `dein`, what the remaining keys produce, still selects
    // `devin` — and because the alternative was worse. Making `v` a command only while the
    // filter is empty puts the reader out of reach after filtering, which is precisely the
    // flow (narrow, then read) it was built for.
    if (name === "a" && !key.ctrl && !key.meta) {
      setAgentsOpen((v) => !v);
      return;
    }
    if (name === "v" && !key.ctrl && !key.meta) {
      if (selected) setReader({ row: selected, conv: null });
      return;
    }
    if (name === "backspace") {
      setFilter((f) => f.slice(0, -1));
      setWtCursor(0);
      setSessCursor(0);
      return;
    }
    // `key.raw` carries the literal character; letters arrive lowercase with `shift`
    // reported separately, so matching on `name` alone would drop capitals.
    const ch = key.raw;
    if (ch && ch.length === 1 && ch >= " " && ch !== "\x7f" && ch !== "a" && ch !== "v") {
      setFilter((f) => f + ch);
      setWtCursor(0);
      setSessCursor(0);
    }
  });

  // ── widths (arithmetic, because data widgets take a numeric width) ─────────
  const bodyW = width;
  const sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width * 0.34)));
  const rightW = Math.max(30, bodyW - sidebarW);
  // Both list panels are `flush`, so they cost their border only — the rows own the
  // edge, which is what lets the cursor highlight run the full width of the pane.
  const sessInner = rightW - PANEL_BORDER - SCROLL_CHROME;
  // One extra column of slack so a right-aligned row never abuts the scrollbar thumb.
  const sideInner = sidebarW - PANEL_BORDER - SCROLL_CHROME - 1;
  // The details panel sits in the RIGHT COLUMN, not across the whole terminal, so its
  // inner width comes off `rightW`. Deriving it from the full width made it 40 cells too
  // wide at 145 columns and the conversation ran straight off the panel's right edge.
  const sessionDetailInner = rightW - PANEL_CHROME;
  const worktreeDetailInner = width - PANEL_CHROME;

  /**
   * The chip grid's label widths, measured once for the whole list.
   *
   * NEVER PER ROW — a grid whose column widths vary by row is not a grid, and with the
   * chips flush against one another a single row disagreeing about a width shifts every
   * chip to its left. Measuring the widest member is what lets the columns be exactly as
   * wide as the data needs instead of a constant that is either wasteful or wrong.
   *
   * A column whose widest member is ZERO is dropped entirely rather than blanked: no
   * visible worktree is dirty, so a reserved uncommitted column would buy no alignment and
   * cost a permanent void between the counts and the edge. That is the rule the sync
   * columns already followed, now applied to both. Per-ROW absence is the opposite case and
   * still pays for its blank — see `Slot`.
   */
  const chipCols = useMemo((): ChipCols => {
    let cols: ChipCols = { age: 1, count: 1, dirty: 0, sync: 0 };
    for (const g of visibleGroups) {
      cols.age = Math.max(cols.age, displayWidth(g.lastActiveMs ? age(g.lastActiveMs) : "—"));
      cols.count = Math.max(cols.count, String(listed.get(g.name)?.length ?? 0).length);
      if (g.dirty) cols.dirty = Math.max(cols.dirty, String(g.dirty).length);
      if (g.ahead) cols.sync = Math.max(cols.sync, String(g.ahead).length);
      if (g.behind) cols.sync = Math.max(cols.sync, String(g.behind).length);
    }
    // Narrow terminals drop columns rather than overflow the pane, least important first.
    // Both facts stay visible in full in the worktree strip along the bottom.
    if (blockWidth(cols) > sideInner) cols = { ...cols, sync: 0 };
    if (blockWidth(cols) > sideInner) cols = { ...cols, dirty: 0 };
    return cols;
  }, [visibleGroups, listed, sideInner]);

  // The meter's log scale is topped by the largest transcript ACTUALLY LISTED, so the
  // column is a comparison within what is on screen rather than against the whole corpus.
  // Capped at 400 rows: the sort is by recency, so the head holds the sizes that matter
  // and a 600-session worktree does not pay a full scan on every keystroke.
  const maxSize = Math.max(1, ...sessions.slice(0, 400).map((s) => s.sizeBytes));
  const meterW = Math.max(6, Math.min(14, Math.round(sessInner * 0.16)));

  // How many rows the sidebar has left once the list has taken what it needs — the
  // calendar is sized to FILL them, because a grower that paints fewer rows than it was
  // granted leaves black, not slack. The chrome subtracted is named rather than a
  // constant: header, the worktree strip, the footer, and the panel's own two borders.
  //
  // A LONG LIST WINS. The list is the surface this screen exists for, so when there is
  // nothing left over the calendar renders nothing at all rather than clipping the list —
  // the same rule `detailTurns` follows for the transcript. Measured at 80×24, where ten
  // worktrees ask for twenty-two rows of sixteen: no calendar, and eight worktrees visible
  // instead of the seven the old two-row strip left room for.
  const sidebarInnerH = height - 1 - WORKTREE_DETAIL_H - 1 - PANEL_BORDER;
  const listContentH = visibleGroups.length * 2 + (stale.length > 0 ? 2 : 0);
  // The calendar's height is now FIXED at `ACTIVITY_H` — seven weekday rows plus its spacer
  // and title — so the question is no longer how tall to draw a week but simply whether the
  // block fits at all. It either does, or the list keeps every row.
  const showActivity = sidebarInnerH - listContentH >= ACTIVITY_H;
  const activityDays = useMemo(
    () => dailyActivity(visibleGroups, ACTIVITY_WEEKS * WEEK_DAYS),
    [visibleGroups]
  );

  // Count what the user can actually see. Reporting the raw corpus (2,025) next to a
  // list of 95 reads as a bug in the picker rather than as a filter doing its job.
  const shownSessions = [...listed.values()].reduce((a, v) => a + v.length, 0);

  /**
   * The reader REPLACES the picker rather than overlaying it, and every hook above has
   * already run — this early return sits below all of them, which is what keeps the hook
   * order stable across the switch.
   *
   * Replacing rather than overlaying is what makes "esc returns with the same session
   * still selected" free: `wtCursor`, `sessCursor`, `filter` and `agentsOpen` all live in
   * this component, so closing the reader re-renders the picker exactly as it was.
   */
  if (reader) {
    return (
      <ConversationReader
        row={reader.row}
        conv={reader.conv}
        width={width}
        height={height}
        onClose={() => setReader(null)}
        onResume={() => onDone(reader.row.id)}
        onCancel={() => onDone(null)}
      />
    );
  }

  return (
    <box flexDirection="column" height={height} backgroundColor={C.bg}>
      {/* header: identity left, totals right — two row-groups, space-between */}
      <box flexDirection="row" justifyContent="space-between" height={1} paddingX={1}>
        <text>
          <span fg={tokens.accent} attributes={1}>
            claudish
          </span>
          <span fg={tokens.subtle}> resume</span>
        </text>
        <text>
          <span
            fg={tokens.subtle}
          >{`${visibleGroups.length} worktrees · ${shownSessions} sessions`}</span>
          {filter ? <span fg={tokens.warn}>{`  /${filter}`}</span> : <span />}
        </text>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {/* ── worktrees ─────────────────────────────────────────────────── */}
        <box width={sidebarW} flexDirection="column" minHeight={0}>
          <Panel title="worktrees" focused={pane === "worktrees"} flush flexGrow={1} flexBasis={0}>
            <scrollbox focused={false} flexGrow={1} scrollbarOptions={SCROLLBAR}>
              {fresh.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={i === wtCursor}
                  width={sideInner}
                  count={listed.get(g.name)?.length ?? 0}
                  cols={chipCols}
                />
              ))}
              {stale.length > 0 ? (
                <SectionHeader label={`stale · ${stale.length} · idle 3d+`} width={sideInner} />
              ) : null}
              {stale.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={fresh.length + i === wtCursor}
                  width={sideInner}
                  count={listed.get(g.name)?.length ?? 0}
                  cols={chipCols}
                />
              ))}
            </scrollbox>
            {/* Pinned under the list, so it occupies the space a short list leaves rather
                than a black hole. `flexShrink={0}` (inside the component) for the reason
                the skill spells out: the scrollbox above asks for its ENTIRE content
                height, and Yoga spreads that shortfall across every sibling — without it
                this block collapses to one row and its children overprint. */}
            {showActivity ? <ActivityCalendar days={activityDays} width={sideInner} /> : null}
          </Panel>
        </box>

        {/* ── sessions + preview ────────────────────────────────────────── */}
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <Panel
            title={group ? `sessions · ${truncate(group.name, 28)}` : "sessions"}
            focused={pane === "sessions"}
            flush
            flexGrow={1}
            flexBasis={0}
          >
            <scrollbox focused={false} flexGrow={1} scrollbarOptions={SCROLLBAR}>
              {items.length === 0 ? (
                <text fg={tokens.subtle}> no sessions match</text>
              ) : (
                items.map((it, i) =>
                  it.kind === "agents" ? (
                    <AgentNode
                      key="agents"
                      count={it.count}
                      open={agentsOpen}
                      cursor={i === sessCursor && pane === "sessions"}
                      width={sessInner}
                    />
                  ) : (
                    <SessionRowView
                      key={it.row.id}
                      row={it.row}
                      cursor={i === sessCursor && pane === "sessions"}
                      width={sessInner}
                      even={i % 2 === 0}
                      indent={it.kind === "agent" ? 2 : 0}
                      maxSize={maxSize}
                      meterW={meterW}
                    />
                  )
                )
              )}
            </scrollbox>
          </Panel>

          {/* Content-sized, so flexShrink={0}: without it the scrollbox above (whose
              intrinsic height is its whole content) starves this panel to one row. */}
          <box height={sessionDetailH} flexShrink={0}>
            <Panel title="session" flexGrow={1}>
              {selected ? (
                <SessionDetail row={selected} width={sessionDetailInner} turns={turns} />
              ) : (
                <text fg={tokens.subtle}>
                  {cursorItem?.kind === "agents"
                    ? "agent sessions — enter to expand"
                    : "nothing selected"}
                </text>
              )}
            </Panel>
          </box>
        </box>
      </box>

      {/* Spans BOTH columns: the worktree is the context for everything above it, so it
          gets the full width rather than being squeezed into the right-hand column. */}
      <box height={WORKTREE_DETAIL_H} flexShrink={0}>
        <Panel title="worktree" flexGrow={1}>
          <WorktreeDetail group={group} width={worktreeDetailInner} count={sessions.length} />
        </Panel>
      </box>

      <box flexDirection="row" height={1} paddingX={1} gap={2}>
        <text fg={tokens.subtle}>↑↓ move</text>
        <text fg={tokens.subtle}>⇥ pane</text>
        <text fg={tokens.subtle}>type to filter</text>
        <text fg={tokens.accent}>⏎ resume</text>
        <text fg={selected ? tokens.info : tokens.trace}>v read</text>
        <text fg={agentRows.length > 0 ? tokens.subtle : tokens.trace}>
          {agentRows.length > 0 ? `a ${agentsOpen ? "collapse" : "expand"} agents` : ""}
        </text>
        <text fg={tokens.subtle}>esc cancel</text>
      </box>
    </box>
  );
}

/** One field row: dim fixed-width label, value, done. */
function Field({
  label,
  width,
  children,
}: {
  label: string;
  width: number;
  children: React.ReactNode;
}): React.ReactNode {
  // `gap={1}` rather than trailing spaces inside a `<text>`: a flex row does not render
  // a sibling's trailing whitespace as separation, so `${id}   ` left the meter flush
  // against the id (`…1c67d87ed1de███████`). The gap is a layout fact, so Yoga owns it.
  return (
    <box flexDirection="row" height={1} gap={1}>
      <text fg={tokens.subtle}>{padTo(label, width)}</text>
      {children}
    </box>
  );
}

/**
 * The worktree strip along the bottom, spanning BOTH columns.
 *
 * It gets the full width because it is the context for everything above it, and because
 * the sidebar deliberately does NOT carry branch, path or created-date — they were
 * squeezing the name there, so they live here where there is room for them in full.
 * Two rows: identity, then location and history.
 */
function WorktreeDetail({
  group,
  width,
  count,
}: {
  group: WorktreeGroup | undefined;
  width: number;
  count: number;
}): React.ReactNode {
  if (!group) return <text fg={tokens.subtle}>no worktree selected</text>;
  const L = 9;

  // ── row 1: identity, as ONE <text> ────────────────────────────────────────
  // Badges sit last so the space before them is a known quantity, and everything
  // ahead of them is clipped to a budget that already excludes their columns. As four
  // sibling <text>s this row hit the same Yoga shrink as the session list: at 80
  // columns the branch and the state chips were both silently shortened.
  const badges = [];
  if (group.dirty !== undefined) {
    badges.push({
      label: group.dirty > 0 ? `${DIRTY_GLYPH}${group.dirty} uncommitted` : "clean",
      bg: group.dirty > 0 ? CHIP.dirty : CHIP.clean,
    });
  }
  if (group.ahead) badges.push({ label: `↑${group.ahead}`, bg: CHIP.ahead });
  if (group.behind) badges.push({ label: `↓${group.behind}`, bg: CHIP.behind });
  const badgeW = badges.reduce((w, b) => w + displayWidth(b.label) + 2, 0);

  const marker = group.current ? "  ▶ you are here" : !group.live ? "  worktree deleted" : "";
  const branch = group.branch ?? (group.live ? "detached" : "—");
  // Name and branch share what is left after the fixed parts, half each — so a long
  // branch cannot erase the name and a long name cannot erase the branch.
  // `BRANCH_LEAD + 1` because this row leads with three spaces, not two — and the glyph is
  // counted from the constant rather than measured, for the reason `BRANCH_ICON` documents.
  const idAvail = Math.max(12, width - L - displayWidth(marker) - (BRANCH_LEAD + 1) - badgeW - 1);
  const nameW = Math.max(8, Math.min(displayWidth(group.name), Math.floor(idAvail / 2)));
  const branchW = Math.max(6, idAvail - nameW);

  // ── row 2: location and history ───────────────────────────────────────────
  // `Sparkline` is a <text> and cannot nest, so this row stays a flex row — but every
  // sibling is clipped to a budget that sums under `width`, which is what makes the
  // shrink unreachable rather than merely unlikely.
  const spark = activitySeries(group.sessions);
  const summary = ` ${count} session${count === 1 ? "" : "s"} · created ${
    group.createdMs ? age(group.createdMs) : "?"
  } ago · used ${group.lastActiveMs ? age(group.lastActiveMs) : "?"} ago`;
  const locAvail = Math.max(20, width - L - spark.length - 2);
  // The path gets a SHARE, not the leftovers. Sizing it as `locAvail - summary` let the
  // summary take everything it wanted and left the path 10 columns at 80 wide —
  // `/Users/ja…`, which identifies nothing. A proportional floor keeps both legible and
  // still gives each of them its full text once there is room (measured: both complete
  // from 116 columns up).
  const pathW = Math.min(
    displayWidth(group.path ?? "—"),
    Math.max(16, Math.floor(locAvail * 0.45))
  );

  return (
    <box flexDirection="column">
      <text>
        <span fg={tokens.subtle}>{padTo("worktree", L)}</span>
        <span fg={tokens.text} attributes={A.bold}>
          {truncate(group.name, nameW)}
        </span>
        <span fg={group.current ? HERE_FG : tokens.dead}>{marker}</span>
        <span fg={tokens.subtle}>{`   ${BRANCH_ICON} `}</span>
        <span fg={group.live ? tokens.info : tokens.dead}>{`${truncate(branch, branchW)} `}</span>
        {badges.map((b) => (
          <BadgeSpan key={b.label} label={b.label} bg={b.bg} />
        ))}
      </text>
      <box flexDirection="row" height={1}>
        <text fg={tokens.subtle} flexShrink={0}>
          {padTo("path", L)}
        </text>
        <text fg={tokens.trace} flexShrink={0}>
          {`${padTo(truncate(group.path ?? "—", pathW), pathW)}  `}
        </text>
        {/* Same all-zero guard as the sidebar: a flat mid bar claims steady activity a
            dormant worktree does not have. `Sparkline` renders nothing for an empty array,
            so passing one is how the row simply omits it. */}
        <Sparkline values={hasActivity(spark) ? spark : []} fg={SPARK_FG} />
        <text fg={tokens.trace} flexShrink={0}>
          {truncate(summary, Math.max(0, locAvail - pathW))}
        </text>
      </box>
    </box>
  );
}

/**
 * The session panel, under the RIGHT column: what this conversation is, and how it ended.
 *
 * The transcript tail is the point of it — a title says what a session was ABOUT, the
 * last exchange says where it got to, which is what decides whether it is the one to
 * resume. Metadata is three compact rows above it so the conversation gets the rest.
 */
function SessionDetail({
  row,
  width,
  turns,
}: {
  row: SessionRow;
  width: number;
  /** Rows the panel was actually given for the transcript — see `detailTurns`. */
  turns: number;
}): React.ReactNode {
  const mb = row.sizeBytes / 1_048_576;
  const L = 9;
  const size = mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.round(row.sizeBytes / 1024)} KB`;
  const full = `· ${size}${row.lastMessageChars !== undefined ? ` · last msg ${row.lastMessageChars} ch` : ""}`;
  // `L + 1` for the label and its gap, `+ 1` for the gap before the suffix.
  const suffixRoom = width - L - 1 - row.id.length - 1;
  const suffix =
    displayWidth(full) <= suffixRoom
      ? full
      : displayWidth(`· ${size}`) <= suffixRoom
        ? `· ${size}`
        : "";
  return (
    <box flexDirection="column">
      <Field label="title" width={L}>
        <text fg={tokens.text} attributes={A.bold}>
          {truncate(sessionLabel(row), width - L)}
        </text>
      </Field>
      {/* Neither the branch nor the size meter is repeated here. The worktree strip
          below owns the branch, the session card in the list above already carries the
          size, and squeezing them in truncated the one field this row exists for — the
          full session id, which is what a `--resume` needs.

          THE ID IS NEVER CLIPPED, and the suffix is what gives way. Measured at 80
          columns, where the right pane is 50 wide: the two `<text>`s shrank together
          and the row rendered `951f9f6f-6d5f-4eef-8c50- · 7.4 MB · last`, turning the
          one unambiguous handle in this panel into a prefix. A dropped size is a lost
          nicety; a dropped half of a UUID is a lost session. */}
      <Field label="id" width={L}>
        <text fg={tokens.info} flexShrink={0}>
          {row.id}
        </text>
        {suffix ? (
          <text fg={tokens.trace} flexShrink={0}>
            {suffix}
          </text>
        ) : null}
      </Field>
      <box height={1} />
      <Conversation turns={row.recentTurns ?? []} width={width} max={turns} />
    </box>
  );
}

/**
 * The tail of the conversation, oldest at the top.
 *
 * Roles are BADGES here — the one place in this screen that keeps them — because two
 * speakers alternating down a panel is exactly what a chip is for: it is a legend, read
 * once, not a per-row attention grab. Teal for the machine, green for the person, the
 * same way round as everywhere else in claudish. Each turn is one clipped line: enough to
 * recognise where the session got to, not so much that the panel becomes a viewer.
 *
 * `ai`, not `model`. "Model" is claudish's word for the *thing being routed to* — it
 * names `gpt-5.6-sol` in every other panel — so reusing it for the speaker in a
 * transcript makes the reader parse which sense is meant.
 */
function Conversation({
  turns,
  width,
  max,
}: {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  width: number;
  /** How many trailing turns fit in the space this instance was given. */
  max: number;
}): React.ReactNode {
  if (turns.length === 0) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={tokens.trace}>no conversation recorded</text>
      </box>
    );
  }
  const ROLE_W = 6;
  const textW = Math.max(10, width - ROLE_W - 2);
  // Newest last, and only as many as fit — the panel is 9 rows and each turn takes one.
  const shown = turns.slice(-max);
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      {shown.map((t, i) => (
        // ONE <text> per turn. As two sibling <text>s in a row, Yoga shrank the
        // content one to its minimum and the transcript rendered ~17 cells wide
        // regardless of the column it had been given.
        <text key={`${i}-${t.text.slice(0, 12)}`}>
          <span fg={tokens.trace}>{"▍"}</span>
          <BadgeSpan
            label={t.role === "user" ? "you" : "ai"}
            bg={t.role === "user" ? SPEAKER.you : SPEAKER.ai}
            width={ROLE_W}
          />
          <span fg={t.role === "user" ? tokens.text : MUTED}>{truncate(t.text, textW)}</span>
        </text>
      ))}
    </box>
  );
}
