/** @jsxImportSource @opentui/react */
/**
 * conversation-reader — the full-screen transcript the picker opens with `v`.
 *
 * The picker's `session` panel shows the last handful of turns, one clipped line each.
 * That answers "where did this get to"; it cannot answer "what did I say about the
 * handshake lock", which is the question that sends you looking through a session in the
 * first place. This screen is the whole main conversation, wrapped rather than clipped,
 * with a search over it.
 *
 * SURFACE: `@opentui/react`. Lowercase intrinsics only, ONE `<text>` per row — every row
 * here is a `<text>` of `<span>`s, including its scrollbar cell, so there is no flex
 * sibling anywhere for Yoga's default `flexShrink: 1` to shave a column off.
 *
 * THE VIEWPORT IS WINDOWED BY HAND, NOT BY A `<scrollbox>`. A scrollbox's intrinsic height
 * is its entire content, so handing it every line of a conversation means mounting one
 * renderable per line — 12,000 of them for a large session, rebuilt whenever the terminal
 * resizes. This screen instead computes the wrapped lines once (offsets only, see
 * `wrapOffsets`) and mounts exactly the rows the terminal can show. The cost of that
 * choice is that the scrollbar has to be drawn rather than inherited, which is what the
 * last span of every row is; it is themed to match the picker's `SCROLLBAR` — a dim track
 * that recedes, an accent thumb, and a warn-coloured tick wherever a search hit sits, so
 * the bar doubles as a map of the matches.
 */

import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { A, C } from "../tui/theme.js";
import { displayWidth, truncate } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import { BadgeSpan, MeterSpan, Panel } from "../tui/viz/widgets.js";
import type { Conversation, ReaderTurn } from "./conversation.js";
import { wrapOffsets } from "./conversation.js";
import { type SessionRow, sessionLabel } from "./session-discovery.js";

/**
 * The turn rail, and why it is budgeted at TWO columns while `displayWidth` says one.
 *
 * U+258D is East Asian AMBIGUOUS: `Bun.stringWidth` answers 1, and a terminal may paint
 * either 1 or 2. Yoga lays out cells and cannot correct a glyph that lies about its size,
 * so the same rule `BRANCH_LEAD` follows in the picker applies — pay for it at its WIDE
 * rendering and never measure it. Over-budgeting costs at most one unpainted column at the
 * right edge, which is invisible; under-budgeting pushes the scrollbar cell past the
 * panel border, where it is clipped and the bar disappears on one row at a time.
 */
const RAIL = "▍";
const RAIL_W = 2;

/** The `you` / `ai` chip column, matching the picker's `Conversation` panel exactly. */
const ROLE_W = 6;
/** Rail plus chip: what every line of a turn is indented by, first line or continuation. */
const GUTTER = RAIL_W + ROLE_W;
/** The drawn scrollbar, one column at the right edge of every row. */
const BAR_W = 1;

/**
 * The transcript's two speakers, deliberately NOT `CHIP`.
 *
 * They were sharing `CHIP.fresh` and `CHIP.ahead` with the picker's age and sync columns,
 * so any change to a list column silently repainted the role legend. These are a two-value
 * LEGEND read once at the top of a panel, not a column that repeats down a list; the values
 * are written out separately so they can stop matching.
 *
 * `you` is the GitHub scale's `#39d353` — one green on these screens — but written as a
 * literal rather than as `GH_LEVELS[4]`, because a legend that happens to agree with a data
 * column today must stay free to disagree tomorrow.
 *
 * It lives HERE and is imported by the picker rather than the other way round, because the
 * picker already imports this module and the reverse would be a cycle. One definition, two
 * screens: the chip beside a turn in the picker's preview and the chip beside the same turn
 * in the reader are the same colour by construction.
 */
export const SPEAKER = {
  you: "#39d353",
  ai: "#39c5cf",
} as const;

/**
 * The match cap, and why it exists rather than being "the number of matches".
 *
 * A one-character query against a large conversation matches hundreds of thousands of
 * times; building a highlight range for each would stall the frame for a result nobody can
 * use. Past the cap the counter renders `5000+` and the ranges stop being collected, so
 * the screen degrades into "too many, narrow it" instead of into a freeze.
 */
