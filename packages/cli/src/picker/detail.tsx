/** @jsxImportSource @opentui/react */
/**
 * picker/detail.tsx — the two pinned blocks under the two lists.
 *
 * THEY EXIST FOR PARITY FIRST AND FOR THE SCREENSHOT SECOND. The inquirer picker
 * showed a description under both prompts — `ProviderChoice.description` under the
 * provider list and `ModelInfo.description` under the model list — and a rewrite that
 * silently dropped both would be a regression dressed as a redesign. The model block
 * also answers the one question a picker must never leave open: what EXACTLY does
 * Enter return? It prints the spec verbatim.
 *
 * The screenshot benefit is the same shape as `resume-picker.tsx`'s activity calendar:
 * a scrollbox with fewer rows than viewport leaves the rest of its panel empty, and a
 * pinned, content-sized sibling occupies that space with something worth reading.
 * `flexShrink={0}` is mandatory on both — a scrollbox's intrinsic height is its ENTIRE
 * content, and Yoga spreads that shortfall across every sibling, which collapses an
 * unprotected block to one row and overprints its children.
 *
 * BOTH ARE HEIGHT-GATED BY THEIR CALLER, not here: on a 24-row terminal every row
 * belongs to the list, and a detail block would trade two model rows — two GRAPHICS
 * rows — for two rows of prose, which is exactly the wrong direction for the whole-frame
 * density count.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { A } from "../tui/theme.js";
import { truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";

/**
 * Greedy word wrap to at most `maxLines` rows, with the last row ellipsised.
 *
 * Built on `displayWidth` through `truncate` rather than on `String.length`, because a
 * CJK model description counts double in cells and half in code units — the same reason
 * `padEnd`/`slice` are banned in `viz/text.ts`.
 */
export function wrapWords(text: string, width: number, maxLines: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= w) {
      line = next;
      continue;
    }
    if (line !== "") lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line !== "") lines.push(line);
  return lines.slice(0, maxLines).map((l) => truncate(l, w));
}

/**
 * What Enter will return, and what the model is.
 *
 * The spec is rendered in the accent colour and NOT truncated away: it is the value the
 * user is choosing, and a picker that hides its own return value is asking them to
 * guess.
 */
export function ModelDetail({
  model,
  spec,
  width,
}: {
  model: ModelInfo | null;
  spec: string | null;
  width: number;
}): ReactNode {
  const inner = Math.max(8, Math.floor(width) - 2);
  if (model === null || spec === null) {
    return (
      <box flexDirection="column" flexShrink={0} paddingX={1}>
        <text>
          <span fg={tokens.trace}>nothing selected</span>
        </text>
      </box>
    );
  }
  const date = model.releaseDate ? ` · ${model.releaseDate.slice(0, 7)}` : "";
  const head = `${spec}${date}`;
  const body = model.description ?? "";
  return (
    <box flexDirection="column" flexShrink={0} paddingX={1}>
      <text>
        <span fg={tokens.accent} attributes={A.bold}>
          {truncate(head, inner)}
        </span>
      </text>
      {body === "" ? null : (
        <text>
          <span fg={tokens.subtle}>{truncate(body, inner)}</span>
        </text>
      )}
    </box>
  );
}

/**
 * The selected provider, in the rail's own width.
 *
 * The env var is named even when the provider is ready, because it is the single most
 * useful string when something later goes wrong — a stale value in the shell shadows
 * stored credentials, and "check your API key" gives no clue which name to inspect.
 * That is the same reasoning `formatDiscoveryFailureNotice` gives for naming it in a
 * failure notice; here it is available BEFORE the failure.
 */
export function ProviderDetail({
  label,
  description,
  envVar,
  width,
}: {
  label: string;
  description: string;
  envVar: string;
  width: number;
}): ReactNode {
  const inner = Math.max(6, Math.floor(width) - 2);
  return (
    <box flexDirection="column" flexShrink={0} paddingX={1}>
      <text>
        <span fg={tokens.accent}>{truncate(label, inner)}</span>
      </text>
      {wrapWords(description, inner, 3).map((line) => (
        <text key={line}>
          <span fg={tokens.subtle}>{line}</span>
        </text>
      ))}
      {envVar === "" ? null : (
        <text>
          <span fg={tokens.trace}>{truncate(envVar, inner)}</span>
        </text>
      )}
    </box>
  );
}
