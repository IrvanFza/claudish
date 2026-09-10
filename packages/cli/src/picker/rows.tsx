/** @jsxImportSource @opentui/react */
/**
 * picker/rows.tsx — one model row, one provider row, one column header, and the
 * pure label arithmetic behind them.
 *
 * PLAIN ALIGNED TEXT. NO METERS, NO GRADIENTS, NO PER-ROW CHIPS. The build this
 * replaces drew a context meter and a price meter on every row, and the reason it
 * had to is written down: a whole-frame graphics-density gate counts a list row
 * carrying a bar as a graphics row, so on a screen whose content IS a list there is
 * no way to pass it without decorating every row. The result was measured — of 32
 * visible rows, 19 read `1M`, and their bars were indistinguishable. Two full
 * columns of gradient encoding one repeated value, beside the numerals that already
 * said it.
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
 * COLOUR ENCODES MEANING, ONE MEANING EACH, APP-WIDE:
 *
 *   `FREE`     success   costs nothing
 *   `SUB`      warn      a flat-rate plan, so no per-token number exists
 *   `local`    trace     runs on this machine
 *   `catalog`  warn      NOT this provider's live roster — see `DiscoveryNotice`
 *   `N/A`      dead      the catalog does not say
 *   selection  accent + `C.bgHighlight`, and a `▶` so it survives greyscale
 *
 * Anything else is body ink. In particular the price NUMERAL is not colour-coded:
 * a value takes discrete buckets or nothing at all, and three buckets of dollars
 * would put a third meaning on `success` in a column already carrying `FREE`.
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
import { padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import type { BillingMode } from "./PickerDataSource.js";
import { GAPS, type RowLayout } from "./layout.js";

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

/** The one colour each price label is allowed to have. */
export function priceFg(label: string): string {
  if (label === "FREE") return tokens.success;
  if (label === "SUB") return tokens.warn;
  if (label === "local") return tokens.trace;
  if (label === "N/A") return tokens.dead;
  return tokens.text;
}

/** `●` ready · `○` needs a key · `◌` probe in flight — `ProvidersContent.tsx:225`. */
export function readinessGlyph(r: Readiness): { glyph: string; fg: string } {
  if (r === "ready") return { glyph: "●", fg: tokens.success };
  if (r === "missing") return { glyph: "○", fg: tokens.dead };
  return { glyph: "◌", fg: tokens.warn };
}

/** The provider view's billing word, in the same colours a model row uses. */
export function billingLabel(mode: BillingMode): { text: string; fg: string } {
  if (mode === "sub") return { text: "SUB", fg: tokens.warn };
  if (mode === "local") return { text: "local", fg: tokens.trace };
  return { text: "$", fg: tokens.subtle };
}

const SPACES = "                                        ";
const gap = (n: number): string => SPACES.slice(0, Math.max(0, n));

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
        <span fg={tokens.trace}>{padTo("provider", layout.provider)}</span>
        <span>{gap(GAPS.afterProvider)}</span>
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
}

export function ModelRow({
  model,
  providerLabel,
  price,
  layout,
  cursor,
  origin,
}: ModelRowProps): ReactNode {
  // Render-time reads — see the file header.
  const idFg = cursor ? C.strong : tokens.text;
  return (
    // THE WASH LIVES ON THE BOX, not on the `<text>`: a text node is only as wide
    // as its content, so a row highlighted that way stops at its last glyph and
    // reads as a floating chip rather than as a bar. `height={1}` keeps a row from
    // overprinting its neighbour.
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        <span fg={cursor ? C.strong : tokens.subtle}>
          {padTo(truncate(providerLabel, layout.provider), layout.provider)}
        </span>
        <span>{gap(GAPS.afterProvider)}</span>
        <span fg={idFg}>{padTo(model.id, layout.id)}</span>
        <span>{gap(GAPS.afterId)}</span>
        <span fg={tokens.subtle}>{padStartTo(model.context || "N/A", layout.ctx)}</span>
        <span>{gap(GAPS.afterCtx)}</span>
        <span fg={priceFg(price)}>{padStartTo(price, layout.price)}</span>
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
  /** Models this provider serves, or `null` before the catalog has answered. */
  count: number | null;
  /** Does this provider list its own roster? Decides what `0` in the catalog means. */
  hasDiscovery: boolean;
  /** Why it is not selectable — an env var name, or empty. */
  note: string;
  cursor: boolean;
  /** Usable content columns. */
  inner: number;
}

/**
 * One provider, in the `p` dialog.
 *
 * IT IS A DIALOG, NOT A RAIL, and that is the fix for the complaint. The rejected
 * build put a 19-column provider rail permanently beside the model list, which
 * gave the screen two cursors with only a border colour to say which one the arrow
 * keys drove — "super unclear what is happening", precisely described. It also
 * truncated two different providers to the same `opencod…`. At full dialog width
 * the names are whole, and only one list is ever on screen.
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
  // The right-hand cell carries EITHER a count OR the env var a missing provider
  // wants, and the env var is the longer of the two by a wide margin
  // (`MOONSHOT_API_KEY` is 16, `needs ` makes 22). It is sized for the env var,
  // because a truncated variable name is worse than useless — `needs MOON…` sends
  // the reader looking for a variable that does not exist.
  const countCell = 26;
  const shortcutCell = 9;
  const billCell = 6;
  const nameCell = Math.max(6, inner - 2 - 2 - shortcutCell - billCell - countCell - 3);
  // `0 models` IS A DIFFERENT CLAIM FOR A DISCOVERY PROVIDER, and printing it there
  // would be the original defect in miniature: Devin and Antigravity carry no catalog
  // entries by design and ask their own endpoint for a roster the moment you scope to
  // them, so "0 models" reads as "this provider has nothing" about a provider that
  // has not been asked yet.
  const countText =
    count === null
      ? "—"
      : count === 0 && hasDiscovery
        ? "asks its own roster"
        : `${count} model${count === 1 ? "" : "s"}`;
  return (
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        <span fg={fg}>{glyph}</span>
        <span> </span>
        <span fg={cursor ? C.strong : tokens.text}>{padTo(label, nameCell)}</span>
        <span> </span>
        <span fg={tokens.subtle}>{padTo(shortcut, shortcutCell)}</span>
        <span fg={bill.fg}>{padTo(bill.text, billCell)}</span>
        <span fg={readiness === "missing" ? tokens.dead : tokens.subtle}>
          {padStartTo(readiness === "missing" && note !== "" ? note : countText, countCell)}
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
