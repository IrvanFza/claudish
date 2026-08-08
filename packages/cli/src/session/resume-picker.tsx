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
import { padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { ramps, tokens } from "../tui/viz/tokens.js";
import { BadgeSpan, Meter, Panel, Sparkline } from "../tui/viz/widgets.js";
import {
  type SessionRow,
  type WorktreeGroup,
  hydrateSession,
  isActive,
  isAgentSession,
  sessionLabel,
} from "./session-discovery.js";

/** `Panel` costs 4 columns of chrome; a `<scrollbox>` inside it costs 1 more. */
const PANEL_CHROME = 4;
const SCROLL_CHROME = 1;
/** Narrow terminals keep the compact sidebar; wide ones get room for branch + state. */
const SIDEBAR_NARROW = 30;
const SIDEBAR_WIDE = 40;
const PREVIEW_H = 13;

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
 * Desaturated badge fills.
 *
 * A badge is dark ink on a SATURATED fill, and `C`'s neon tokens are foreground colours —
 * as a solid block behind text they glare (the same reason `pillKeyBg` and the latency
 * buckets exist in `tui/theme.ts`). These are the mid-lightness versions, so a row of
 * chips reads as data rather than as a warning light.
 */
/**
 * Chip COLUMN widths, in cells. Constant on purpose.
 *
 * The alignment bug this fixes: the name width was derived from each row's own chip
 * text, so a worktree with `1`/`7s` reserved less than one with `611`/`144d` and every
 * column in the pane wandered by a few cells per row. Fixed columns mean the name is
 * padded to the same width everywhere and the chips stack in a true column. `BadgeSpan`
 * takes `width` and pads OUTSIDE the fill, so the chips stay chip-sized — padding inside
 * the label is what fuses a stack of them into one solid rectangle.
 */
const COUNT_COL = 6;
const AGE_COL = 7;
const STATE_COL = 14;

const CHIP = {
  count: "#2c4a6e", //   sessions — neutral blue, the most common chip
  fresh: "#2d6e3e", //   recently used
  old: "#3a3a3a", //     stale
  dirty: "#8a5a1d", //   uncommitted changes
  clean: "#2d6e3e", //   nothing to commit
  ahead: "#1f6d75", //   unpushed commits
  behind: "#9e2b2b", //  commits to pull
} as const;

/**
 * One worktree, as two rows of chips.
 *
 * Two rows because the question this pane answers is not "what is it called" but "which
 * of these is worth going back to", and that needs branch, working-tree state and
 * recency together. Discrete facts are BADGES rather than coloured text — a count, an
 * age and an ahead/behind pair are exactly the "discrete status" the visual contract
 * says to chip, and chips survive being scanned at speed in a way `✎3` in orange does
 * not. Names and branches TRUNCATE here on purpose; the details panel carries them in
 * full, which is why they do not need to fit.
 *
 * Each row is ONE `<text>` of spans — sibling `<text>`s in a height-2 box overprint.
 */
function WorktreeRow({
  g,
  cursor,
  width,
  count,
}: {
  g: WorktreeGroup;
  cursor: boolean;
  width: number;
  /** Sessions actually listed for this worktree — post agent-filter, not `g.sessions`. */
  count: number;
}): React.ReactNode {
  const nameColor = !g.live
    ? tokens.dead
    : g.current
      ? tokens.success
      : cursor
        ? tokens.text
        : tokens.subtle;

  // line 1 — name, then "how much" and "how recently" as chips in fixed columns
  const used = g.lastActiveMs ? age(g.lastActiveMs) : "?";
  const usedBg = g.lastActiveMs && Date.now() - g.lastActiveMs < STALE_MS ? CHIP.fresh : CHIP.old;
  const nameW = Math.max(6, width - 2 - 2 - COUNT_COL - AGE_COL);

  // line 2 — branch, then working-tree state. `↑`/`↓` are the conventional pair for
  // unpushed / unpulled commits, so they are chipped separately rather than merged.
  const chips: Array<[string, string]> = [];
  if (g.dirty !== undefined && g.dirty > 0) chips.push([`✎${g.dirty}`, CHIP.dirty]);
  else if (g.dirty === 0) chips.push(["✓", CHIP.clean]);
  if (g.ahead) chips.push([`↑${g.ahead}`, CHIP.ahead]);
  if (g.behind) chips.push([`↓${g.behind}`, CHIP.behind]);
  const branchW = Math.max(4, width - 4 - STATE_COL);

  return (
    <box flexDirection="column" height={2} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text>
        <span fg={g.current ? tokens.success : tokens.trace}>{g.current ? "▶ " : "  "}</span>
        <span fg={nameColor} attributes={cursor ? A.bold : undefined}>
          {padTo(truncate(g.name, nameW), nameW)}
        </span>
        <span fg={g.activeNow ? tokens.success : tokens.trace}>{g.activeNow ? "● " : "  "}</span>
        <BadgeSpan label={String(count)} bg={CHIP.count} width={COUNT_COL} />
        <BadgeSpan label={used} bg={usedBg} width={AGE_COL} />
      </text>
      <text>
        <span fg={tokens.trace}>{"  ⎇ "}</span>
        <span fg={g.live ? tokens.info : tokens.dead}>
          {padTo(truncate(g.branch ?? (g.live ? "detached" : "—"), branchW), branchW)}
        </span>
        {chips.map(([t, bg]) => (
          <BadgeSpan key={t} label={t} bg={bg} />
        ))}
      </text>
    </box>
  );
}

/** A non-selectable divider between the recent worktrees and the stale ones. */
function SectionHeader({ label, width }: { label: string; width: number }): React.ReactNode {
  return (
    <box height={1}>
      <text>
        <span fg={tokens.trace}>{`${label} ${"─".repeat(Math.max(0, width - label.length - 1))}`}</span>
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
  maxSize,
}: {
  row: SessionRow;
  cursor: boolean;
  width: number;
  even: boolean;
  indent?: number;
  maxSize: number;
}): React.ReactNode {
  const live = isActive(row);
  const pad = " ".repeat(indent);
  const mb = row.sizeBytes / 1_048_576;
  const size = mb >= 0.1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))}KB`;
  const titleW = Math.max(10, width - indent - 3);

  return (
    <box
      flexDirection="column"
      height={2}
      backgroundColor={cursor ? C.bgHighlight : even ? undefined : C.bgAlt}
    >
      <text>
        <span fg={cursor ? tokens.accent : tokens.trace}>{`${pad}${cursor ? "▍" : " "} `}</span>
        <span fg={live ? tokens.success : tokens.trace}>{live ? "● " : "· "}</span>
        <span fg={cursor ? tokens.text : tokens.subtle} attributes={cursor ? A.bold : undefined}>
          {truncate(sessionLabel(row), titleW)}
        </span>
      </text>
      {/* `Meter` renders a <text>, and a <text> cannot nest inside a <text> — that is
          why `BadgeSpan` exists and no `MeterSpan` does. So this line is a flex ROW of
          siblings rather than one <text> of spans. A row needs exactly the one line it
          has, so the siblings cannot starve and overprint. */}
      <box flexDirection="row" height={1}>
        <text>
          <span fg={cursor ? tokens.accent : tokens.trace}>{`${pad}${cursor ? "▍" : " "}   `}</span>
          <BadgeSpan label={age(row.mtimeMs)} bg={live ? CHIP.fresh : CHIP.old} width={AGE_COL} />
        </text>
        <Meter pct={(row.sizeBytes / maxSize) * 100} width={10} ramp={ramps.temperature} />
        <text>
          {/* Right-aligned: a size column that jitters at the decimal is exactly the
              drift `padStartTo` exists to stop. */}
          <span fg={tokens.subtle}>{` ${padStartTo(size, 7)}`}</span>
          {row.gitBranch ? (
            <span fg={tokens.trace}>{`  ⎇ ${truncate(row.gitBranch, 18)}`}</span>
          ) : (
            <span />
          )}
        </text>
      </box>
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
  const listRows = Math.max(3, height - PREVIEW_H - 4);
  useEffect(() => {
    const start = Math.max(0, Math.min(sessCursor - 2, items.length - listRows));
    for (const it of items.slice(start, start + listRows + 2)) {
      if (it.kind !== "agents") hydrateSession(it.row);
    }
    if (selected) hydrateSession(selected);
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
  const sidebarW = width >= 120 ? SIDEBAR_WIDE : SIDEBAR_NARROW;
  const rightW = Math.max(30, bodyW - sidebarW);
  const sessInner = rightW - PANEL_CHROME - SCROLL_CHROME;
  // One extra column of slack so a full-width row never abuts the scrollbar thumb.
  const sideInner = sidebarW - PANEL_CHROME - SCROLL_CHROME - 1;
  // The details panel sits in the RIGHT COLUMN, not across the whole terminal, so its
  // inner width comes off `rightW`. Deriving it from the full width made it 40 cells too
  // wide at 145 columns and the conversation ran straight off the panel's right edge.
  const previewInner = rightW - PANEL_CHROME;

  const maxSize = Math.max(1, ...sessions.slice(0, 400).map((s) => s.sizeBytes));

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
          <Panel title="worktrees" focused={pane === "worktrees"} flexGrow={1} flexBasis={0}>
            <scrollbox focused={false} flexGrow={1}>
              {fresh.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={i === wtCursor}
                  width={sideInner}
                  count={listed.get(g.name)?.length ?? 0}
                />
              ))}
              {stale.length > 0 ? <SectionHeader label="stale" width={sideInner} /> : null}
              {stale.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={fresh.length + i === wtCursor}
                  width={sideInner}
                  count={listed.get(g.name)?.length ?? 0}
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
            flexGrow={1}
            flexBasis={0}
          >
            <scrollbox focused={false} flexGrow={1}>
              {items.length === 0 ? (
                <text fg={tokens.subtle}>no sessions match</text>
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
                    />
                  )
                )
              )}
            </scrollbox>
          </Panel>

          {/* Content-sized, so flexShrink={0}: without it the scrollbox above (whose
              intrinsic height is its whole content) starves this panel to one row. */}
          <box height={PREVIEW_H} flexShrink={0}>
            <Panel title="preview" flexGrow={1}>
              {selected ? (
                <Preview
                  row={selected}
                  group={group}
                  width={previewInner}
                  maxSize={maxSize}
                  groupCount={sessions.length}
                />
              ) : (
                <text fg={tokens.subtle}>nothing selected</text>
              )}
            </Panel>
          </box>
        </box>
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

/** One field row in the details panel: dim fixed-width label, value, done. */
function Field({
  label,
  width,
  children,
}: {
  label: string;
  width: number;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <box flexDirection="row" height={1}>
      <text fg={tokens.subtle}>{padTo(label, width)}</text>
      {children}
    </box>
  );
}

/**
 * The details panel: what this worktree is, on the left; how the conversation ended, on
 * the right.
 *
 * TWO COLUMNS because they answer different questions and the panel is wide enough for
 * both — metadata identifies the session, the transcript tail tells you whether it is
 * the one you meant. Stacking them would push the conversation off the bottom, which is
 * where it was before and why it may as well not have existed.
 *
 * Every label is one fixed-width dim column and every value starts at the same x, so the
 * panel reads as a form rather than as a paragraph. Chrome dim, values bright: rule 6.
 */
function Preview({
  row,
  group,
  width,
  maxSize,
  groupCount,
}: {
  row: SessionRow;
  group: WorktreeGroup | undefined;
  width: number;
  maxSize: number;
  /** Sessions listed in this worktree after filtering. */
  groupCount: number;
}): React.ReactNode {
  const mb = row.sizeBytes / 1_048_576;
  const L = 9;
  // The conversation gets the right half on a wide terminal and is dropped entirely on a
  // narrow one, where truncating it to a few cells would be worse than omitting it.
  // Two FIXED columns that sum to the available width, neither allowed to shrink.
  // Mixing `width` with `flexGrow` here was contradictory and let Yoga squeeze whichever
  // side lost: first the transcript to 17 cells, then the metadata labels to `acti…`.
  const GAP = 2;
  const wide = width >= 96;
  const convW = wide ? Math.min(64, Math.floor(width * 0.45)) : 0;
  const metaW = width - convW - (wide ? GAP : 0);

  return (
    <box flexDirection="row" gap={wide ? GAP : 0}>
      {/* The metadata column GROWS and may shrink; the conversation column is fixed and
          may not. Without `flexShrink={0}` the transcript was squeezed to ~17 cells of a
          64-cell column whenever a long path or title overflowed the metadata side —
          Yoga's default `flexShrink: 1` spreads the shortfall across every sibling. */}
      <box flexDirection="column" width={metaW} flexShrink={0}>
        <Field label="worktree" width={L}>
          <text>
            <span fg={tokens.text} attributes={A.bold}>
              {truncate(group?.name ?? "—", Math.max(8, metaW - L - 16))}
            </span>
            {group?.current ? <span fg={tokens.success}>{"  ▶ here"}</span> : <span />}
            {group && !group.live ? <span fg={tokens.dead}>{"  deleted"}</span> : <span />}
          </text>
        </Field>
        <Field label="branch" width={L}>
          <text>
            <span fg={group?.live ? tokens.info : tokens.dead}>
              {`${truncate(group?.branch ?? "—", Math.max(8, metaW - L - STATE_COL))} `}
            </span>
          </text>
          {group?.dirty !== undefined ? (
            <text>
              <BadgeSpan
                label={group.dirty > 0 ? `✎${group.dirty}` : "clean"}
                bg={group.dirty > 0 ? CHIP.dirty : CHIP.clean}
              />
              {group.ahead ? <BadgeSpan label={`↑${group.ahead}`} bg={CHIP.ahead} /> : <span />}
              {group.behind ? <BadgeSpan label={`↓${group.behind}`} bg={CHIP.behind} /> : <span />}
            </text>
          ) : null}
        </Field>
        <Field label="path" width={L}>
          <text fg={tokens.trace}>{truncate(group?.path ?? "—", metaW - L)}</text>
        </Field>
        <Field label="activity" width={L}>
          <Sparkline values={group ? activitySeries(group.sessions) : []} fg={tokens.info} />
          <text fg={tokens.trace}>
            {truncate(
              ` ${groupCount} session${groupCount === 1 ? "" : "s"} · ${
                group?.createdMs ? age(group.createdMs) : "?"
              } old · used ${group?.lastActiveMs ? age(group.lastActiveMs) : "?"} ago`,
              Math.max(0, metaW - L - 15)
            )}
          </text>
        </Field>

        <box height={1} />

        <Field label="session" width={L}>
          <text fg={tokens.text} attributes={A.bold}>
            {truncate(sessionLabel(row), metaW - L)}
          </text>
        </Field>
        <Field label="id" width={L}>
          <text fg={tokens.info}>{truncate(row.id, metaW - L)}</text>
        </Field>
        <Field label="size" width={L}>
          <Meter pct={(row.sizeBytes / maxSize) * 100} width={14} ramp={ramps.temperature} />
          <text fg={tokens.text}>{` ${mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.round(row.sizeBytes / 1024)} KB`}`}</text>
        </Field>
      </box>

      {wide ? (
        <box width={convW} flexShrink={0} overflow="hidden">
          <Conversation turns={row.recentTurns ?? []} width={convW} />
        </box>
      ) : null}
    </box>
  );
}

