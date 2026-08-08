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
import { Meter, Panel, Sparkline } from "../tui/viz/widgets.js";
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
const PREVIEW_H = 9;

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

/**
 * One worktree, as two rows.
 *
 * Two rather than one because the question this pane answers is not "what is it called"
 * but "which of these is worth going back to", and that needs branch, working-tree state
 * and recency together. Colour is the encoding, not decoration: green means live or
 * clean, orange means uncommitted work, cyan means unpushed commits, and a dimmed name
 * means the worktree is gone. Each row is ONE `<text>` of spans — sibling `<text>`s in a
 * height-2 box would overprint.
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
  // line 1: marker + name + activity dot + session count
  const COUNT_W = 5;
  const nameW = Math.max(6, width - 2 - COUNT_W - 2);
  const nameColor = !g.live ? tokens.dead : g.current ? tokens.success : cursor ? tokens.text : tokens.subtle;

  // line 2: branch, then state badges, then created·used ages
  const ages = `${g.createdMs ? age(g.createdMs) : "?"}·${g.lastActiveMs ? age(g.lastActiveMs) : "?"}`;
  const flags: Array<[string, string]> = [];
  if (g.dirty !== undefined && g.dirty > 0) flags.push([`✎${g.dirty}`, tokens.warn]);
  else if (g.dirty === 0) flags.push(["✓", tokens.success]);
  if (g.ahead) flags.push([`↑${g.ahead}`, tokens.info]);
  if (g.behind) flags.push([`↓${g.behind}`, tokens.error]);
  const flagW = flags.reduce((a, [t]) => a + t.length + 1, 0);
  // -1 more so a truncated branch never abuts its flag ("…✎4" reads as one token).
  const branchW = Math.max(4, width - 2 - flagW - ages.length - 3);

  return (
    <box
      flexDirection="column"
      height={2}
      backgroundColor={cursor ? C.bgHighlight : undefined}
    >
      <text>
        <span fg={g.current ? tokens.success : tokens.trace}>{g.current ? "▶ " : "  "}</span>
        <span fg={nameColor} attributes={cursor ? A.bold : undefined}>
          {padTo(truncate(g.name, nameW), nameW)}
        </span>
        <span fg={g.activeNow ? tokens.success : tokens.trace}>{g.activeNow ? "● " : "  "}</span>
        <span fg={cursor ? tokens.text : tokens.subtle}>
          {padStartTo(String(count), COUNT_W - 2)}
        </span>
      </text>
      <text>
        <span fg={tokens.trace}>{"  ⎇ "}</span>
        <span fg={g.live ? tokens.info : tokens.dead}>
          {`${padTo(truncate(g.branch ?? (g.live ? "detached" : "—"), branchW), branchW)} `}
        </span>
        {flags.map(([t, c]) => (
          <span key={t} fg={c}>{`${t} `}</span>
        ))}
        <span fg={tokens.trace}>{ages}</span>
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
   * Whether machine-driven sessions are listed. OFF by default: 95% of transcripts here
   * are `sdk-cli` (claudish's own team members, MCP channel children, `-p` runs, e2e
   * tests), and none of them is a conversation anyone resumes. `a` reveals them.
   */
  const [showAgents, setShowAgents] = useState(false);
  // Re-render tick. Hydration mutates rows in place (they are shared with the caller),
  // so there is no new object for React to diff against — the counter is what tells it
  // the rows it already holds now say more than they did.
  const [, setTick] = useState(0);

  /** A group's sessions after the agent filter — the set every count and list uses. */
  const listed = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const g of groups) {
      m.set(g.name, showAgents ? g.sessions : g.sessions.filter((s) => !isAgentSession(s)));
    }
    return m;
  }, [groups, showAgents]);

  const hiddenCount = useMemo(
    () => (showAgents ? 0 : groups.reduce((a, g) => a + g.sessions.filter(isAgentSession).length, 0)),
    [groups, showAgents]
  );

  const visibleGroups = useMemo(() => {
    // A worktree with nothing left to show after filtering is not worth a row.
    const withSessions = groups.filter((g) => (listed.get(g.name)?.length ?? 0) > 0);
    return filter ? withSessions.filter((g) => fuzzy(filter, g.name)) : withSessions;
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

  const selected = sessions[Math.min(sessCursor, sessions.length - 1)];

  // Hydrate what is on screen, never the whole corpus. Each call is two bounded reads
  // and returns immediately once a row is done, so this stays cheap on every keystroke.
  const listRows = Math.max(3, height - PREVIEW_H - 4);
  useEffect(() => {
    const start = Math.max(0, Math.min(sessCursor - 2, sessions.length - listRows));
    for (const s of sessions.slice(start, start + listRows + 2)) hydrateSession(s);
    if (selected) hydrateSession(selected);
    setTick((t) => t + 1);
  }, [sessions, sessCursor, listRows, selected]);

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
        setSessCursor((c) => clamp(c + d, sessions.length));
      }
      return;
    }
    // `a` is the one letter the filter does not get, because a toggle the user cannot
    // find is the same as no toggle. The footer advertises it.
    if (name === "a" && !key.ctrl && !key.meta) {
      setShowAgents((v) => !v);
      setWtCursor(0);
      setSessCursor(0);
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
  const previewInner = bodyW - PANEL_CHROME;

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
              {visibleGroups.map((g, i) => (
                <WorktreeRow
                  key={g.name}
                  g={g}
                  cursor={i === wtCursor}
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
              {sessions.length === 0 ? (
                <text fg={tokens.subtle}>no sessions match</text>
              ) : (
                sessions.map((s, i) => {
                  const cur = i === sessCursor && pane === "sessions";
                  const live = isActive(s);
                  // size meter (12) + age (5) + gaps (3) reserved out of the row.
                  const labelW = Math.max(10, sessInner - 12 - 5 - 4);
                  return (
                    <box
                      key={s.id}
                      height={1}
                      flexDirection="row"
                      backgroundColor={cur ? C.bgHighlight : undefined}
                    >
                      <text>
                        <span fg={live ? tokens.success : tokens.dead}>{live ? "● " : "· "}</span>
                        <span fg={cur ? tokens.text : tokens.subtle}>
                          {padTo(truncate(sessionLabel(s), labelW), labelW)}
                        </span>
                        <span> </span>
                      </text>
                      <Meter
                        pct={(s.sizeBytes / maxSize) * 100}
                        width={12}
                        ramp={ramps.temperature}
                      />
                      <text>
                        <span fg={tokens.subtle}>{padStartTo(age(s.mtimeMs), 5)}</span>
                      </text>
                    </box>
                  );
                })
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
        <text fg={showAgents ? tokens.warn : tokens.subtle}>
          {showAgents ? `a hide ${hiddenCount || ""}agent` : `a show ${hiddenCount} agent`}
        </text>
        <text fg={tokens.subtle}>esc cancel</text>
      </box>
    </box>
  );
}

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
  const series = group ? activitySeries(group.sessions) : [];
  return (
    <box flexDirection="column">
      <text>
        <span fg={tokens.text} attributes={1}>
          {truncate(sessionLabel(row), width)}
        </span>
      </text>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={tokens.subtle}>{padTo("id", 8)}</text>
        <text fg={tokens.info}>{row.id}</text>
      </box>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={tokens.subtle}>{padTo("branch", 8)}</text>
        <text fg={tokens.text}>{truncate(row.gitBranch || "—", 28)}</text>
        <text fg={tokens.subtle}>last msg</text>
        <text fg={tokens.text}>
          {row.lastMessageChars === undefined ? "—" : `${row.lastMessageChars} ch`}
        </text>
      </box>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={tokens.subtle}>{padTo("size", 8)}</text>
        <Meter pct={(row.sizeBytes / maxSize) * 100} width={20} ramp={ramps.temperature} />
        <text fg={tokens.text}>{`${mb.toFixed(mb >= 10 ? 0 : 1)} MB`}</text>
      </box>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={tokens.subtle}>{padTo("14d", 8)}</text>
        <Sparkline values={series} fg={tokens.info} />
        <text fg={tokens.subtle}>{`${groupCount} session${groupCount === 1 ? "" : "s"} here`}</text>
      </box>
      <text fg={tokens.subtle}>{truncate(row.firstPrompt || "", width)}</text>
    </box>
  );
}