const MAX_MATCHES = 5000;

/** One display row: a slice of one turn's text, or the blank between two turns. */
interface Row {
  /** Index into `turns`, or -1 for the spacer between turns. */
  turn: number;
  /** True on the row that carries the role chip. */
  first: boolean;
  start: number;
  end: number;
}

/** A highlight run inside one row, in row-local character offsets. */
type Hl = { s: number; e: number; hit: number };

interface SearchIndex {
  /** Row index of each hit, in document order — what `n` / `N` step through. */
  hits: number[];
  /** Row index → the highlight runs that fall on it. */
  ranges: Map<number, Hl[]>;
  /** True when `MAX_MATCHES` stopped the scan. */
  capped: boolean;
}

const EMPTY_SEARCH: SearchIndex = { hits: [], ranges: new Map(), capped: false };
/** Stable identity for "no conversation yet", so the memos below do not churn. */
const NO_TURNS: readonly ReaderTurn[] = [];

/**
 * Wrap every turn into display rows, with a blank row between turns.
 *
 * Exported for tests: this is where the reader's whole geometry comes from, and the
 * mapping from a character offset in a turn to the row that shows it is what makes search
 * highlighting land in the right place.
 */
export function layoutRows(
  turns: readonly ReaderTurn[],
  textWidth: number
): { rows: Row[]; turnStart: number[]; turnEnd: number[] } {
  const rows: Row[] = [];
  const turnStart: number[] = [];
  const turnEnd: number[] = [];
  for (let t = 0; t < turns.length; t++) {
    turnStart.push(rows.length);
    const slices = wrapOffsets(turns[t]!.text, textWidth);
    for (let i = 0; i < slices.length; i++) {
      rows.push({ turn: t, first: i === 0, start: slices[i]!.start, end: slices[i]!.end });
    }
    turnEnd.push(rows.length);
    // A blank row between turns, not after the last one — a trailing spacer would let the
    // view scroll one row past the end and show an empty screen at the bottom.
    if (t < turns.length - 1) rows.push({ turn: -1, first: false, start: 0, end: 0 });
  }
  return { rows, turnStart, turnEnd };
}

/**
 * Every occurrence of `query`, mapped onto rows.
 *
 * THE SEARCH RUNS OVER THE TURN, NOT OVER THE ROW, and that is the difference between a
 * count the reader can trust and one it cannot. Wrapping breaks a turn into rows at
 * arbitrary points, so a phrase the user can plainly see may straddle two of them;
 * matching per row would miss it, and the "12 matches" on screen would be a different
 * number from the twelve the user counted. Matching the contiguous text and then
 * intersecting each hit with the rows it covers highlights both halves and counts once.
 *
 * Case-insensitive substring, and deliberately nothing more — no fuzzy matching. The
 * picker's list filter is a subsequence match because a list is a set of short labels you
 * are narrowing; a transcript search is `less`'s job, where a subsequence match over
 * paragraphs would light up almost every line.
 */
export function buildSearch(
  turns: readonly ReaderTurn[],
  rows: readonly Row[],
  turnStart: readonly number[],
  turnEnd: readonly number[],
  query: string
): SearchIndex {
  if (!query) return EMPTY_SEARCH;
  const q = query.toLowerCase();
  const hits: number[] = [];
  const ranges = new Map<number, Hl[]>();
  let capped = false;
  for (let t = 0; t < turns.length && !capped; t++) {
    const hay = turns[t]!.text.toLowerCase();
    let at = hay.indexOf(q);
    if (at === -1) continue;
    const lo = turnStart[t]!;
    const hi = turnEnd[t]!;
    // `at` only increases within a turn, so the row cursor only moves forward — the scan
    // is linear in rows per turn rather than a search per hit.
    let r = lo;
    while (at !== -1) {
      if (hits.length >= MAX_MATCHES) {
        capped = true;
        break;
      }
      const end = at + q.length;
      while (r < hi - 1 && rows[r]!.end <= at) r++;
      const hit = hits.length;
      hits.push(r);
      for (let k = r; k < hi; k++) {
        const row = rows[k]!;
        if (row.start >= end) break;
        const s = Math.max(at, row.start);
        const e = Math.min(end, row.end);
        if (e > s) {
          const list = ranges.get(k);
          if (list) list.push({ s: s - row.start, e: e - row.start, hit });
          else ranges.set(k, [{ s: s - row.start, e: e - row.start, hit }]);
        }
      }
      at = hay.indexOf(q, at + 1);
    }
  }
  return { hits, ranges, capped };
}

