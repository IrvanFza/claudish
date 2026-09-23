import type { ScrollBoxRenderable } from "@opentui/core";
/** @jsxImportSource @opentui/react */
import { useEffect, useRef } from "react";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import { DEFAULT_FALLBACK_PROVIDER } from "../../providers/routing-rules.js";
import { DETAIL_H, getChainProviders } from "../constants.js";
import { deriveProbeOutcome } from "../probe-outcome.js";
import { providerIsReady } from "../providers.js";
import { A, C } from "../theme.js";
import type {
  DroppedOutcome,
  MergedRule,
  Mode,
  ProbeEntry,
  ProbeMode,
  ProbeSummary,
} from "../types.js";

/**
 * What a dropped row says removed it. Total over the dropped outcomes, so a new
 * outcome cannot render as nothing.
 */
const DROPPED_TEXT: Record<DroppedOutcome, string> = {
  "no-credential": "no credential",
  "credential-unreadable": "credential could not be read",
  "not-served": "the account does not serve it",
  "excluded-by-membership": "not in the plan's membership",
};

/**
 * How a probe row's status reads: its glyph, its text, and its colour, read from
 * `C` at render time (the palette changes when the theme is detected).
 */
function rowStatusView(entry: ProbeEntry): { icon: string; color: string; text: string } {
  switch (entry.status) {
    case "unverified":
      return { icon: "◐", color: C.cyan, text: "native — not probed" };
    case "success":
      return {
        icon: "●",
        color: C.green,
        text: entry.ms !== undefined ? `${entry.ms}ms` : "success",
      };
    case "failed":
      return { icon: "✗", color: C.red, text: entry.error ?? "failed" };
    case "testing":
      return { icon: "◌", color: C.yellow, text: "testing..." };
    case "dropped":
      return {
        icon: "○",
        // A subscription the user holds whose key could not be read is a
        // warning: the request lands on a different hop.
        color: entry.outcome === "credential-unreadable" ? C.yellow : C.dim,
        text: entry.outcome ? `dropped · ${DROPPED_TEXT[entry.outcome]}` : "dropped",
      };
    case "skipped":
      return { icon: "·", color: C.dim, text: "not reached" };
    case "no_key":
      return { icon: "○", color: C.dim, text: "not configured, skipping" };
    case "pending":
      return { icon: "○", color: C.dim, text: "waiting" };
  }
}

/** A no-route hint, one line per row; the hint is multi-line text. */
function hintLines(hint: string | undefined): { id: string; text: string }[] {
  if (!hint) return [];
  return hint
    .split("\n")
    .filter((text) => text.trim().length > 0)
    .map((text, n) => ({ id: `hint-${n}`, text }));
}

// Format a chain as inline text: "kimi → openrouter"
function chainStr(chain: string[]): string {
  return chain.join(" → ");
}

/**
 * Reasons shown beneath each probe entry.
 *
 * Exported for the drift test only. A provider missing from here renders its
 * bare uid (`entry.provider`) as its own explanation — which is not an error and
 * not visibly wrong, so the three Alibaba rows would silently read
 * "qwen-token-plan / qwen-coding / qwen-payg" instead of naming the three
 * products the user is choosing between. Nothing is DERIVED from this map; it
 * only labels. The Alibaba labels equal each definition's `displayName`, and
 * `qwen-coding-plan.test.ts` holds them to it.
 */
export const PROVIDER_REASONS: Record<string, string> = {
  litellm: "LiteLLM proxy",
  "opencode-zen": "Free tier (OpenCode Zen)",
  "opencode-zen-go": "Zen Go plan",
  kimi: "Native Kimi API",
  "kimi-coding": "Kimi Coding Plan",
  minimax: "Native MiniMax API",
  "minimax-coding": "MiniMax Coding Plan",
  glm: "Native GLM API",
  "glm-coding": "GLM Coding Plan",
  "qwen-token-plan": "Alibaba Token Plan",
  "qwen-coding": "Alibaba Coding Plan",
  "qwen-payg": "Alibaba PAYG",
  google: "Direct Gemini API",
  openai: "Direct OpenAI API",
  "openai-codex": "OpenAI Codex (Responses API)",
  zai: "Z.AI API",
  ollamacloud: "Cloud Ollama",
  vertex: "Vertex AI (ADC)",
  openrouter: "Fallback: 580+ models",
};

