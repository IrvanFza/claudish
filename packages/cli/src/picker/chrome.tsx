/** @jsxImportSource @opentui/react */
/**
 * picker/chrome.tsx — the four one-row strips that frame the picker: header, load
 * bar, filter and footer.
 *
 * THEY ARE IN ONE FILE BECAUSE THEY SHARE ONE BUDGET. Every row spent here is a
 * model row the list does not get, and at 80×24 the whole chrome allowance is six
 * rows. Keeping them together is what makes that total visible to the next reader
 * instead of scattered across four files that each look cheap.
 *
 * NONE OF THEM IS A `Panel`. A bordered panel spends two rows of chrome to present
 * one row of content, which is a 200% overhead on a 24-row terminal; the filter strip
 * in particular is a caret and a count. Borders are for the two list panes, which
 * have content worth framing.
 */

import type { ReactNode } from "react";
import { LoadingRow } from "../tui/components/LoadingRow.js";
import { A, C } from "../tui/theme.js";
import { displayWidth, padStartTo, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { VERSION } from "../version.js";

/**
 * Two rows above 30 terminal rows, one below — the `CHROME.headerTwoRows` gate.
 *
 * The second row is OpenTUI's own self-sizing horizontal rule: a `flexGrow={1}` box
 * with `border={["top"]}`, which needs no width arithmetic at all and re-sizes itself
 * on resize (`TabBar.tsx:50-56` uses the same idiom). It is dim, because rule 6 is
 * dim the chrome and saturate the signal, and a separator is the purest chrome there
 * is.
 *
 * The wordmark is NOT drawn here. `printLogo` already wrote it to the primary screen
 * before this renderer opened, and the picker runs on the alternate screen — so those
 * nine rows come back for free and re-drawing them would spend the gain twice.
 */
export function PickerHeader({
  right,
  twoRows,
}: {
  /** The context line's right-hand group — counts, never a verdict. */
  right: string;
  twoRows: boolean;
}): ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" height={1} paddingX={1}>
        <text>
          <span fg={tokens.accent} attributes={A.bold}>
            claudish
          </span>
          <span fg={tokens.subtle}> select a model</span>
        </text>
        <text>
          <span fg={tokens.trace}>{`v${VERSION} · `}</span>
          <span fg={tokens.subtle}>{right}</span>
        </text>
      </box>
      {twoRows ? (
        <box flexDirection="row" height={1} paddingX={1}>
          <box flexGrow={1} border={["top"]} borderStyle="single" borderColor={tokens.border} />
        </box>
      ) : null}
    </box>
  );
}

/** One in-flight task, as the load bar draws it. */
export interface LoadTask {
  /** Stable identity — also the React key. */
  id: string;
  label: string;
  /** 0–100 for a determinate meter; omit for a shimmer. Never an invented denominator. */
  pct?: number;
  /** The figure between bar and label: `17/31`, `2.1s / 5.0s deadline`. */
  value?: string;
  width?: number;
}

/**
 * The load bar — present ONLY while something is in flight, and absent (not empty)
 * otherwise, because an empty flex item still eats a row.
 *
 * Each task draws itself at the honesty its caller can actually support
 * (`LoadingRow`'s own doc table): a determinate meter where work is countable, a
 * travelling shimmer where nothing is, and a labelled elapsed figure where only a
 * deadline is known. Nothing here invents a denominator.
 */
export function LoadBar({
  tasks,
  frame,
  width,
}: { tasks: LoadTask[]; frame: number; width: number }): ReactNode {
  if (tasks.length === 0) return null;
  // THE ROW IS ONE ROW WHATEVER IS IN FLIGHT, so the tasks share its columns instead of
  // overflowing it. MEASURED at 80 columns with all three up: the third task's bar
  // painted and its LABEL was clipped away entirely — the worst possible truncation,
  // because an unexplained bar is exactly the affordance this feature replaced. Each
  // task now takes an equal slice, its meter shrinks toward the 4-cell floor before its
  // label does, and the label ellipsises rather than vanishing.
  const gaps = 2 * (tasks.length - 1);
  const per = Math.max(12, Math.floor((width - 2 - gaps) / tasks.length));
  return (
    <box flexDirection="row" height={1} paddingX={1} gap={2} flexShrink={0}>
      {tasks.map((t) => {
        const value = t.value ?? "";
        const bar = Math.max(4, Math.min(t.width ?? 12, per - displayWidth(value) - 8));
        const label = truncate(t.label, Math.max(3, per - bar - displayWidth(value) - 2));
        return (
          <LoadingRow
            key={t.id}
            label={label}
            frame={frame}
            width={bar}
            {...(t.pct === undefined ? {} : { pct: t.pct })}
            {...(t.value === undefined ? {} : { value })}
          />
        );
      })}
    </box>
  );
}

/**
 * The filter strip: what is typed, and how much it left.
 *
 * `▍` is the caret (`resume-picker.tsx:1002`'s glyph), shown only while the strip
 * owns the keyboard — a caret on an inactive field claims focus it does not have.
 * The match count is right-aligned with `padStartTo` so it cannot jitter as the
 * number of digits changes.
 */
export function FilterStrip({
  value,
  active,
  matches,
  total,
  width,
  prompt = "filter",
}: {
  value: string;
  active: boolean;
  matches: number;
  total: number;
  width: number;
  /** `filter` or `provider@model` — the same strip serves the custom-spec hatch. */
  prompt?: string;
}): ReactNode {
  const count = `${matches} / ${total}`;
  const room = Math.max(1, width - prompt.length - count.length - 6);
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} paddingX={1} flexShrink={0}>
      <text>
        <span fg={active ? tokens.accent : tokens.trace}>{`${prompt} `}</span>
        <span fg={value ? tokens.text : tokens.trace}>
          {value ? truncate(value, room) : active ? "" : "—"}
        </span>
        {active ? <span fg={tokens.accent}>▍</span> : null}
      </text>
      <text>
        {/* Warn only when a list EXISTS and the filter emptied it. `0 / 0` while the
            list is still loading is not a warning, and painting it as one teaches the
            reader to discount the colour everywhere else. */}
        <span fg={matches === 0 && total > 0 ? tokens.warn : tokens.subtle}>
          {padStartTo(count, count.length)}
        </span>
      </text>
    </box>
  );
}

/** One footer hint: the key, then what it does. */
interface Hint {
  key: string;
  label: string;
  /** Dimmed when the action is currently unavailable — shown, never hidden. */
  on?: boolean;
}

/**
 * Keyboard hints as two-tone chips — the `Footer.tsx:179-198` idiom, where the
 * colour slot is deliberately ignored and emphasis is BRIGHTNESS rather than hue.
 * Hue is spent on severity everywhere else in this program; spending it here too
 * would make the footer compete with the banner.
 *
 * Every action is one key and every key is listed. No deep menus, nothing
 * discoverable only by trying it.
 */
export function PickerFooter({ hints }: { hints: Hint[] }): ReactNode {
  return (
    <box flexDirection="row" height={1} paddingX={1} gap={2} flexShrink={0}>
      {hints.map((h) => (
        <text key={h.key}>
          <span fg={h.on === false ? tokens.trace : C.strong} attributes={A.boldIf(h.on !== false)}>
            {h.key}
          </span>
          <span fg={h.on === false ? tokens.trace : tokens.subtle}>{` ${h.label}`}</span>
        </text>
      ))}
    </box>
  );
}
