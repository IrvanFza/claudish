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

import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { A, C } from "../tui/theme.js";
import { displayWidth, padTo, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { BadgeSpan, Panel, Sparkline } from "../tui/viz/widgets.js";
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
/** Session details, under the RIGHT column only. */
const SESSION_DETAIL_H = 11;
/** Worktree details, spanning BOTH columns along the bottom. */
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
 * Desaturated badge fills, for the two places a BADGE is still the right answer: the
 * worktree strip's git state, and the role chips in the transcript tail.
 *
 * A badge is dark ink on a SATURATED fill, and `C`'s neon tokens are foreground colours —
 * as a solid block behind text they glare (the same reason `pillKeyBg` and the latency
 * buckets exist in `tui/theme.ts`). These are the mid-lightness versions, so a chip reads
 * as data rather than as a warning light.
 *
 * THE LISTS NO LONGER USE THEM AT ALL. A badge is an attention-grabber, and a list where
 * every row carries three of them spends all its contrast on metadata — the filled blocks
 * won the eye and the worktree NAME, the one field the list exists to be scanned by, came
 * second to a `17h` chip. In the lists the same facts are now dim tinted text (`STAT`
 * below), which restores the hierarchy without losing the colour coding.
 */
const CHIP = {
  fresh: "#2d6e3e", //   the person speaking
  dirty: "#8a5a1d", //   uncommitted changes
  clean: "#2d6e3e", //   nothing to commit
  ahead: "#1f6d75", //   unpushed commits / the model speaking
  behind: "#9e2b2b", //  commits to pull
} as const;

/**
 * Foreground tints for list metadata — the un-badged counterpart to `CHIP`.
 *
 * Mid-lightness on purpose. The neon `C` tokens at full strength beside white body text
 * read as MORE important than it, which is backwards for a subtitle; these sit visibly
 * below `tokens.text` while still coding red/amber/teal the way they do everywhere else.
 * `value` is `C.fgMuted` — claudish's palette has no "secondary text" token, and `C` is
 * the source of truth `viz/tokens.ts` itself adapts, so this reads from it directly
 * rather than inventing a fourth grey.
 */
const STAT = {
  value: C.fgMuted, // counts, sizes, ages
  dirty: "#c08a3e", // uncommitted changes
  ahead: "#4f9aa6", //  unpushed commits
  behind: "#c05a5a", // commits to pull
} as const;

/** A run of coloured text, laid out by `Segments`. */
interface Seg {
  t: string;
  fg: string;
}

/**
 * Lay coloured fragments into EXACTLY `width` columns, left- or right-aligned.
 *
 * Returns `<span>`s, so it composes inside one `<text>` — which is the entire point.
 * The obvious alternative, a flex ROW of `<text>` siblings, is what produced the bug
 * this replaces: Yoga's default `flexShrink: 1` claws columns back from `<text>`
 * children the moment a row is over budget, and it took them off the LAST one, so the
 * branch name rendered as `⎇ mai` with thirty-odd empty columns to its right. The
 * vendored widgets defend themselves with `flexShrink={0}`; a bare `<text>` cannot, and
 * a single `<text>` has no siblings to lose to.
 *
 * Padding and clipping both happen here, against `displayWidth`, so a row is never one
 * column over (which would wrap and destroy every row below it) and never short of the
 * right-aligned edge it was promised.
 */
function Segments({
  segs,
  width,
  align = "left",
}: {
  segs: readonly Seg[];
  width: number;
  align?: "left" | "right";
}): React.ReactNode {
  const kept: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const w = displayWidth(s.t);
    if (used + w > width) {
      const room = width - used;
      if (room > 0) kept.push({ t: truncate(s.t, room), fg: s.fg });
      used = width;
      break;
    }
    kept.push(s);
    used += w;
  }
  const pad = Math.max(0, width - used);
  return (
    <>
      {align === "right" && pad > 0 ? <span>{" ".repeat(pad)}</span> : null}
      {kept.map((s, i) => (
        <span key={`${i}-${s.t}`} fg={s.fg}>
          {s.t}
        </span>
      ))}
    </>
  );
}

/** The dim `·` between two metadata fragments. */
const SEP = " · ";

/** Total columns a run of segments will paint. */
function segsWidth(segs: readonly Seg[]): number {
  return segs.reduce((w, s) => w + displayWidth(s.t), 0);
}

/**
 * A worktree's status cluster, as coloured fragments.
 *
 * Module-level rather than inline in the row because the LIST measures it before any row
 * renders — see `unitFits` in `ResumePicker`. Two copies of this composition, one to
 * measure and one to draw, is exactly the drift that puts a column one cell over budget.
 */