interface RoutingContentProps {
  config: ClaudishProfileConfig;
  probeMode: ProbeMode;
  probeModel: string;
  probeResults: ProbeEntry[];
  /** The decision as a whole, from the same explainRoute call as the rows. */
  probeSummary: ProbeSummary | null;
  mode: Mode;
  routingPattern: string;
  chainSelected: Set<string>;
  chainOrder: string[];
  chainCursor: number;
  // NOTE: shared with the Providers tab. See "Known wart" in
  // ai-docs/app-tsx-split/walkthrough.md — switching tabs preserves the cursor
  // across two unrelated lists. Intentionally not fixed in this refactor.
  providerIndex: number;
  mergedRules: MergedRule[];
  width: number;
  contentH: number;
  isRoutingInput: boolean;
  /** When the picker is open as part of `e` on an existing rule, this is
   *  the rule's current scope ("global" or "project"). Used to label that
   *  option as "(current)" so the user can move scopes deliberately. Null
   *  when adding a new rule or overriding a default (no current scope). */
  editingExistingScope: "global" | "project" | null;
  /** Cursor index for the scope picker menu (0 = global, 1 = project). */
  routingScopeCursor: 0 | 1;
}

export function RoutingContent({
  config,
  probeMode,
  probeModel,
  probeResults,
  probeSummary,
  mode,
  routingPattern,
  chainSelected,
  chainOrder,
  chainCursor,
  providerIndex,
  mergedRules,
  width,
  contentH,
  isRoutingInput,
  editingExistingScope,
  routingScopeCursor,
}: RoutingContentProps) {
  // Refs for the two scrolling lists. We auto-scroll the cursor into view via
  // an effect; the scrollbox itself is unfocused so it doesn't capture our
  // useKeyboard arrow keys (cursor navigation is owned by App.tsx).
  const rulesScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const chainScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Each rule row is height={1}, so the cursor's pixel position == providerIndex.
  // Scroll only when the cursor row would be outside the current viewport, then
  // scroll to keep the row at least one line away from the top/bottom edge.
  useEffect(() => {
    const sb = rulesScrollRef.current;
    if (!sb || mergedRules.length === 0) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    const bottom = top + viewportH;
    if (providerIndex < top) {
      sb.scrollTo({ x: 0, y: providerIndex });
    } else if (providerIndex >= bottom) {
      sb.scrollTo({ x: 0, y: providerIndex - viewportH + 1 });
    }
  }, [providerIndex, mergedRules.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `mode` deliberately re-triggers scroll-into-view on mode change
  useEffect(() => {
    const sb = chainScrollRef.current;
    if (!sb) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    const bottom = top + viewportH;
    if (chainCursor < top) {
      sb.scrollTo({ x: 0, y: chainCursor });
    } else if (chainCursor >= bottom) {
      sb.scrollTo({ x: 0, y: chainCursor - viewportH + 1 });
    }
  }, [chainCursor, mode]);

  // Full-screen probe takes over when not idle
  const probeBoxH = contentH + DETAIL_H + 1; // spans content + detail area

  if (probeMode === "input") {
    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg={C.strong} attributes={A.bold}>
            {"Route Probe"}
          </span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>{"Enter a model name to trace its routing chain:"}</span>
        </text>
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.green} attributes={A.bold}>
              {"> "}
            </span>
            <span fg={C.strong}>{probeModel}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
        </box>
        <text> </text>
        <text>
          <span fg={C.dim}>{"Examples: kimi-k2  deepseek-r1  gemini-2.0-flash  gpt-4o"}</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>
            {"The probe shows the routing chain a request would use, then tests"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>
            {"each kept hop in order, stopping at the first success. Dropped"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"candidates are listed with the reason, never tested."}</span>
        </text>
      </box>
    );
  }

  if (probeMode === "running" || probeMode === "done") {
    const successEntry = probeResults.find((e) => e.status === "success");
    const outcome = deriveProbeOutcome(probeMode, probeResults);
    const allFailed = outcome === "no-route";
    const unverified = outcome === "unverified";
    const totalMs = successEntry?.ms;

    const statusBadge =
      outcome === "running"
        ? { text: "probing...", color: C.yellow }
        : outcome === "routed"
          ? { text: "routed", color: C.green }
          : unverified
            ? { text: "native — not probed", color: C.cyan }
            : { text: "no route", color: C.red };

    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={probeMode === "running" ? C.focusBorder : C.blue}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        {/* Title row */}
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.strong} attributes={A.bold}>
              {probeMode === "done" ? "Probe: " : "Probing: "}
            </span>
            <span fg={C.cyan} attributes={A.bold}>
              {probeModel}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {probeMode === "done" && (
              <span fg={statusBadge.color} attributes={A.bold}>
                {outcome === "routed" ? "● " : unverified ? "◐ " : "✗ "}
                {statusBadge.text}
              </span>
            )}
            {probeMode === "running" && <span fg={C.yellow}>{"◌ probing..."}</span>}
          </text>
        </box>
        <text> </text>
        {/* Where the chain came from: describeRouteExplanation, the line
            --probe prints for the same decision. */}
        <text>
          <span fg={C.fgMuted}>{probeSummary?.line ?? ""}</span>
        </text>
        {probeSummary?.warnings.map((warning) => (
          <text key={`warning:${warning}`}>
            <span fg={C.yellow}>{`! ${warning}`}</span>
          </text>
        ))}
        {probeSummary?.notes.map((note) => (
          <text key={`note:${note}`}>
            <span fg={C.dim}>{note}</span>
          </text>
        ))}
        <text> </text>
        {/* Chain entries — 2 lines each, dropped candidates in place */}
        {probeResults.map((entry, idx) => {
          const isDropped = entry.status === "dropped";
          const isNotReached = entry.status === "skipped";
          const isSelected = entry.status === "success" && probeMode === "done";
          const status = rowStatusView(entry);
          const nameCol = entry.displayName.padEnd(18).substring(0, 18);
          const reason = PROVIDER_REASONS[entry.provider] ?? entry.provider;

          return (
            <box key={`${idx}:${entry.provider}`} flexDirection="column">
              <text>
                <span fg={C.dim}>{`${idx + 1}. `}</span>
                <span
                  fg={isDropped || isNotReached ? C.dim : isSelected ? C.strong : C.fgMuted}
                  attributes={A.boldIf(isSelected)}
                >
                  {nameCol}
                </span>
                <span fg={C.dim}>{"  "}</span>
                <span fg={status.color} attributes={A.boldIf(entry.status === "success")}>
                  {status.icon} {status.text}
                </span>
                {isSelected && (
                  <span fg={C.green} attributes={A.bold}>
                    {" ← routed here"}
                  </span>
                )}
              </text>
              <text>
                <span fg={C.dim}>{"    ↳ "}</span>
                <span fg={isDropped ? C.dim : C.fgMuted}>{reason}</span>
              </text>
            </box>
          );
        })}
        {/* Result line */}
        {probeMode === "done" && (
          <>
            <text> </text>
            <text>
              {probeSummary?.noRoute ? (
                <>
                  <span fg={C.red} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.red}>{`✗ No route — ${probeSummary.noRoute.reason}`}</span>
                </>
              ) : allFailed ? (
                <>
                  <span fg={C.red} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.red}>{"✗ No provider could serve this model"}</span>
                </>
              ) : unverified ? (
                <>
                  <span fg={C.cyan} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.fgMuted}>
                    {"◐ Served natively on Claude Code's own auth — not probed here"}
                  </span>
                </>
              ) : (
                <>
                  <span fg={C.green} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.fgMuted}>{"Routed to "}</span>
                  <span fg={C.cyan} attributes={A.bold}>
                    {successEntry!.displayName}
                  </span>
                  {totalMs !== undefined && <span fg={C.fgMuted}>{` in ${totalMs}ms`}</span>}
                </>
              )}
            </text>
            {hintLines(probeSummary?.noRoute?.hint).map((line) => (
              <text key={line.id}>
                <span fg={C.dim}>{`  ${line.text}`}</span>
              </text>
            ))}
          </>
        )}
      </box>
    );
  }

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={C.blue}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* The FALLBACK hop — the last-resort provider appended after the chain
          gathered from the cloud models catalog, and the only routing fact left
          that is global rather than per-model.

          This used to compare `defaultProvider` against the shipped
          DEFAULT_ROUTING_RULES catch-all and report which "overrode" which.
          That table is gone, so there is no built-in to override; what is true
          now is simply which provider occupies the last position, and whether
          the user emptied it. Each header `<text>` is pinned to height={1} so
          flex layout doesn't collapse them into the scrollbox below in tight
          viewports. */}
      <text height={1}>
        <span fg={C.blue} attributes={A.bold}>
          {" Fallback hop:"}
        </span>
        <span fg={C.fgMuted}>{"  (tried last, after every provider the catalog maps)"}</span>
      </text>
      <text height={1}>
        {(() => {
          const configured = config.defaultProvider;
          // An explicitly EMPTY string disables the hop; unset means "no
          // preference" and takes openrouter. `routeBare` draws the same line.
          if (configured !== undefined && configured.length === 0) {
            return (
              <>
                <span fg={C.dim}>{"  → "}</span>
                <span fg={C.yellow}>{"disabled"}</span>
                <span fg={C.fgMuted}>
                  {"  (defaultProvider is empty — an unroutable model errors instead)"}
                </span>
              </>
            );
          }
          const hasOverride = configured !== undefined && configured.length > 0;
          return (
            <>
              <span fg={C.dim}>{"  → "}</span>
              <span fg={C.cyan}>{hasOverride ? configured : DEFAULT_FALLBACK_PROVIDER}</span>
              <span fg={C.fgMuted}>
                {hasOverride
                  ? "  (defaultProvider)"
                  : "  (default — set defaultProvider to change)"}
              </span>
            </>
          );
        })()}
      </text>
      {/* Dashed section divider (" ─" units). Intentionally NOT a border:
          OpenTUI borders are solid, so a border={["top"]} box would render a
          continuous line and lose the dashed look. The count is derived from
          the real terminal width (minus paddingX) divided by 2 cells/unit —
          principled arithmetic, not a magic constant. */}
      <text height={1}>
        <span fg={C.dim}>{" ─".repeat(Math.max(1, Math.floor((width - 6) / 2)))}</span>
      </text>
      {/* Rules table. Header is title + a single dim hint about scope
          discovery. Hotkeys (a / e / d) live in the footer — don't repeat
          them inline. The scope picker shown by `a`/`e` is its own
          explainer, so we only need a discoverability nudge here. */}
      <text height={1}>
        <span fg={C.blue} attributes={A.bold}>
          {" Rules"}
        </span>
        {!isRoutingInput && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.green}>{"global"}</span>
            <span fg={C.dim}>{" / "}</span>
            <span fg={C.cyan}>{"project"}</span>
            <span fg={C.dim}>{" scope chosen on "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"a"}
            </span>
            <span fg={C.dim}>{" or "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"e"}
            </span>
          </>
        )}
      </text>
      {!isRoutingInput && mergedRules.length === 0 && (
        <text height={1}>
          <span fg={C.fgMuted}>{" No rules. Press "}</span>
          <span fg={C.green} attributes={A.bold}>
            a
          </span>
          <span fg={C.fgMuted}>{" to add."}</span>
        </text>
      )}
      {mergedRules.length > 0 && !isRoutingInput && (
        <>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"  "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"PATTERN         "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"SCOPE     "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"CHAIN"}
            </span>
          </text>
          {/* Native OpenTUI scrollbox. Unfocused: cursor navigation stays in
              App.tsx's useKeyboard handler; we sync scroll position via the
              effect above when providerIndex changes. */}
          <scrollbox
            ref={rulesScrollRef}
            scrollX={false}
            scrollY={true}
            focused={false}
            style={{ flexGrow: 1 }}
          >
            {mergedRules.map((rule, idx) => {
              const sel = idx === providerIndex;
              const isProject = rule.kind === "project";
              // Marker: project (▴ cyan) > global (• green). Every row is one
              // of the user's own rules and owns one scope — no shadowing in
              // the table. The dim "·" built-in row and the yellow "★"
              // override-of-a-default row are both gone, because the shipped
              // rules table they compared against no longer exists.
              const marker = isProject ? "▴" : "•";
              const markerFg = isProject ? C.cyan : C.green;
              // SCOPE column: explicit text, color-coded.
              const scopeText = isProject ? "project " : "global  ";
              const scopeFg = isProject ? C.cyan : C.green;
              const patFg = sel ? C.strong : C.cyan;
              const chainFg = sel ? C.cyan : C.fgMuted;
              return (
                <box
                  key={`${rule.kind}-${rule.pattern}`}
                  height={1}
                  flexDirection="row"
                  backgroundColor={sel ? C.bgHighlight : C.bg}
                >
                  <text>
                    <span fg={markerFg} attributes={A.bold}>{` ${marker} `}</span>
                    <span fg={patFg} attributes={A.boldIf(sel)}>
                      {rule.pattern.padEnd(16).substring(0, 16)}
                    </span>
                    <span fg={scopeFg}>{scopeText}</span>
                    <span fg={chainFg}>{chainStr(rule.chain)}</span>
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </>
      )}

      {/* Scope picker — menu-style navigation matching the chain selector
          and Providers tab. Cursor highlights the active row; ↑↓ moves it,
          Enter selects, Esc cancels. Letter shortcuts (g/p) still work as
          silent accelerators but the visible UI is the menu. */}
      {mode === "pick_routing_scope" && (
        <box flexDirection="column" paddingTop={1} paddingX={1} style={{ flexGrow: 1 }}>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Scope for "}
            </span>
            <span fg={C.strong} attributes={A.bold}>
              {routingPattern}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {":"}
            </span>
          </text>
          <text height={1}>
            <span fg={C.fgMuted}>{"  Choose where to save this rule. Project rules live in "}</span>
            <span fg={C.cyan}>{".claudish.json"}</span>
            <span fg={C.fgMuted}>{" and only apply when"}</span>
          </text>
          <text height={1}>
            <span fg={C.fgMuted}>{"  running claudish from inside this project."}</span>
          </text>
          <text height={1}> </text>
          {/* Menu rows with cursor highlight. Same pattern as
              add_routing_chain's provider rows: backgroundColor on
              the cursor row, bold on selected text. */}
          <box height={1} backgroundColor={routingScopeCursor === 0 ? C.bgHighlight : C.bg}>
            <text>
              <span fg={routingScopeCursor === 0 ? C.green : C.fgMuted} attributes={A.bold}>
                {routingScopeCursor === 0 ? " ▸ " : "   "}
              </span>
              <span fg={C.green} attributes={A.boldIf(routingScopeCursor === 0)}>
                {"global   "}
              </span>
              <span fg={C.fgMuted}>{"~/.claudish/config.json"}</span>
              {editingExistingScope === "global" && <span fg={C.dim}>{"   (current)"}</span>}
            </text>
          </box>
          <box height={1} backgroundColor={routingScopeCursor === 1 ? C.bgHighlight : C.bg}>
            <text>
              <span fg={routingScopeCursor === 1 ? C.cyan : C.fgMuted} attributes={A.bold}>
                {routingScopeCursor === 1 ? " ▸ " : "   "}
              </span>
              <span fg={C.cyan} attributes={A.boldIf(routingScopeCursor === 1)}>
                {"project  "}
              </span>
              <span fg={C.fgMuted}>{".claudish.json (walks up to git root)"}</span>
              {editingExistingScope === "project" && <span fg={C.dim}>{"   (current)"}</span>}
            </text>
          </box>
          <text height={1}> </text>
          <text height={1}>
            <span fg={C.dim}>{"  "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"↑↓"}
            </span>
            <span fg={C.dim}>{" navigate · "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"Enter"}
            </span>
            <span fg={C.dim}>{" select · "}</span>
            <span fg={C.red} attributes={A.bold}>
              {"Esc"}
            </span>
            <span fg={C.dim}>{" cancel"}</span>
          </text>
        </box>
      )}

      {/* Input fields */}
      {mode === "add_routing_pattern" && (
        <box flexDirection="column">
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Pattern "}
            </span>
            <span fg={C.dim}>{"(e.g. kimi-*, gpt-4o):"}</span>
          </text>
          <text height={1}>
            <span fg={C.green} attributes={A.bold}>
              {"> "}
            </span>
            <span fg={C.strong}>{routingPattern}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
          <text height={1}>
            <span fg={C.green} attributes={A.bold}>
              Enter{" "}
            </span>
            <span fg={C.fgMuted}>to continue · </span>
            <span fg={C.red} attributes={A.bold}>
              Esc{" "}
            </span>
            <span fg={C.fgMuted}>to cancel</span>
          </text>
        </box>
      )}
      {mode === "add_routing_chain" && (
        <box flexDirection="column" style={{ flexGrow: 1 }}>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Select providers for "}
            </span>
            <span fg={C.strong} attributes={A.bold}>
              {routingPattern}
            </span>
            <span fg={C.dim}>{" (Space=toggle, 1-9=set position, Enter=save)"}</span>
          </text>
          {chainOrder.length > 0 && (
            <text height={1}>
              <span fg={C.fgMuted}>{"  Chain: "}</span>
              <span fg={C.cyan}>{chainOrder.join(" → ")}</span>
            </text>
          )}
          {/* Native OpenTUI scrollbox. Same focused=false pattern as the rules
              table — cursor navigation owned by App.tsx, scroll synced via the
              chainCursor effect above. */}
          <scrollbox
            ref={chainScrollRef}
            scrollX={false}
            scrollY={true}
            focused={false}
            style={{ flexGrow: 1 }}
          >
            {getChainProviders().map((prov, idx) => {
              const isCursor = idx === chainCursor;
              const isOn = chainSelected.has(prov.name);
              const pos = isOn ? chainOrder.indexOf(prov.name) + 1 : 0;
              const ready = providerIsReady(prov, config);
              const label = prov.displayName.padEnd(18).substring(0, 18);
              return (
                <box key={prov.name} height={1} backgroundColor={isCursor ? C.bgHighlight : C.bg}>
                  <text>
                    {isOn ? (
                      <span fg={C.green} attributes={A.bold}>{` [${pos}] `}</span>
                    ) : (
                      <span fg={C.dim}>{" [ ] "}</span>
                    )}
                    <span
                      fg={isCursor ? C.strong : ready ? C.fgMuted : C.dim}
                      attributes={A.boldIf(isCursor)}
                    >
                      {label}
                    </span>
                    {ready ? (
                      <span fg={C.green}>{" ●"}</span>
                    ) : (
                      <span fg={C.dim}>{prov.isLocal ? " ○ disabled" : " ○ no key"}</span>
                    )}
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </box>
      )}
    </box>
  );
}