export interface ReaderProps {
  row: SessionRow;
  /** Null while the transcript is still being walked. */
  conv: Conversation | null;
  width: number;
  height: number;
  /** Back to the picker, same session still selected. */
  onClose: () => void;
  /** Resume this session — the reader is a step on the way, not a dead end. */
  onResume: () => void;
  /** Ctrl+C: leave the picker entirely. */
  onCancel: () => void;
}

/**
 * SEARCH JUMPS; IT DOES NOT FILTER. The alternative was considered and rejected.
 *
 * Filtering to matching turns is the right shape for a LIST, where each row is a
 * self-contained label — which is exactly what the picker's own filter does to the
 * worktree and session lists. A conversation is not a list: the value of a turn is mostly
 * in the turn beside it. Filtering "handshake" down to the four turns containing the word
 * throws away the model's answer whenever the word appeared only in the question, which is
 * the common case, and it silently reorders the reader's mental model of the session into
 * a set of disconnected fragments.
 *
 * So the transcript stays whole and intact, every occurrence highlights in place, `n` /
 * `N` step between them, and the count is on screen — which is the one affordance
 * filtering would have bought (`how many are there`) delivered without the cost. The
 * scrollbar's warn-coloured ticks add what filtering could not: WHERE they are, across the
 * whole conversation, without moving.
 */