function worktreeStats(g: WorktreeGroup, count: number, unit: boolean): Seg[] {
  const stale = !g.lastActiveMs || Date.now() - g.lastActiveMs >= STALE_MS;
  const segs: Seg[] = [];
  const add = (t: string, fg: string): void => {
    if (segs.length > 0) segs.push({ t: SEP, fg: tokens.border });
    segs.push({ t, fg });
  };
  if (g.activeNow) add("● live", tokens.success);
  add(unit ? `${count} session${count === 1 ? "" : "s"}` : String(count), STAT.value);
  if (g.dirty) add(`✎${g.dirty}`, STAT.dirty);
  if (g.ahead) add(`↑${g.ahead}`, STAT.ahead);
  if (g.behind) add(`↓${g.behind}`, STAT.behind);
  add(g.lastActiveMs ? age(g.lastActiveMs) : "—", stale ? tokens.trace : STAT.value);
  return segs;
}

/**
 * One worktree: the NAME on its own line, its STATUS right-aligned on the next.
 *
 * Two rules fell out of watching this list at 118 columns. First, the name gets the whole
 * width and nothing shares its line — an earlier version put chips beside it and padded
 * whatever was absent, so every row was a truncated name (`minimax-suppo…`) next to a
 * void. Second, the status is right-ALIGNED and dim rather than left-packed and badged:
 * flush right gives the eye a second vertical rule to scan down (all the ages line up),
 * and dropping the saturated fills is what lets the name dominate. Absent facts simply
 * are not drawn — the alignment comes from the pad, not from reserved columns, so there
 * is no hole where a chip would have been.
 *
 * Order within the cluster is fixed — live, threads, uncommitted, unpushed, unpulled,
 * age — so the eye can still learn one position per fact. Branch, path and created-date
 * live in the worktree strip along the bottom, which shows them in full.
 */
function WorktreeRow({
  g,
  cursor,
  width,
  count,
  unit,
}: {
  g: WorktreeGroup;
  cursor: boolean;
  width: number;
  /** Sessions actually listed for this worktree — post agent-filter, not `g.sessions`. */
  count: number;
  /** Whether the whole column has room to spell out "sessions" — decided by the list. */
  unit: boolean;
}): React.ReactNode {
  // No `▶` prefix and no indent: a conditional marker shifts every other name by two
  // columns to mark one row, and "you are here" is already carried by the green and
  // spelled out in the strip below. Deleted worktrees grey out, everything else is body
  // text — the name is the loudest thing in the pane by design.
  const nameColor = !g.live ? tokens.dead : g.current ? tokens.success : tokens.text;
  const segs = worktreeStats(g, count, unit);

  return (
    <box flexDirection="column" height={2} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text>
        <span fg={nameColor} attributes={cursor || g.current ? A.bold : undefined}>
          {truncate(g.name, width)}
        </span>
      </text>
      <text>
        <Segments segs={segs} width={width} align="right" />
      </text>
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
        <span fg={tokens.subtle} attributes={A.bold}>{text}</span>
        <span fg={tokens.border}>{"─".repeat(Math.max(0, width - text.length))}</span>
      </text>
    </box>
  );
}

/**
 * Sessions per day over the last two weeks, oldest → newest.
 *
 * A worktree's rhythm is genuinely a time series, so it gets a sparkline rather than a
 * "last active 6d" line. Cheap: it reads only mtimes already collected by the list pass.
 */
