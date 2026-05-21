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
  /**
   * Monotonically-incrementing counter from App that ticks every ~80ms while
   * at least one provider is being tested. Used to drive the Matrix-style
   * key-scramble animation on testing rows. When no test is in flight, this
   * stays constant and rows render normally.
   */
  animTick: number;
}

// Matrix-style charset for the key scramble. Uppercase + digits + a few
// glyphs gives the right "code falling" texture in a monospaced font.
const SCRAMBLE_CHARS = "01ABCDEFGHJKLMNPQRSTUVWXYZ#@$%*?";

function scrambleKey(width: number, tick: number, salt: string): string {
  // Deterministic-ish per-(tick, salt) random so each row scrambles
  // independently but stably within a single render frame.
  let seed = tick * 2654435761 + hashString(salt);
  let out = "";
  for (let i = 0; i < width; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out += SCRAMBLE_CHARS[seed % SCRAMBLE_CHARS.length];
  }
  return out;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Column widths — kept here so headers and rows stay in lockstep.
const COL_NAME = 14;
const COL_STATUS = 9;  // "ready Xms" / "testing" / "not set" / "FAIL"
// AUTH column: icon-based encoding.
//   🔑 = key set       (2 cells)
//   🌐 = oauth set     (2 cells)
//   ·  = supported but not set (1 cell, padded to 2 for alignment)
//   (blank 2 cells) = method not supported by this provider
// Two slots side by side: [key-slot] " " [oauth-slot] → 5 cells total.
const COL_AUTH = 5;
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
  animTick,
}: ProvidersContentProps) {
  // contentH = total height of the rounded box.
  //   -2 for top/bottom border, -1 for column header, -1 for legend row.
  const listH = contentH - 4;
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
    //
    // When a provider is being tested, swap the static masked key for a
    // Matrix-style scramble that re-rolls every tick from `animTick`. Gives
    // visceral "computing..." feedback without animating the status text.
    const tr = testResults[p.name];
    const isTesting = tr?.status === "testing";
    let keyDisplay: string;
    if (isTesting) {
      keyDisplay = scrambleKey(8, animTick, p.name);
    } else if (isOauthOnly) {
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

    // `tr` was already resolved above (for the key scramble); reuse it here.
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
        {/*
          Row background: selected wins over failed wins over default.
          A failed row gets a faint red-tinted background so the inline
          error message reads as a unified band across the full row width.
          flexGrow=1 lets OpenTUI size the row to its parent column
          automatically. overflow="hidden" clips the description/error span
          so a long error message can't bleed past the row's bounding box.
        */}
        <box
          height={1}
          flexGrow={1}
          flexDirection="row"
          overflow="hidden"
          backgroundColor={
            selected
              ? C.bgHighlight
              : tr?.status === "failed"
                ? C.bgError
                : C.bg
          }
        >
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
            {/* AUTH column: emoji icons. Each slot is 2 terminal cells.
                  🔑 / 🌐 = method set
                  ·       = method supported but not set (1 cell + 1 pad)
                  blank   = method not supported (2 cells)
                Legend at the bottom of the panel explains the icons. */}
            {(() => {
              const keySlotGlyph = !keySlot.supported
                ? "  "
                : keySlot.set
                  ? "🔑"
                  : "· ";
              const oauthSlotGlyph = !oauthSlot.supported
                ? "  "
                : oauthSlot.set
                  ? "🌐"
                  : "· ";
              // Color the unset dot dim; the emoji renders with terminal color.
              return (
                <>
                  <span fg={keySlot.set ? C.white : C.dim}>{keySlotGlyph}</span>
                  <span>{" "}</span>
                  <span fg={oauthSlot.set ? C.white : C.dim}>{oauthSlotGlyph}</span>
                </>
              );
            })()}
            <span fg={C.dim}>{"  "}</span>
            <span fg={isOauthOnly ? C.cyan : isReady ? C.cyan : C.dim}>
              {pad(keyDisplay, COL_KEY)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {/*
              Description column doubles as inline error surface. When a row's
              test failed, replace the static description with the error
              message (collapsed to a single line, clipped to remaining width)
              rendered red so the user can see what went wrong without leaving
              the row. The proxy used to print `[claudish] Error [Provider]:
              ...` to stderr — that's now suppressed in the TUI (see
              tui/index.tsx → setStderrQuiet), and the error data lives in
              testResults[p.name].error instead.
            */}
            {/* Description column doubles as inline error surface when a test
                failed. We collapse whitespace to a single line, but DON'T
                pre-compute truncation width — the row's height={1} + the
                container's overflow="hidden" let OpenTUI clip naturally. */}
            {tr?.status === "failed" && tr.error ? (
              <span fg={C.red}>{tr.error.replace(/\s+/g, " ").trim()}</span>
            ) : (
              <span fg={selected ? C.white : C.dim}>{p.description}</span>
            )}
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
      {/* Column header — widths match COL_* constants used by getRow. */}
      <text height={1}>
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
      {/* Rows fill the available space between header and legend. flexGrow
          on this wrapper pushes the legend below to the panel's bottom
          edge regardless of how many providers are shown. */}
      <box flexDirection="column" style={{ flexGrow: 1 }}>
        {displayProviders.slice(0, listH).map(getRow)}
      </box>
      {/* AUTH icon legend — pinned to the bottom of the panel via the
          flex spacer above. Explains 🔑 / 🌐 / · without repeating
          hints per row. */}
      <text height={1}>
        <span fg={C.dim}>{"AUTH:  "}</span>
        <span>{"🔑"}</span>
        <span fg={C.fgMuted}>{" key set  "}</span>
        <span>{"🌐"}</span>
        <span fg={C.fgMuted}>{" oauth set  "}</span>
        <span fg={C.dim}>{"·"}</span>
        <span fg={C.fgMuted}>{" supported, not set  "}</span>
        <span fg={C.dim}>{"(blank) not available"}</span>
      </text>
    </box>
  );
}