export function ConversationReader({
  row,
  conv,
  width,
  height,
  onClose,
  onResume,
  onCancel,
}: ReaderProps): React.ReactNode {
  const [top, setTop] = useState(0);
  const [query, setQuery] = useState("");
  /** True while `/` has the keyboard: printable keys extend the query. */
  const [typing, setTyping] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);

  // ── geometry (arithmetic: the rows carry a numeric width) ────────────────
  // Header, status strip and footer are one row each; the panel's border is two more.
  const CHROME_ROWS = 5;
  const viewport = Math.max(1, height - CHROME_ROWS);
  // A flush panel's children own the edge, so they size to `width - 2`.
  const inner = Math.max(20, width - 2);
  const contentW = inner - BAR_W;
  // One column of air between the longest possible line and the scrollbar. Without it a
  // line that happens to fill its width abuts the bar and the two read as one object —
  // measured at 80 columns, where the opening prompt ran `…first and` straight into the
  // thumb. The pad in `ReaderRow` then always has at least this column to spend.
  const textW = Math.max(8, contentW - GUTTER - 1);

  // Memoised so the loading render does not hand `layoutRows` a fresh `[]` on every frame
  // — a new array identity re-runs the wrap of the whole conversation for nothing.
  const turns = useMemo(() => conv?.turns ?? NO_TURNS, [conv]);
  const { rows, turnStart, turnEnd } = useMemo(() => layoutRows(turns, textW), [turns, textW]);
  const search = useMemo(
    () => buildSearch(turns, rows, turnStart, turnEnd, query),
    [turns, rows, turnStart, turnEnd, query]
  );

  const maxTop = Math.max(0, rows.length - viewport);
  const clampTop = (v: number): number => Math.max(0, Math.min(v, maxTop));

  /** Put `r` a third of the way down, so a hit arrives with context above it. */
  const reveal = (r: number): void => setTop(clampTop(r - Math.floor(viewport / 3)));

  /**
   * Open at the END of the conversation.
   *
   * A session you are deciding whether to resume is defined by where it got to, and the
   * picker panel that sent you here was already showing its tail — landing at the top
   * would drop the reader thousands of rows away from the thing it was opened to see.
   * `g` goes to the beginning.
   */
  useEffect(() => {
    setTop(Math.max(0, rows.length - viewport));
  }, [rows.length, viewport]);

  // A new query re-aims the view at the first hit AT OR AFTER where the reader is
  // standing, falling back to the first hit anywhere — searching should not silently
  // teleport you backwards through a conversation you were already reading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps deliberately tuned to control re-derivation
  useEffect(() => {
    if (search.hits.length === 0) return;
    let i = search.hits.findIndex((r) => r >= top);
    if (i === -1) i = 0;
    setMatchIdx(i);
    reveal(search.hits[i]!);
    // `top` is deliberately NOT a dependency: this fires when the QUERY changes, and
    // re-running it on every scroll would drag the view back to a match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const step = (d: number): void => {
    if (search.hits.length === 0) return;
    const i = (matchIdx + d + search.hits.length) % search.hits.length;
    setMatchIdx(i);
    reveal(search.hits[i]!);
  };

  useKeyboard((key) => {
    const name = key.name;
    if (key.ctrl && name === "c") {
      onCancel();
      return;
    }
    if (name === "escape") {
      // Two stages, the same as the picker's filter: a query is what escape clears
      // first, and only an empty one closes the screen.
      if (typing || query) {
        setTyping(false);
        setQuery("");
        return;
      }
      onClose();
      return;
    }
    if (name === "return" || name === "enter") {
      // In search mode Enter COMMITS the query — it hands the keyboard back so `n` steps
      // matches instead of typing an `n` — and outside it, Enter means what it means
      // everywhere else in this picker: resume.
      if (typing) {
        setTyping(false);
        return;
      }
      onResume();
      return;
    }
    if (name === "up") return setTop((t) => clampTop(t - 1));
    if (name === "down") return setTop((t) => clampTop(t + 1));
    if (name === "pageup") return setTop((t) => clampTop(t - viewport));
    if (name === "pagedown") return setTop((t) => clampTop(t + viewport));
    if (name === "home") return setTop(0);
    if (name === "end") return setTop(maxTop);
    if (name === "backspace") {
      if (typing) setQuery((q) => q.slice(0, -1));
      return;
    }

    const ch = key.raw;
    const printable = ch && ch.length === 1 && ch >= " " && ch !== "\x7f";
    if (typing) {
      if (printable) setQuery((q) => q + ch);
      return;
    }
    if (name === "slash" || ch === "/") {
      setTyping(true);
      return;
    }
    // `n` / `N`: next and previous match. Letters arrive lowercase with `shift` reported
    // separately, so `key.name === "N"` would be dead code.
    if (name === "n") return step(key.shift ? -1 : 1);
    if (ch === "g") return setTop(0);
    if (ch === "G") return setTop(maxTop);
    if (name === "space") return setTop((t) => clampTop(t + viewport));
  });

  // ── header ───────────────────────────────────────────────────────────────
  const label = sessionLabel(row);
  const mb = row.sizeBytes / 1_048_576;
  const size =
    mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
  const stats = conv
    ? `${turns.length} turns · ${rows.length} lines · ${size} transcript`
    : `reading ${size}…`;

  const visible = rows.slice(top, top + viewport);
  const barCells = useMemo(
    () => scrollbarCells(viewport, rows.length, top, search.hits),
    [viewport, rows.length, top, search.hits]
  );

  const pct = rows.length <= viewport ? 100 : (top / maxTop) * 100;
  /**
   * Columns the position group on the right of the status strip owns: `NNNN/NNNN`, two of
   * gap, a 12-cell meter, and the row's own padding. The query is clipped to what is left
   * because the two groups are `<text>` SIBLINGS in a `space-between` row — a query long
   * enough to meet the meter would let Yoga shrink one of them, and it takes the columns
   * off the last, which here is the meter.
   */
  const POSITION_COLS = 26;
  // "14 of 16 matches", not "14/16" — the slash form reads as a fraction, and this number
  // is a position within a set, which is the thing `n` and `N` move.
  const matchLabel = search.hits.length
    ? `${matchIdx + 1} of ${search.hits.length}${search.capped ? "+" : ""} matches`
    : query
      ? "no matches"
      : "";

  return (
    <box flexDirection="column" height={height} backgroundColor={C.bg}>
      <box flexDirection="row" justifyContent="space-between" height={1} paddingX={1}>
        <text>
          <span fg={tokens.accent} attributes={A.bold}>
            claudish
          </span>
          <span fg={tokens.subtle}> reader</span>
          {conv && conv.dropped > 0 ? (
            <span fg={tokens.warn}>{`  ${conv.dropped} older turns dropped (cap)`}</span>
          ) : (
            <span />
          )}
          {conv?.anyElided ? <span fg={tokens.warn}>{"  long turns truncated"}</span> : <span />}
        </text>
        <text>
          <span fg={tokens.subtle}>{stats}</span>
        </text>
      </box>

      <Panel
        title={`conversation · ${truncate(label, Math.max(10, width - 20))}`}
        flush
        flexGrow={1}
        flexBasis={0}
      >
        {!conv ? (
          <text fg={tokens.subtle}>{"  reading transcript…"}</text>
        ) : rows.length === 0 ? (
          <text fg={tokens.trace}>
            {"  no conversation recorded — this transcript has no main-thread prose"}
          </text>
        ) : (
          visible.map((r, i) => {
            // Keyed by ABSOLUTE line, not by viewport slot. `i` alone is the slot, and every
            // row reuses its slot on every scroll — so a one-line scroll would hand all N rows
            // new content under the same N keys. The line number is the row's own identity, so
            // scrolling by one moves N-1 rows and mounts exactly one. Named rather than inlined
            // because it is the line, not an index, and the name is what says so.
            const line = top + i;
            return (
              <ReaderRow
                key={line}
                row={r}
                turn={r.turn >= 0 ? turns[r.turn]! : undefined}
                hl={search.ranges.get(line)}
                current={matchIdx}
                width={contentW}
                bar={barCells[i] ?? "track"}
              />
            );
          })
        )}
      </Panel>

      {/* Status strip: the query when there is one, the position always. A scroll
          position is a bounded value, so it takes a meter rather than a bare percentage —
          and the meter is the one graphic on a screen that is otherwise, correctly, prose. */}
      <box flexDirection="row" justifyContent="space-between" height={1} paddingX={1}>
        <text>
          {query || typing ? (
            <>
              <span fg={tokens.warn} attributes={A.bold}>
                {truncate(
                  `/${query}`,
                  Math.max(4, width - POSITION_COLS - displayWidth(matchLabel) - 4)
                )}
              </span>
              <span fg={typing ? tokens.warn : tokens.trace}>{typing ? "▌" : " "}</span>
              <span fg={search.hits.length ? tokens.subtle : tokens.trace}>
                {matchLabel ? `  ${matchLabel}` : ""}
              </span>
            </>
          ) : (
            <span fg={tokens.trace}>/ to search</span>
          )}
        </text>
        <text>
          <span
            fg={tokens.subtle}
          >{`${Math.min(rows.length, top + viewport)}/${rows.length}  `}</span>
          <MeterSpan pct={pct} width={12} ramp={ramps.volume} />
        </text>
      </box>

      <box flexDirection="row" height={1} paddingX={1} gap={2}>
        <text fg={tokens.subtle}>↑↓ ⇞⇟ scroll</text>
        <text fg={tokens.subtle}>g/G ends</text>
        <text fg={typing ? tokens.warn : tokens.subtle}>/ search</text>
        <text fg={search.hits.length ? tokens.subtle : tokens.trace}>n/N match</text>
        <text fg={tokens.accent}>⏎ resume</text>
        <text fg={tokens.subtle}>esc back</text>
      </box>
    </box>
  );
}

