import type { CredentialSource } from "../../auth/credentials/source.js";
import { DETAIL_H } from "../constants.js";
import type { ProviderDef } from "../providers.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import type { Mode, TestResultsMap } from "../types.js";

/**
 * Collapse newlines and clip an error string to a single line that fits
 * inside the detail box without wrapping. Used for `tr.error` which can
 * come back from describeProbeState as a multi-line, 200-char message.
 */
function truncateOneLine(text: string, maxWidth: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(20, maxWidth);
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

interface ProviderDetailProps {
  selectedProvider: ProviderDef;
  mode: Mode;
  inputValue: string;
  setInputValue: (v: string) => void;
  width: number;
  hasCfgKey: boolean;
  hasEnvKey: boolean;
  hasKey: boolean;
  /**
   * Where the credential comes from, from the SAME classifier the provider list
   * uses (`describeSourceSync` via `providerAuthSource`).
   *
   * Passed in rather than re-derived here. The detail pane used to decide
   * readiness and key display from its own expression over `hasEnvKey` /
   * `hasCfgKey` / `publicKeyFallback`, which knew nothing about OAuth — so every
   * 🌐 provider showed "Not configured" directly beneath a row saying "ready".
   */
  authSource: CredentialSource;
  /** True when the env-var key was hydrated from 1Password (not a shell env var). */
  isOpKey: boolean;
  /** True when the env-var key was hydrated from the macOS Keychain. */
  isKcKey: boolean;
  /** True when a keychain item exists for this variable, whether or not it is the value in use. */
  hasKcKey: boolean;
  /**
   * Where a key typed here will be written. Named in the input box title so the
   * store is never a surprise — this used to be plaintext config.json
   * unconditionally, and a silent change of destination for secrets is exactly
   * the kind of thing a user is entitled to see before pressing Enter.
   */
  keySaveTarget: string;
  /** True for a keyless/free provider usable via its built-in public key. */
  cfgKeyMask: string;
  envKeyMask: string;
  activeEndpoint: string;
  testResults: TestResultsMap;
  isInputMode: boolean;
}

export function ProviderDetail({
  selectedProvider,
  mode,
  inputValue,
  setInputValue,
  width,
  hasCfgKey,
  hasEnvKey,
  hasKey,
  authSource,
  isOpKey,
  isKcKey,
  hasKcKey,
  keySaveTarget,
  cfgKeyMask,
  envKeyMask,
  activeEndpoint,
  testResults,
  isInputMode,
}: ProviderDetailProps) {
  // Show the mask of the key that's ACTUALLY being used at runtime.
  // process.env wins over config in the resolver, so env is shown first when both exist.
  //
  // The OAuth branch mirrors the list's own `keyDisplay` (ProvidersContent):
  // an OAuth-authenticated provider has no key to mask, and falling through to
  // the dashes would print "Status: ● Ready   Key: ────────", which reads as a
  // contradiction even though both halves would be individually true.
  const isOauthOnly = authSource === "oauth";
  const displayKey = selectedProvider.isLocal
    ? hasKey
      ? "enabled"
      : "disabled"
    : isOauthOnly
      ? "oauth···"
      : hasEnvKey
        ? envKeyMask
        : hasCfgKey
          ? cfgKeyMask
          : "────────";

  if (isInputMode) {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        title={
          mode === "input_key"
            ? ` Set API Key — ${selectedProvider.displayName} → ${keySaveTarget} `
            : ` Set Endpoint — ${selectedProvider.displayName} `
        }
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.green} attributes={A.bold}>
            Enter{" "}
          </span>
          <span fg={C.fgMuted}>to save · </span>
          <span fg={C.red} attributes={A.bold}>
            Esc{" "}
          </span>
          <span fg={C.fgMuted}>to cancel</span>
        </text>
        <box flexDirection="row">
          <text>
            <span fg={C.green} attributes={A.bold}>
              &gt;{" "}
            </span>
          </text>
          <input
            value={inputValue}
            // onInput fires on every keystroke; onChange only fires on blur
            // or the input's own submit (which doesn't happen here because
            // our useKeyboard handler intercepts Enter first). Without this
            // the parent's inputValue stays at the prefilled value and the
            // user's edits are lost when they press Enter.
            onInput={setInputValue}
            onChange={setInputValue}
            focused={true}
            width={width - 8}
            backgroundColor={C.bgHighlight}
            textColor={C.strong}
          />
        </box>
      </box>
    );
  }

  const tr = testResults[selectedProvider.name];

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={` ${selectedProvider.displayName} `}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {/*
        Single-row line: Status + Key + source breakdown.
        Source labels enumerate every place this key is found (env, config),
        in runtime precedence order. The runtime-active source is tagged
        `(used)`; a shadowed source is tagged `(shadowed)` so the user
        knows their `s`-saved config key isn't taking effect.

        Packed into ONE <text> row to fit inside DETAIL_H=7 (5 content
        rows: this + URL + Desc + Get Key + Test). All literal whitespace
        goes inside `{...}` to avoid JSX whitespace trimming.
      */}
      <text>
        <span fg={C.blue} attributes={A.bold}>
          {"Status: "}
        </span>
        {hasKey ? (
          <span fg={C.green} attributes={A.bold}>
            {"● Ready"}
          </span>
        ) : (
          <span fg={C.fgMuted}>{"○ Not configured"}</span>
        )}
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>
          {"Key: "}
        </span>
        <span fg={C.green}>{displayKey}</span>
        {/* Unconfigured keyed provider: name the exact env var(s) claudish
            expects, so "Not configured" is actionable without leaving the TUI.
            Fits here because the "From:" segment only renders when a key IS
            set — the two never share the row. */}
        {!hasKey && !selectedProvider.isLocal && selectedProvider.apiKeyEnvVar && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"Env: "}
            </span>
            <span fg={C.yellow}>
              {[selectedProvider.apiKeyEnvVar, ...(selectedProvider.aliases ?? [])].join(" | ")}
            </span>
          </>
        )}
        {hasKey && selectedProvider.isLocal && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            <span fg={C.green} attributes={A.bold}>
              {"global config"}
            </span>
          </>
        )}
        {/* OAuth branch FIRST among the non-local sources. Without it an
            OAuth-only provider reaches the env/cfg block below, where both
            flags are false and "From: " renders with nothing after it. */}
        {hasKey && !selectedProvider.isLocal && isOauthOnly && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            <span fg={C.cyan} attributes={A.bold}>
              {"oauth"}
            </span>
            <span fg={C.fgMuted}>{" (used)"}</span>
          </>
        )}
        {hasKey && !selectedProvider.isLocal && !isOauthOnly && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            {/* Origin of the runtime value. `isKcKey` is tested BEFORE `isOpKey`
                because the keychain is resolved first, so when both vaults could
                supply this variable the keychain is the one that did. */}
            {hasEnvKey && (
              <span fg={C.green} attributes={A.bold}>
                {isKcKey ? "keychain" : isOpKey ? "1Password" : "env"}
              </span>
            )}
            {hasEnvKey && hasCfgKey && <span fg={C.fgMuted}>{" (used) + "}</span>}
            {hasEnvKey && !hasCfgKey && <span fg={C.fgMuted}>{" (used)"}</span>}
            {hasCfgKey && (
              <span fg={hasEnvKey ? C.fgMuted : C.green} attributes={A.boldIf(!hasEnvKey)}>
                {"config"}
              </span>
            )}
            {hasCfgKey && <span fg={C.fgMuted}>{hasEnvKey ? " (shadowed)" : " (used)"}</span>}
            {/* A keychain item that exists but is NOT the runtime value — the
                backend is off, or a higher-priority source shadows it. Worth
                naming explicitly: otherwise `x` reporting "removed from macOS
                Keychain" would come as a surprise on a row that never mentioned
                one. */}
            {hasKcKey && !isKcKey && (
              <>
                <span fg={C.fgMuted}>{" + "}</span>
                <span fg={C.fgMuted}>{"keychain (shadowed)"}</span>
              </>
            )}
          </>
        )}
      </text>
      {selectedProvider.endpointEnvVar && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            URL:{" "}
          </span>
          <span fg={C.cyan}>{activeEndpoint || selectedProvider.defaultEndpoint || "default"}</span>
        </text>
      )}
      <text>
        <span fg={C.blue} attributes={A.bold}>
          Desc:{" "}
        </span>
        <span fg={C.strong}>{selectedProvider.description}</span>
      </text>
      {selectedProvider.keyUrl && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            Get Key:{" "}
          </span>
          <span fg={C.cyan}>{selectedProvider.keyUrl}</span>
        </text>
      )}
      {tr && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            {"Test:  "}
          </span>
          {tr.status === "testing" && (
            <span fg={C.yellow} attributes={A.bold}>
              {"◌ testing..."}
            </span>
          )}
          {tr.status === "valid" && (
            <>
              <span fg={C.green} attributes={A.bold}>
                {"● valid"}
              </span>
              {tr.ms !== undefined && <span fg={C.dim}>{`  ${tr.ms}ms`}</span>}
              <span fg={C.fgMuted}>
                {selectedProvider.isLocal
                  ? "  Local provider responded through the shared probe path."
                  : "  API key is valid and endpoint is reachable."}
              </span>
            </>
          )}
          {tr.status === "failed" && (
            <>
              <span fg={C.red} attributes={A.bold}>
                {"✗ failed"}
              </span>
              {tr.error && (
                <span fg={C.red}>
                  {/* Clip the error to a single line. describeProbeState can
                      produce 200+ char strings ("HTTP 400. Request format
                      may be incompatible…") that wrap and overflow the
                      fixed-height detail box, bleeding into the provider
                      rows above. */}
                  {`  ${truncateOneLine(tr.error, width - 16)}`}
                </span>
              )}
            </>
          )}
          {tr.status === "unavailable" && (
            <>
              {/* Not a failure — the server is off or has no chat model to probe.
                  Neutral yellow, not red. */}
              <span fg={C.yellow} attributes={A.bold}>
                {"○ unavailable"}
              </span>
              {tr.error && (
                <span fg={C.yellow}>{`  ${truncateOneLine(tr.error, width - 16)}`}</span>
              )}
            </>
          )}
        </text>
      )}
    </box>
  );
}
