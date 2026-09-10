/** @jsxImportSource @opentui/react */
/**
 * picker/detail.tsx — the one row under the list that says what Enter will do.
 *
 * IT ANSWERS THE QUESTION A PICKER MUST NEVER LEAVE OPEN: what EXACTLY does Enter
 * return? It prints the spec verbatim — `google@gemini-3.8-flash`, the same string
 * `buildExplicitModelSpec` hands the launcher and the same string the user could
 * have typed on argv — so the picker teaches its own CLI instead of hiding behind
 * a private label.
 *
 * ONE ROW, NOT THREE. The previous build pinned a description block under each of
 * its two lists. Descriptions are per-model editorial text that the slim catalog
 * mostly does not carry, and two rows of prose cost two rows of list on a dialog
 * whose whole list is eleven rows. What survives is the three facts that differ
 * between models a reader is choosing BETWEEN: the exact spec, the capabilities,
 * and how old it is.
 *
 * CAPABILITIES ARE EXCEPTION-ONLY AND THEY LIVE HERE, NOT ON EVERY ROW. The
 * previous build printed `[TRV]` on all 21 rows of a roster where every model had
 * all three — a column with no variance, in the place a reader is scanning names.
 * On the selected row they are worth three words; on forty rows they are noise.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { A } from "../tui/theme.js";
import { truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";

/**
 * `tools reasoning vision`, and ONLY the ones the catalog affirmatively says are
 * there.
 *
 * `undefined` is not `false`. The slim catalog carries `supportsTools` for most
 * models and `supportsReasoning` for some, and a missing flag means "the catalog
 * does not say" — printing its absence would be claiming a fact nobody has.
 */
export function capabilityWords(model: ModelInfo): string[] {
  const words: string[] = [];
  if (model.supportsTools === true) words.push("tools");
  if (model.supportsReasoning === true) words.push("reasoning");
  if (model.supportsVision === true) words.push("vision");
  return words;
}

/**
 * The detail line's text, as one pure function so the sentence can be asserted
 * without a renderer.
 *
 * The one exception that is LOUD rather than quiet: a model the catalog says
 * takes no tools cannot drive Claude Code at all, which is disqualifying rather
 * than comparative. It is stated in words on the row the cursor is on, in the
 * error colour, instead of being one dim letter in a column of forty.
 */
export function detailText(spec: string, model: ModelInfo): { text: string; warn: string } {
  const parts = [spec];
  const caps = capabilityWords(model);
  if (caps.length > 0) parts.push(caps.join(" "));
  if (model.releaseDate) parts.push(model.releaseDate.slice(0, 7));
  return {
    text: parts.join(" · "),
    warn: model.supportsTools === false ? "no tool support — Claude Code cannot run it" : "",
  };
}

export function SelectionLine({
  model,
  spec,
  width,
}: {
  model: ModelInfo | null;
  spec: string | null;
  width: number;
}): ReactNode {
  const inner = Math.max(8, Math.floor(width));
  if (model === null || spec === null) {
    return (
      <box height={1} flexShrink={0}>
        <text>
          <span fg={tokens.trace}>nothing selected</span>
        </text>
      </box>
    );
  }
  const { text, warn } = detailText(spec, model);
  const room = warn === "" ? inner : Math.max(8, inner - warn.length - 3);
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.accent} attributes={A.bold}>
          {truncate(text, room)}
        </span>
        {warn === "" ? null : (
          <>
            <span fg={tokens.subtle}>{" · "}</span>
            <span fg={tokens.error}>{warn}</span>
          </>
        )}
      </text>
    </box>
  );
}
