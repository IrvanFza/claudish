/** @jsxImportSource @opentui/react */
/**
 * picker/rows.tsx — one model row, one provider row, one column header, and the
 * pure label arithmetic behind them.
 *
 * ALIGNED TEXT AND CHIPS. NO METERS, NO GRADIENTS. The build this replaces drew a
 * context meter and a price meter on every row, and the reason it had to is written
 * down: a whole-frame graphics-density gate counts a list row carrying a bar as a
 * graphics row, so on a screen whose content IS a list there is no way to pass it
 * without decorating every row. The result was measured — of 32 visible rows, 19
 * read `1M`, and their bars were indistinguishable. Two full columns of gradient
 * encoding one repeated value, beside the numerals that already said it. A CHIP IS
 * NOT A METER: it draws no magnitude and takes `displayWidth(label) + 2` cells, so
 * it costs the row nothing a padded word did not already cost.
 *
 * A meter belongs where a bounded value VARIES and where a reader is comparing
 * magnitudes rather than reading names. In this file there is exactly one such
 * place and it is not here — it is the loading dialog, where `done/total` is real
 * progress over countable work.
 *
 * THE PROVIDER COLUMN IS FIRST, AND IT IS A NAME. It used to be last-but-three and
 * printed the routing shortcut (`or@`, `oai@`, `cx@`); the owner's question on a
 * live run was *"what is 'or' means"*. A shortcut only reads as information to
 * someone who already knows it, so it teaches nothing about a screen whose whole
 * job is to say what is on offer. The column now prints the provider's readable
 * display name, sourced from the provider definitions through
 * `PickerProviderChoice.label` — never a name table here — and it leads the row,
 * because "which provider" is the question the user asked first. The shortcut is
 * not lost: it sits beside the full name in the `p` dialog, and inside the exact
 * `provider@model` spec on the detail line.
 *
 * A FILL IS FOR THE NOTABLE STATE, NOT FOR EVERY ROW — THE RULE THAT SHIPPED
 * BACKWARDS ONCE. A previous pass chipped the routing prefix and the billing mode on
 * EVERY provider row. Both columns then had a fill on all 17 rows, and with no blank
 * row between them the fills fused: the prefix column read as one solid grey vertical
 * band and the billing column as one solid green one, with the labels floating inside
 * them. That is the failure `widgets.tsx` already measured for 24 `UP` chips, and
 * correct padding does not prevent it — padding is not what makes the fills identical.
 * `ScopeTabs.tsx` in claudeup states the surviving rule: the ACTIVE tab is a filled
 * block, the inactive one is plain muted text with no background at all.
 *
 *   `or@` / `zengo@`  subtle TEXT             a routing IDENTIFIER, never a status
 *   `$`               subtle TEXT             metered — information, not a warning
 *   `FREE` / `SUB`    chip on `C.pillKeyBg`   no per-token charge — the SAME claim
 *   `local`           chip on `C.pillKeyBg`   no charge either, by another mechanism
 *   `catalog`         warn text               NOT the live roster — `DiscoveryNotice`
 *   `N/A`             dead text               the catalog does not say
 *   selection         accent + `C.bgHighlight`, and a `▶` so it survives greyscale
 *
 * THE PREFIX AND `$` ARE THE TWO THAT LOST THEIR FILL, and the reason is the same
 * for both: a column whose EVERY row carries the token cannot use a fill to mark it.
 * Every provider has a prefix, and `$` plus `SUB`/`local` partition the roster, so a
 * fill on the metered half plus a fill on the flat-rate half is a fill on all of it.
 * Leaving `$` as muted text makes `SUB` alternate down the column, which is what
 * stops it banding and is also the honest reading: metered is the default state.
 *
 * `SUB` WAS `tokens.warn` UNTIL THIS PASS, AND THAT WAS A ONE-COLOUR-ONE-MEANING
 * VIOLATION IN THE SHIPPED BUILD, not in a prototype. `warn` is `C.orange` —
 * `#ff8800` on dark and a rust `#c2410c` on light — which is the hue this app
 * spends on failure. `SUB` is the opposite of a failure: it is the route the user
 * already pays for, free at the point of use. Red now means only failure here: the
 * `HTTP 4xx` badge and the discovery-failure panel, and nothing else.
 *
 * THREE CHIPS THAT LOOK THE SAME MEAN THE SAME THING. `FREE`, `SUB` and `local` share
 * one positive fill on purpose — all three say "running this costs you no per-token
 * money" — and the LABEL says by which mechanism. Splitting the hue would put three
 * meanings on one claim, which is rule 1 read backwards.
 *
 * A CHIP MARKS A TOKEN THAT VARIES DOWN ITS COLUMN. The price column varies in the
 * cross-provider list and inside a METERED provider (numerals, with the odd
 * `FREE`); inside a flat-rate or local provider every row carries the same word,
 * and identical fills stacked with no gap between rows is the failure the skill
 * MEASURED — 24 `UP` chips fusing into one solid rectangle with the labels floating
 * in it. There the word is drawn as coloured text instead. `chip` is that one
 * decision, taken by the caller that knows the scope.
 *
 * In particular the price NUMERAL is never colour-coded: a value takes discrete
 * buckets or nothing at all, and three buckets of dollars would put a third
 * meaning on `success` in a column already carrying `FREE`.
 *
 * ONE `<text>` PER ROW, ALWAYS. Yoga claws columns back from the LAST `<text>`
 * child of a row, which is how a branch name once rendered as `mai` with thirty
 * free columns beside it (`resume-picker.tsx:473-484`). So every cell is a
 * `<span>` inside a single text node.
 *
 * COLOUR IS READ AT RENDER TIME, never captured in a module-level `const`:
 * `C`/`tokens` are reassigned in place when the terminal theme is detected, and a
 * snapshot taken at import would ship the dark palette to a light terminal. That
 * bug has been found six times in this repo, once visible only in a live
 * screenshot.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { A, C } from "../tui/theme.js";
import { displayWidth, padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { BadgeSpan } from "../tui/viz/widgets.js";
import type { BillingMode } from "./PickerDataSource.js";
import { GAPS, type RowLayout, deriveProviderRowLayout } from "./layout.js";

/** Readiness, in `ProvidersContent.tsx:225`'s exact vocabulary. */
export type Readiness = "pending" | "ready" | "missing";