function activitySeries(sessions: SessionRow[], days = 14): number[] {
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
}: {
  row: SessionRow;
  cursor: boolean;
  width: number;
  even: boolean;
  indent?: number;
}): React.ReactNode {
  const live = isActive(row);
  const pad = " ".repeat(indent);
  const mb = row.sizeBytes / 1_048_576;
  const size = mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
  const gutter = `${pad}${cursor ? "▍" : " "} `;
  const titleW = Math.max(10, width - indent - 4);

  const meta: Seg[] = [{ t: age(row.mtimeMs), fg: live ? tokens.success : STAT.value }];
  meta.push({ t: SEP, fg: tokens.border }, { t: size, fg: STAT.value });
  if (row.gitBranch) {
    meta.push({ t: SEP, fg: tokens.border }, { t: `⎇ ${row.gitBranch}`, fg: tokens.trace });
  }

  return (
    <box
      flexDirection="column"
      height={2}
      backgroundColor={cursor ? C.bgHighlight : even ? undefined : C.bgAlt}
    >
      <text>
        <span fg={cursor ? tokens.accent : tokens.border}>{gutter}</span>
        <span fg={live ? tokens.success : tokens.border}>{live ? "● " : "· "}</span>
        {/* The title is body text on EVERY row, not just the selected one. Dimming the
            unselected titles made the whole pane read as disabled and left the cursor
            doing two jobs; the highlight bar behind the row is already unambiguous, so
            the cursor only needs to add weight. */}
        <span fg={tokens.text} attributes={cursor ? A.bold : undefined}>
          {truncate(sessionLabel(row), titleW)}
        </span>
      </text>
      {/* ONE <text>, and that is the fix rather than a simplification — see `Segments`.
          As a flex row of a badge, a `Meter` and a size+branch <text>, Yoga shrank the
          last sibling by a column and clipped `main` to `mai` while the row still had
          thirty free columns to its right. */}
      <text>
        <span fg={cursor ? tokens.accent : tokens.border}>{`${gutter}  `}</span>
        <Segments segs={meta} width={Math.max(0, width - indent - 4)} />
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
        <span fg={tokens.trace}>{truncate(`  ${hint}`, Math.max(0, width - label.length - 6))}</span>
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
  // Re-render tick. Hydration mutates rows in place (they are shared with the caller),
  // so there is no new object for React to diff against — the counter is what tells it
  // the rows it already holds now say more than they did.
  const [, setTick] = useState(0);

  /** Human sessions per worktree — what the sidebar counts and the list leads with. */
  const listed = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const g of groups) m.set(g.name, g.sessions.filter((s) => !isAgentSession(s)));
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
    const st = matching.filter((g) => !g.current && now - g.lastActiveMs >= STALE_MS).sort(byRecency);
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
  const agentRows = useMemo(
    () => (group ? group.sessions.filter(isAgentSession) : []),
    [group]
  );

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
  const listRows = Math.max(3, height - SESSION_DETAIL_H - WORKTREE_DETAIL_H - 4);
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

  const clamp = (v: number, len: number) => Math.max(0, Math.min(v, len - 1));

  useKeyboard((key) => {
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
    // `a` is the one letter the filter does not get, because a toggle the user cannot
    // find is the same as no toggle. The footer advertises it.
    if (name === "a" && !key.ctrl && !key.meta) {
      setAgentsOpen((v) => !v);
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
    if (ch && ch.length === 1 && ch >= " " && ch !== "\x7f" && ch !== "a") {
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
   * Does the WHOLE column have room to spell out "sessions"?
   *
   * Decided once for the list, not per row. Per-row adaptation is what a first version
   * did, and it rendered two worktrees with the same count differently — `1` on the row
   * that also had a `● live` chip, `1 session` on the one that did not — which reads as a
   * bug rather than as a fit. A column is a column: one form for all of it, chosen by the
   * widest member.
   */
  const unitFits = useMemo(
    () =>
      visibleGroups.every(
        (g) => segsWidth(worktreeStats(g, listed.get(g.name)?.length ?? 0, true)) <= sideInner
      ),
    [visibleGroups, listed, sideInner]
  );

  // Count what the user can actually see. Reporting the raw corpus (2,025) next to a
  // list of 95 reads as a bug in the picker rather than as a filter doing its job.
  const shownSessions = [...listed.values()].reduce((a, v) => a + v.length, 0);

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
          <span fg={tokens.subtle}>{`${visibleGroups.length} worktrees · ${shownSessions} sessions`}</span>
          {filter ? <span fg={tokens.warn}>{`  /${filter}`}</span> : <span />}
        </text>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {/* ── worktrees ─────────────────────────────────────────────────── */}
        <box width={sidebarW} flexDirection="column" minHeight={0}>
          <Panel title="worktrees" focused={pane === "worktrees"} flush flexGrow={1} flexBasis={0}>
            <scrollbox focused={false} flexGrow={1}>
              {fresh.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={i === wtCursor}
                  width={sideInner}
                  count={listed.get(g.name)?.length ?? 0}
                  unit={unitFits}
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
                  unit={unitFits}
                />
              ))}
            </scrollbox>
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
            <scrollbox focused={false} flexGrow={1}>
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
                    />
                  )
                )
              )}
            </scrollbox>
          </Panel>

          {/* Content-sized, so flexShrink={0}: without it the scrollbox above (whose
              intrinsic height is its whole content) starves this panel to one row. */}
          <box height={SESSION_DETAIL_H} flexShrink={0}>
            <Panel title="session" flexGrow={1}>
              {selected ? (
                <SessionDetail row={selected} width={sessionDetailInner} />
              ) : (
                <text fg={tokens.subtle}>
                  {cursorItem?.kind === "agents" ? "agent sessions — enter to expand" : "nothing selected"}
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
      label: group.dirty > 0 ? `✎${group.dirty} uncommitted` : "clean",
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
  const idAvail = Math.max(12, width - L - displayWidth(marker) - 5 - badgeW - 1);
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
        <span fg={group.current ? tokens.success : tokens.dead}>{marker}</span>
        <span fg={tokens.subtle}>{"   ⎇ "}</span>
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
        <Sparkline values={spark} fg={tokens.info} />
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
function SessionDetail({ row, width }: { row: SessionRow; width: number }): React.ReactNode {
  const mb = row.sizeBytes / 1_048_576;
  const L = 9;
  const size = mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.round(row.sizeBytes / 1024)} KB`;
  const full = `· ${size}${row.lastMessageChars !== undefined ? ` · last msg ${row.lastMessageChars} ch` : ""}`;
  // `L + 1` for the label and its gap, `+ 1` for the gap before the suffix.
  const suffixRoom = width - L - 1 - row.id.length - 1;
  const suffix =
    displayWidth(full) <= suffixRoom ? full : displayWidth(`· ${size}`) <= suffixRoom ? `· ${size}` : "";
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
      <Conversation turns={row.recentTurns ?? []} width={width} max={6} />
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
            bg={t.role === "user" ? CHIP.fresh : CHIP.ahead}
            width={ROLE_W}
          />
          <span fg={t.role === "user" ? tokens.text : STAT.value}>
            {truncate(t.text, textW)}
          </span>
        </text>
      ))}
    </box>
  );
}