/**
 * The tail of the conversation, oldest at the top.
 *
 * Roles are BADGES rather than coloured prose, and the two are deliberately different
 * colours that mean the same thing everywhere else in claudish — cyan for the machine,
 * green for the person. Each turn is clipped to two lines: enough to recognise where the
 * session got to, not so much that the panel becomes a transcript viewer.
 */
function Conversation({
  turns,
  width,
}: {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  width: number;
}): React.ReactNode {
  if (turns.length === 0) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={tokens.trace}>no conversation recorded</text>
      </box>
    );
  }
  const ROLE_W = 8;
  const textW = Math.max(10, width - ROLE_W - 2);
  // Newest last, and only as many as fit — the panel is 9 rows and each turn takes one.
  const shown = turns.slice(-8);
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      {shown.map((t, i) => (
        // ONE <text> per turn. As two sibling <text>s in a row, Yoga shrank the
        // content one to its minimum and the transcript rendered ~17 cells wide
        // regardless of the column it had been given.
        <text key={`${i}-${t.text.slice(0, 12)}`}>
          <span fg={tokens.trace}>{"▍"}</span>
          <BadgeSpan
            label={t.role === "user" ? "you" : "model"}
            bg={t.role === "user" ? CHIP.fresh : CHIP.ahead}
            width={ROLE_W}
          />
          <span fg={t.role === "user" ? tokens.text : tokens.subtle}>
            {truncate(t.text, textW)}
          </span>
        </text>
      ))}
    </box>
  );
}