/** Where a list came from — the one value that drives every provenance encoding. */
export type ListOrigin = "roster" | "catalog";

/**
 * What the price column prints.
 *
 * `resolveProviderDisplayPrice` is the ONE function allowed to decide what a row
 * costs (its `isSubscriptionProvider`-first rule is test-pinned) and it answers a
 * display string, so this only ever RESHAPES that answer — it never recomputes it.
 * Two reshapes, both to buy columns back for the model name: the `/1M` suffix goes
 * because the column header says `$/1M` once for the whole list, and `LOCAL`
 * becomes `local` because a local model has no price at all and shouting is for
 * things that cost money.
 */
export function priceLabel(display: string, billing: BillingMode): string {
  if (billing === "local") return "local";
  const s = (display || "N/A").trim();
  if (s === "LOCAL") return "local";
  if (s === "SUB" || s === "FREE" || s === "N/A") return s;
  return s.replace(/\s*\/\s*1M$/i, "");
}

/**
 * The FILL a discrete price token is chipped on, or `null` for a value rather
 * than a token.
 *
 * A NEON FOREGROUND IS NOT A FILL. `tokens.success` is `C.green`, `#39ff14`, and
 * the skill is explicit that a colour tuned to read as text is harsh as a solid
 * block. `C.pillKeyBg` (`#15803d`) is this repo's already contrast-tuned muted
 * green, shared verbatim by both palettes and measured against BOTH reference pages
 * (`theme-contrast.test.ts`) — and it is ALREADY the `FREE` chip on the session
 * summary card (`session-summary.ts:176`), so this is the same object, not a second
 * invention.
 */
export function priceChipBg(label: string): string | null {
  if (label === "FREE" || label === "SUB" || label === "local") return C.pillKeyBg;
  return null;
}

/** The one colour each price label is allowed to have when it is NOT chipped. */
export function priceFg(label: string): string {
  // `FREE`, `SUB` and `local` make the same claim — no per-token charge — so they
  // take the same positive tier. NEVER `tokens.warn`; see the file header.
  if (label === "FREE" || label === "SUB" || label === "local") return tokens.success;
  if (label === "N/A") return tokens.dead;
  return tokens.text;
}

/**
 * Does the price column VARY in this view, and so earn chips?
 *
 * `null` is the cross-provider list. A scoped provider FIXES the column when it
 * bills flat-rate or runs locally — `resolveProviderDisplayPrice` answers `SUB` for
 * every row of a subscription roster — and a column of one repeated fill is the
 * rectangle the skill measured.
 */
