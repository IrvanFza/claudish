/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import {
  ProviderDef,
  maskKey,
  providerAuthCapabilities,
  providerAuthSource,
} from "../providers.js";
import type { TestResultsMap } from "../types.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";

interface ProvidersContentProps {
  config: ClaudishProfileConfig;
  displayProviders: ProviderDef[];
  providerIndex: number;
  testResults: TestResultsMap;
  width: number;
  contentH: number;
  isInputMode: boolean;
}

// Column widths — kept here so headers and rows stay in lockstep.
const COL_NAME = 14;
const COL_STATUS = 9;  // "ready Xms" / "testing" / "not set" / "FAIL"
// AUTH column: SINGLE slot per row showing the active method as a pill, or
// dim text for "supported but unset". Combined "key+oauth" tag when both
// are set. Fixed width keeps the table aligned.
const COL_AUTH = 12;   // " key+oauth " max width
const COL_KEY = 10;    // 8-char mask + a little breathing room

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + " ".repeat(n - s.length);
}

export function ProvidersContent({
  config,
  displayProviders,
  providerIndex,
  testResults,
  width,
  contentH,
  isInputMode,
}: ProvidersContentProps) {
  const listH = contentH - 2; // inner height of box
  let separatorRendered = false;

  const getRow = (p: ProviderDef, idx: number) => {
    const auth = providerAuthSource(p, config);
    const caps = providerAuthCapabilities(p, config);
    const isReady = auth !== null;
    const isOauthOnly = auth === "oauth";
    const selected = idx === providerIndex;

    // KEY column. For API-key providers, show the masked key. For OAuth-
    // only providers, show "oauth···" placeholder so the column aligns and
    // makes the auth method obvious at a glance. For unauthenticated
    // providers, dashes.
    let keyDisplay: string;
    if (isOauthOnly) {
      keyDisplay = "oauth···";
    } else if (auth === "cfg") {
      keyDisplay = maskKey(config.apiKeys?.[p.apiKeyEnvVar]);
    } else if (auth === "env" || auth === "e+c") {
      keyDisplay = maskKey(process.env[p.apiKeyEnvVar]);
    } else {
      keyDisplay = "────────";
    }

    const isFirstUnready = !isReady && !separatorRendered;
    if (isFirstUnready) separatorRendered = true;

    // Inline test result for this provider.
    const tr = testResults[p.name];
    let statusFg: string = isReady ? C.green : C.dim;
    let statusText = isReady ? "ready" : "not set";
    if (tr) {
      if (tr.status === "testing") {
        statusFg = C.yellow;
        statusText = "testing";
      } else if (tr.status === "valid") {
        statusFg = C.green;
        statusText = tr.ms !== undefined ? `ready ${tr.ms}ms` : "ready";
      } else {
        statusFg = C.red;
        statusText = "FAIL";
      }
    }

    // AUTH column — two capability slots, side by side.
    //   ● = configured/set
    //   ○ = supported, not yet configured
    //  (space) = not supported by this provider
    //
    // Label "key" is green (API-key family), "oauth" is cyan (OAuth path).
    // When not supported, both label and glyph are blank-padded so columns
    // align between rows with different capability sets.
    const keySlot = caps.apiKey;
    const oauthSlot = caps.oauth;

    return (
      <box key={p.name} flexDirection="column">
        {isFirstUnready && (
          <box height={1} paddingX={1}>
            <text>
              <span fg={C.dim}>
                {"─ not configured "}
                {"─".repeat(Math.max(0, width - 22))}
              </span>
            </text>
          </box>
        )}
        <box height={1} flexDirection="row" backgroundColor={selected ? C.bgHighlight : C.bg}>
          <text>
            <span fg={tr?.status === "testing" ? C.yellow : isReady ? C.green : C.dim}>
              {tr?.status === "testing" ? "◌" : isReady ? "●" : "○"}
            </span>
            <span>{"  "}</span>
            <span fg={selected ? C.white : isReady ? C.fgMuted : C.dim} bold={selected}>
              {pad(p.displayName, COL_NAME)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={statusFg} bold={tr?.status === "valid" || isReady}>
              {pad(statusText, COL_STATUS)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {/* AUTH column: ONE slot per row.
                Cases (most-specific first):
                  · key + oauth both set     → pill " key+oauth " (key bg)
                  · key set only             → pill " key " (key bg)
                  · oauth set only           → pill " oauth " (oauth bg)
                  · both supported, neither  → dim " key/oauth "
                  · key supported only       → dim " key "
                  · oauth supported only     → dim " oauth "
                  · neither supported        → blank, same width
                White text on muted bg for set; dim text for supported-unset. */}
            {(() => {
              const ks = keySlot.set, kSup = keySlot.supported;
              const os = oauthSlot.set, oSup = oauthSlot.supported;
              let label: string, fg: string, bg: string | undefined;
              if (ks && os) {
                label = " key+oauth ";
                fg = C.white;
                bg = C.pillKeyBg;
              } else if (ks) {
                label = " key ";
                fg = C.white;
                bg = C.pillKeyBg;
              } else if (os) {
                label = " oauth ";
                fg = C.white;
                bg = C.pillOauthBg;
              } else if (kSup && oSup) {
                label = " key/oauth ";
                fg = C.dim;
                bg = undefined;
              } else if (kSup) {
                label = " key ";
                fg = C.dim;
                bg = undefined;
              } else if (oSup) {
                label = " oauth ";
                fg = C.dim;
                bg = undefined;
              } else {
                label = "";
                fg = C.dim;
                bg = undefined;
              }
              // Right-pad to COL_AUTH width so the next column aligns.
              const padded = label + " ".repeat(Math.max(0, COL_AUTH - label.length));
              return (
                <>
                  <span fg={fg} bg={bg}>{label}</span>
                  <span>{padded.substring(label.length)}</span>
                </>
              );
            })()}
            <span fg={C.dim}>{"  "}</span>
            <span fg={isOauthOnly ? C.cyan : isReady ? C.cyan : C.dim}>
              {pad(keyDisplay, COL_KEY)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={selected ? C.white : C.dim}>{p.description}</span>
          </text>
        </box>
      </box>
    );
  };

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={!isInputMode ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Column header — widths match COL_* constants used by getRow.
          AUTH column shows per-row "key ● oauth ●" capability slots.
          Glyph legend: ● = set, ○ = supported but not set, blank = not
          supported. */}
      <text>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} bold>{pad("PROVIDER", COL_NAME)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("STATUS", COL_STATUS)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("AUTH", COL_AUTH)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("KEY", COL_KEY)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>DESCRIPTION</span>
      </text>
      {displayProviders.slice(0, listH).map(getRow)}
    </box>
  );
}
