/** @jsxImportSource @opentui/react */
/**
 * picker/chrome.tsx — the dialog frame and the four one-row strips inside it.
 *
 * THEY ARE IN ONE FILE BECAUSE THEY SHARE ONE ROW BUDGET. The dialog is drawn
 * INLINE, in the user's scrollback, so every row it spends is a row of their
 * terminal it consumed and did not give back — a very different economy from a
 * full-screen app, which pays nothing for chrome it draws inside a viewport it has
 * already taken. Seven rows of chrome and eleven of list is the whole allowance
 * (`layout.ts`), and keeping the strips together is what makes that total visible
 * to the next reader instead of scattered across four files that each look cheap.
 *
 * THE DIALOG IS THE ONLY BORDER. The rejected build framed two panels and drew a
 * header strip, a load strip, a filter strip, a stats panel and a footer outside
 * them. One box, one title, one question.
 */

import type { ReactNode } from "react";
import { LoadingRow } from "../tui/components/LoadingRow.js";
import { C } from "../tui/theme.js";
import { displayWidth, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { BadgeSpan } from "../tui/viz/widgets.js";

/**
 * The bordered box, with its title composed left-and-right on the border line.
 *
 * ONE COMPOSED TITLE, NOT TWO ELEMENTS, because OpenTUI's box draws exactly one
 * `title` and there is no second slot. The status half is padded into the same
 * string, which is what produces `╭─ choose a model ──── 312 models · 24/31 ─╮`
 * out of a single prop.
 *
 * IT IS BUDGETED SHORT ON PURPOSE. MEASURED on the previous build: a title that
 * fills its border exactly is DROPPED — the box renders no title at all rather
 * than a clipped one — so the loudest label on the screen silently became an empty
 * border. Six columns of slack, and the status half is truncated before the name
 * half is, because "choose a model" is the thing the dialog is FOR.
 */
export function Dialog({
  title,
  status,
  width,
  marginLeft,
  children,
}: {
  title: string;
  /** The right-hand group — counts, never a verdict. May be empty. */
  status: string;
  width: number;
  marginLeft: number;
  children?: ReactNode;
}): ReactNode {
  return (
    <box
      marginLeft={marginLeft}
      width={width}
      border
      borderStyle="rounded"
      borderColor={tokens.accent}
      backgroundColor={tokens.bgPanel}
      title={composeTitle(title, status, width)}
      titleAlignment="left"
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      {children}
    </box>
  );
}

/**
 * Exported for the width test — the arithmetic, without a renderer.
 *
 * The leading and trailing spaces are NOT decoration: the box draws the title
 * immediately after `╭─`, so without them the border reads `╭─choose a model──`
 * with the words fused to the rule. MEASURED in a frame capture, not guessed.
 */
export function composeTitle(title: string, status: string, width: number): string {
  const room = Math.max(6, Math.floor(width) - 8);
  const left = truncate(title, room);
  if (status === "") return ` ${left} `;
  const right = truncate(status, Math.max(0, room - displayWidth(left) - 3));
  if (right === "") return ` ${left} `;
  const pad = Math.max(1, room - displayWidth(left) - displayWidth(right));
  return ` ${left}${" ".repeat(pad)}${right} `;
}

/**
 * The filter row: what is typed, and what the list is ordered by.
 *
 * FILTER-FIRST, NO SEARCH MODE. Typing narrows the list immediately — the `/`
 * prompt is always drawn and the caret is always live, because a picker's fastest
 * path is a user who already roughly knows what they want typing three letters of
 * it. The previous build made filtering a MODE entered with `/`, which is one more
 * thing the reader has to know before the screen does anything.
 *
 * The right-hand group answers "why is this row at the top" while nothing is
 * typed, and "how much did I just cut" once something is.
 */
export function FilterRow({
  value,
  matches,
  total,
  width,
}: {
  value: string;
  matches: number;
  total: number;
  width: number;
}): ReactNode {
  const right = value === "" ? "newest first" : `${matches} of ${total}`;
  const room = Math.max(1, width - displayWidth(right) - 4);
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
      <text>
        <span fg={tokens.accent}>{"/ "}</span>
        <span fg={tokens.text}>{truncate(value, room)}</span>
        <span fg={tokens.accent}>▍</span>
      </text>
      <text>
        {/* Warn only when a list EXISTS and the filter emptied it. `0 of 0` while
            the list is still loading is not a warning, and painting it as one
            teaches the reader to discount the colour everywhere else. */}
        <span fg={value !== "" && matches === 0 && total > 0 ? tokens.warn : tokens.subtle}>
          {right}
        </span>
      </text>
    </box>
  );
}

/**
 * The rule above the footer — OpenTUI's own self-sizing horizontal line.
 *
 * A `flexGrow={1}` box with `border={["top"]}` needs no width arithmetic at all
 * and re-sizes itself on resize (`TabBar.tsx:50-56` uses the same idiom). Dim,
 * because a separator is the purest chrome there is.
 */
export function Rule(): ReactNode {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <box flexGrow={1} border={["top"]} borderStyle="single" borderColor={tokens.border} />
    </box>
  );
}