export function priceVaries(scopeBilling: BillingMode | null): boolean {
  return scopeBilling === null || scopeBilling === "metered";
}

/**
 * `●` ready · `○` needs a key · `◌` probe in flight — `ProvidersContent.tsx:225`.
 *
 * PENDING IS `running`, NOT `warn`, for the reason `chrome.tsx` already gives for
 * the catalog shimmer: a probe in flight is not a warning, and spending the
 * failure hue on it teaches the reader to discount that hue everywhere else.
 */
export function readinessGlyph(r: Readiness): { glyph: string; fg: string } {
  if (r === "ready") return { glyph: "●", fg: tokens.success };
  if (r === "missing") return { glyph: "○", fg: tokens.dead };
  return { glyph: "◌", fg: tokens.running };
}

/**
 * The provider view's billing token — the vocabulary a model row prices with.
 *
 * `bg === null` MEANS "DRAW ME AS TEXT", and only `$` takes it. Metered is the
 * DEFAULT state of a route: `$` says the route bills per token, which is a fact
 * about it rather than a caution about it, and the number that matters is on the
 * model row. Filling it too would put a fill on every row of the column and fuse
 * the two halves into one band — the defect the file header describes.
 */
export function billingLabel(mode: BillingMode): { text: string; fg: string; bg: string | null } {
  if (mode === "sub") return { text: "SUB", fg: C.ink, bg: C.pillKeyBg };
  if (mode === "local") return { text: "local", fg: C.ink, bg: C.pillKeyBg };
  return { text: "$", fg: tokens.subtle, bg: null };
}

const SPACES = "                                        ";
const gap = (n: number): string => SPACES.slice(0, Math.max(0, n));

/**
 * A chip that has to sit inside a fixed COLUMN, with the padding OUTSIDE the fill.
 *
 * `BadgeSpan` already pads outside (`badgePad`), which is the rule the skill states
 * verbatim and the reason an earlier pass in this file kept reverting chips to
 * coloured text. This adds only what a CELL needs and a chip does not:
 *
 *  · it fits the LABEL to the column before the fill is drawn — `width - 2`,
 *    because the fill is `displayWidth(label) + 2` and a column sized to the label
 *    overflows by exactly those two cells, which Yoga then claws out of a
 *    neighbouring cell (`widgets.tsx` measured a 1-column stub of background under
 *    the next column’s first letter, invisible to `captureCharFrame`);
 *  · it right-aligns by emitting the filler BEFORE the chip, since `badgePad` can
 *    only pad after it;
 *  · and it declines to draw below three columns, where a chip could only ever be
 *    part of a fill.
 */
function ChipCell({
  label,
  bg,
  width,
  align = "left",
}: {
  label: string;
  bg: string;
  width: number;
  align?: "left" | "right";
}): ReactNode {
  const cells = Math.max(0, Math.floor(width));
  if (cells < 3 || label === "") return cells > 0 ? <span>{gap(cells)}</span> : null;
  const fitted = truncate(label, cells - 2);
  const lead = align === "right" ? Math.max(0, cells - displayWidth(fitted) - 2) : 0;
  return (
    <>
      {lead > 0 ? <span>{gap(lead)}</span> : null}
      {/* `fg={C.ink}` — WHITE, not `pickInk`'s answer. We chose this fill, so we own
          both sides of it and its ink should not change with the user's palette:
          MEASURED on `#15803d`, `pickInk` returns white on the dark palette and
          BLACK on the light one, which is the same chip wearing two inks and the
          worse ratio (4.02 vs 5.02) on the page more likely to be squinted at. */}
      <BadgeSpan
        label={fitted}
        bg={bg}
        fg={C.ink}
        {...(align === "right" ? {} : { width: cells })}
      />
    </>
  );
}

/**
 * The same CELL, drawn as plain coloured text — the form a column uses when every
 * row would otherwise carry a fill.
 *
 * The label is indented by one so it lands under a chip's first letter rather than
 * under the chip's own padding, which is what keeps `$` aligned with `SUB` in the
 * column above and below it.
 */
function TextCell({ label, fg, width }: { label: string; fg: string; width: number }): ReactNode {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return null;
  return <span fg={fg}>{padTo(truncate(` ${label}`, cells), cells)}</span>;
}