/** What one column of the drawn scrollbar shows on a given row. */
type BarCell = "track" | "thumb" | "hit";

/**
 * The scrollbar column, one cell per visible row.
 *
 * It carries two things at once. The THUMB is the ordinary "where am I" — proportional,
 * at least one cell so it never disappears in a long conversation. The HIT ticks are the
 * part worth having: each visible row stands for `total / viewport` document rows, so a
 * tick says a search match lives in that slice of the whole transcript. That turns the bar
 * into a map of the matches, which is what filtering-to-matching-turns would have shown by
 * destroying the conversation, delivered without touching it.
 *
 * A hit BEATS the thumb on a shared cell: while searching, where the matches are is the
 * question, and the thumb's neighbours still locate the viewport.
 */
export function scrollbarCells(
  viewport: number,
  total: number,
  top: number,
  hits: readonly number[]
): BarCell[] {
  const cells: BarCell[] = new Array(viewport).fill("track");
  if (total <= 0) return cells;
  if (total > viewport) {
    const size = Math.max(1, Math.round((viewport / total) * viewport));
    const span = Math.max(1, total - viewport);
    const start = Math.min(viewport - size, Math.round((top / span) * (viewport - size)));
    for (let i = 0; i < size; i++) cells[start + i] = "thumb";
  } else {
    cells.fill("thumb");
  }
  for (const h of hits) {
    const i = Math.min(viewport - 1, Math.floor((h / total) * viewport));
    if (i >= 0) cells[i] = "hit";
  }
  return cells;
}