/** One footer hint: the key, then what it does. */
export interface Hint {
  key: string;
  label: string;
  /** Dimmed when the action is currently unavailable — shown, never hidden. */
  on?: boolean;
}

/**
 * Keyboard hints as KEYCAPS — a badge per key, then its label in dim text.
 *
 * THE BADGE IS THE HOUSE PATTERN FOR A DISCRETE TOKEN: dark ink on a saturated
 * fill, one space of padding each side (`aesthetics-and-color.md`). Bold white
 * text on the panel background, which is what this row used to be, is the same
 * treatment the model ids two rows above get — so `p` in `p providers` read as a
 * word rather than as a key you press, which is exactly what the owner said when
 * he asked for "better button highlighting".
 *
 * `BadgeSpan`, NOT `Badge`: one `<text>` per hint carries both the chip and its
 * label, and a `<text>` cannot nest in a `<text>`.
 *
 * ONE FILL FOR EVERY KEYCAP, AND IT IS THE ONE THIS PROGRAM ALREADY USES.
 * `C.chipKeyBg` is the config TUI's footer chip (`Footer.tsx:186-190` — neutral
 * grey, `C.fg` ink, bold, one space each side), so the picker's footer is the same
 * object as every other footer in claudish rather than a second invention. It is
 * deliberately NOT a saturated hue: every hue in this dialog already means one
 * thing — `FREE` success, `SUB` warn, `catalog` warn, errors red, focus accent —
 * and borrowing one for the footer would put the quietest row on screen in
 * competition with the failure banner. A keycap reads as a key because of its
 * SHAPE, a filled chip with padding; the fill's job is to be neutral.
 *
 * `pickInk` chooses the ink from the fill rather than hardcoding white, which is
 * what keeps the chip legible in the light palette, where `chipKeyBg` is `#d1d5db`
 * and white ink would vanish.
 *
 * AN UNAVAILABLE ACTION LOSES THE CHIP RATHER THAN BEING HIDDEN — dim text, no
 * fill, so "there is a key here but not now" is visibly different from both a live
 * key and an absent one. Every action is one key and every key is here.
 */
export function Hints({ hints }: { hints: Hint[] }): ReactNode {
  return (
    <box flexDirection="row" height={1} gap={1} flexShrink={0} overflow="hidden">
      {hints.map((h) => (
        <text key={h.key} flexShrink={0}>
          {h.on === false ? (
            <span fg={tokens.trace}>{` ${h.key} `}</span>
          ) : (
            <BadgeSpan label={h.key} bg={C.chipKeyBg} />
          )}
          <span fg={h.on === false ? tokens.trace : tokens.subtle}>{` ${h.label}`}</span>
        </text>
      ))}
    </box>
  );
}

/** One in-flight task, as the loading dialog draws it. */
export interface LoadTask {
  /** Stable identity — also the React key. */
  id: string;
  label: string;
  /** 0–100 for a determinate meter; omit for a shimmer. NEVER an invented denominator. */
  pct?: number;
  /** The figure after the bar: `8/31 checked`, `discovering…  3.2s`. */
  value?: string;
}

/**
 * The loading dialog's body: one named row per operation actually running.
 *
 * THE SHAPE OF EACH ROW IS THE HONESTY CONTRACT, and it is chosen by what the
 * caller can measure, not by what looks busiest:
 *
 *   · The credential sweep has a real denominator — the roster is derived
 *     synchronously, so `done/total` is work done over work TOTAL. It gets the
 *     one determinate meter in the whole picker, and it EARNS it: a bounded value
 *     with real variance over time is the one thing a gradient bar is for.
 *   · The catalog warm races a 5 s wait against an 8 s refresh. Two numbers, so no
 *     single denominator a bar could honestly be drawn against — shimmer.
 *   · A roster discovery gets a deadline bar ONLY on the GET half, whose
 *     `FETCH_TIMEOUT_MS` is published, and the label says `deadline` because a
 *     deadline is not progress. The three fetcher providers publish nothing, so
 *     they get elapsed and a shimmer. Inventing 5 000 ms for Devin would be a
 *     guess rendered as a fact.
 */
export function LoadTasks({
  tasks,
  frame,
  labelWidth,
  barWidth,
}: {
  tasks: LoadTask[];
  frame: number;
  labelWidth: number;
  barWidth: number;
}): ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {tasks.map((t) => (
        <LoadingRow
          key={t.id}
          label={t.label}
          frame={frame}
          width={barWidth}
          labelWidth={labelWidth}
          // `running`, NOT `ShimmerSpan`'s default `warn`. MEASURED in the light
          // palette, where `warn` is `#c2410c` and the catalog shimmer read as a
          // rust-red alarm bar — the one hue this app spends on `SUB` and on an
          // unverified `catalog` row. A fetch in flight is not a warning, and it
          // now matches the determinate meter's blue ramp beside it.
          fg={tokens.running}
          {...(t.pct === undefined ? {} : { pct: t.pct })}
          {...(t.value === undefined ? {} : { value: t.value })}
        />
      ))}
    </box>
  );
}