/**
 * The column header. It exists so the four fixed cells are NAMED rather than
 * guessed at, which is the cheapest possible answer to "what is happening here":
 * the previous build printed `262K` and `$30.00/1M` beside two unlabelled bars.
 */
export function ColumnHeader({ layout }: { layout: RowLayout }): ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.trace}>{"  "}</span>
        {/* THE HEADER FOLLOWS THE LAYOUT, it never re-decides it. `provider === 0`
            is the scoped view, where the dialog title already names the provider —
            a header cell for a column with no cells under it would be a label
            pointing at nothing, and the gutter would indent every id by two. */}
        {layout.provider > 0 ? (
          <>
            <span fg={tokens.trace}>{padTo("provider", layout.provider)}</span>
            <span>{gap(GAPS.afterProvider)}</span>
          </>
        ) : null}
        <span fg={tokens.trace}>{padTo("model", layout.id)}</span>
        <span>{gap(GAPS.afterId)}</span>
        <span fg={tokens.trace}>{padStartTo("ctx", layout.ctx)}</span>
        <span>{gap(GAPS.afterCtx)}</span>
        <span fg={tokens.trace}>{padStartTo("$/1M", layout.price)}</span>
        {layout.mark > 0 ? <span fg={tokens.trace}>{padStartTo("", layout.mark)}</span> : null}
      </text>
    </box>
  );
}

export interface ModelRowProps {
  model: ModelInfo;
  /**
   * The provider's READABLE display name, already fitted to `layout.provider` and
   * guaranteed distinct from every other provider on screen (`providerColumn`).
   *
   * It replaced the routing shortcut — `or@`, `oai@`, `cx@` — because the owner
   * asked, verbatim, *"what is 'or' means"*. A shortcut is information only to
   * someone who already knows it. The shortcut still exists where it explains
   * itself: beside the full name in the `p` dialog, and inside the exact spec on
   * the detail line under this list.
   */
  providerLabel: string;
  /** Whatever `resolveProviderDisplayPrice` said, already reshaped by `priceLabel`. */
  price: string;
  layout: RowLayout;
  cursor: boolean;
  /** `catalog` marks a row that is NOT from the provider's live roster. */
  origin: ListOrigin;
  /**
   * Draw a discrete price label as a CHIP rather than as coloured text.
   *
   * The caller decides because only the caller knows the scope — see `priceVaries`
   * and the file header. Default `false`: a chip is the exception a view opts into,
   * so a new call site cannot accidentally paint a rectangle.
   */
  chip?: boolean;
}

export function ModelRow({
  model,
  providerLabel,
  price,
  layout,
  cursor,
  origin,
  chip = false,
}: ModelRowProps): ReactNode {
  // Render-time reads — see the file header.
  const idFg = cursor ? C.strong : tokens.text;
  const chipBg = chip ? priceChipBg(price) : null;
  return (
    // THE WASH LIVES ON THE BOX, not on the `<text>`: a text node is only as wide
    // as its content, so a row highlighted that way stops at its last glyph and
    // reads as a floating chip rather than as a bar. `height={1}` keeps a row from
    // overprinting its neighbour.
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        {/* DROPPED ENTIRELY INSIDE A PROVIDER, not blanked. `OpenAI Codex` printed
            49 times under a dialog titled `OpenAI Codex` is the column with the
            least information on the screen, and it was eating the cells the model
            id wants. It is the whole point of the cross-provider list, so it stays
            there — one flag, one layout, no second row component. */}
        {layout.provider > 0 ? (
          <>
            <span fg={cursor ? C.strong : tokens.subtle}>
              {padTo(truncate(providerLabel, layout.provider), layout.provider)}
            </span>
            <span>{gap(GAPS.afterProvider)}</span>
          </>
        ) : null}
        <span fg={idFg}>{padTo(model.id, layout.id)}</span>
        <span>{gap(GAPS.afterId)}</span>
        <span fg={tokens.subtle}>{padStartTo(model.context || "N/A", layout.ctx)}</span>
        <span>{gap(GAPS.afterCtx)}</span>
        {chipBg === null ? (
          <span fg={priceFg(price)}>{padStartTo(price, layout.price)}</span>
        ) : (
          <ChipCell label={price} bg={chipBg} width={layout.price} align="right" />
        )}
        {layout.mark > 0 ? (
          <span fg={tokens.warn}>
            {padStartTo(origin === "catalog" ? "catalog" : "", layout.mark)}
          </span>
        ) : null}
      </text>
    </box>
  );
}