const BAR_COLOR: Record<BarCell, string> = {
  track: tokens.border,
  thumb: tokens.accent,
  hit: tokens.warn,
};

/**
 * One row of the transcript: rail, role chip (or its blank), wrapped text with the search
 * hits highlighted, filler, and the scrollbar cell.
 *
 * ALL OF IT IN ONE `<text>`. As a flex row — a rail `<text>`, a `Badge`, a content
 * `<text>` and a bar `<text>` — Yoga's default `flexShrink: 1` takes columns off the last
 * sibling the moment the row is one column over budget, which in this file would eat the
 * scrollbar rather than the prose and would do it only on the rows that happen to be full.
 * Spans inside a single `<text>` have no such failure mode.
 */
function ReaderRow({
  row,
  turn,
  hl,
  current,
  width,
  bar,
}: {
  row: Row;
  turn: ReaderTurn | undefined;
  hl: Hl[] | undefined;
  /** Index of the hit `n` is currently standing on — it gets the accent fill. */
  current: number;
  width: number;
  bar: BarCell;
}): React.ReactNode {
  if (!turn) {
    // The spacer between two turns: no rail, so the eye reads it as a break rather than
    // as an empty line inside a turn.
    return (
      <text>
        <span>{" ".repeat(Math.max(0, width))}</span>
        <span bg={BAR_COLOR[bar]}> </span>
      </text>
    );
  }
  const text = turn.text.slice(row.start, row.end);
  const fg = turn.role === "user" ? tokens.text : C.fgMuted;
  const railFg = turn.role === "user" ? SPEAKER.you : SPEAKER.ai;
  // The rail is paid for at RAIL_W (see its definition), so the budget subtracts the
  // constant and never measures the glyph.
  const pad = Math.max(0, width - GUTTER - displayWidth(text));

  return (
    <text>
      <span fg={railFg}>{RAIL}</span>
      {row.first ? (
        <BadgeSpan
          label={turn.role === "user" ? "you" : "ai"}
          bg={turn.role === "user" ? SPEAKER.you : SPEAKER.ai}
          width={ROLE_W}
        />
      ) : (
        <span>{" ".repeat(ROLE_W)}</span>
      )}
      {hl && hl.length > 0 ? highlighted(text, hl, current, fg) : <span fg={fg}>{text}</span>}
      <span>{" ".repeat(pad)}</span>
      <span bg={BAR_COLOR[bar]}> </span>
    </text>
  );
}

/**
 * A row's text split into plain and highlighted runs.
 *
 * The runs arrive in document order because `buildSearch` walks a turn forwards, so this
 * is a single pass with no sorting. Overlapping occurrences (`aa` in `aaa`) can produce
 * runs that touch or overlap; `from` only ever moves forward, so an overlap collapses into
 * one highlight rather than emitting a negative-length slice.
 */
function highlighted(text: string, hl: Hl[], current: number, fg: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let from = 0;
  for (let i = 0; i < hl.length; i++) {
    const { s, e, hit } = hl[i]!;
    if (e <= from) continue;
    const start = Math.max(from, s);
    if (start > from)
      out.push(
        <span key={`p${i}`} fg={fg}>
          {text.slice(from, start)}
        </span>
      );
    const bg = hit === current ? tokens.accent : tokens.warn;
    out.push(
      <span key={`h${i}`} fg={tokens.ink} bg={bg} attributes={A.bold}>
        {text.slice(start, e)}
      </span>
    );
    from = e;
  }
  if (from < text.length)
    out.push(
      <span key="tail" fg={fg}>
        {text.slice(from)}
      </span>
    );
  return <>{out}</>;
}