export interface ProviderRowProps {
  label: string;
  shortcut: string;
  readiness: Readiness;
  billing: BillingMode;
  /**
   * How many models this provider offers, or `null` for "not known yet".
   *
   * `null` PRINTS NOTHING — not `0`, not `—`, not a guess. The owner's rule,
   * verbatim: *"we could not show number of models for some of them"*. This
   * column is now only filled for a provider whose roster the user has already
   * opened, or whose count is already in hand from a catalog the user asked for;
   * everything else is silent, because a wrong count is worse than no count and
   * an em dash still occupies the place where a number goes.
   */
  count: number | null;
  /** Does this provider list its own roster? Decides what a known `0` means. */
  hasDiscovery: boolean;
  /** Why it is not selectable — an env var name, or empty. */
  note: string;
  cursor: boolean;
  /** Usable content columns. */
  inner: number;
}

/**
 * One provider, in the list the picker now OPENS ON.
 *
 * IT IS THE DEFAULT SCREEN, NOT A DETOUR. The build this replaces landed on a flat
 * 574-row cross-provider list and reached the providers through `p`; the owner's
 * verdict was *"we should not show the full list of models, we should show a list
 * of providers by default and only when we go inside we load and resolve all
 * models"*. So this row is the first thing the picker draws, and entering one is
 * what makes that provider's roster be fetched at all.
 *
 * IT IS A DIALOG, NOT A RAIL. The rejected build put a 19-column provider rail
 * permanently beside the model list, which gave the screen two cursors with only a
 * border colour to say which one the arrow keys drove — "super unclear what is
 * happening", precisely described. It also truncated two different providers to
 * the same `opencod…`. At full dialog width the names are whole, and only one list
 * is ever on screen.
 */
export function ProviderRow({
  label,
  shortcut,
  readiness,
  billing,
  count,
  hasDiscovery,
  note,
  cursor,
  inner,
}: ProviderRowProps): ReactNode {
  const { glyph, fg } = readinessGlyph(readiness);
  const bill = billingLabel(billing);
  const L = deriveProviderRowLayout(inner);
  // `0 models` IS A DIFFERENT CLAIM FOR A DISCOVERY PROVIDER, and printing it there
  // would be the original defect in miniature: Devin and Antigravity carry no catalog
  // entries by design and ask their own endpoint for a roster the moment you scope to
  // them, so "0 models" reads as "this provider has nothing" about a provider that
  // has not been asked yet.
  const countText =
    count === null
      ? ""
      : count === 0 && hasDiscovery
        ? "asks its own roster"
        : `${count} model${count === 1 ? "" : "s"}`;
  const tail = readiness === "missing" && note !== "" ? note : countText;
  return (
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        <span fg={fg}>{padTo(glyph, L.glyph)}</span>
        <span fg={cursor ? C.strong : tokens.text}>{padTo(truncate(label, L.name), L.name)}</span>
        <span>{gap(L.gaps)}</span>
        {/* THE PREFIX IS AN IDENTIFIER AND EVERY ROW HAS ONE, so it is the muted
            hue AS TEXT. Chipped, it put a fill on all 17 rows of a column with no
            gap between them and the column fused into one grey band — the owner's
            word was "super ugly". A fill marks the notable member of a column; here
            there is no notable member, only a name. */}
        <span fg={tokens.subtle}>{padTo(truncate(shortcut, L.shortcut), L.shortcut)}</span>
        {bill.bg === null ? (
          <TextCell label={bill.text} fg={bill.fg} width={L.billing} />
        ) : (
          <ChipCell label={bill.text} bg={bill.bg} width={L.billing} />
        )}
        <span fg={readiness === "missing" ? tokens.dead : tokens.subtle}>
          {padStartTo(truncate(tail, L.tail), L.tail)}
        </span>
      </text>
    </box>
  );
}

/**
 * A dim, NON-SELECTABLE row for something a list is deliberately not showing.
 *
 * An unexplained absence is the defect class this whole feature is about, so the
 * number is said out loud. It stays unselectable because a row that cannot be
 * picked must not look like one that can: offering it would trade a silent absence
 * for a dead end.
 */
export function HintRow({ text, width }: { text: string; width: number }): ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.trace}>{truncate(`  ${text}`, width)}</span>
      </text>
    </box>
  );
}
