/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { ProviderDef, maskKey } from "../providers.js";
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
    const isReady = !!(config.apiKeys?.[p.apiKeyEnvVar] || process.env[p.apiKeyEnvVar]);
    const selected = idx === providerIndex;
    const cfgMask = maskKey(config.apiKeys?.[p.apiKeyEnvVar]);
    const envMask = maskKey(process.env[p.apiKeyEnvVar]);
    const hasCfg = cfgMask !== "────────";
    const hasEnv = envMask !== "────────";
    const keyDisplay = isReady ? (hasCfg ? cfgMask : envMask) : "────────";
    const src = hasEnv && hasCfg ? "e+c" : hasEnv ? "env" : hasCfg ? "cfg" : "";
    const namePad = p.displayName.padEnd(14).substring(0, 14);
    const isFirstUnready = !isReady && !separatorRendered;
    if (isFirstUnready) separatorRendered = true;

    // Inline test result for this provider
    const tr = testResults[p.name];
    let statusFg = isReady ? C.green : C.dim;
    let statusText = isReady ? "ready  " : "not set";
    if (tr) {
      if (tr.status === "testing") {
        statusFg = C.yellow;
        statusText = "testing";
      } else if (tr.status === "valid") {
        statusFg = C.green;
        statusText = tr.ms !== undefined ? `ready ${tr.ms}ms` : "ready ✓";
      } else {
        statusFg = C.red;
        statusText = "FAIL   ";
      }
    }

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
              {namePad}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={statusFg} bold={tr?.status === "valid" || isReady}>
              {statusText}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={isReady ? C.cyan : C.dim}>{keyDisplay}</span>
            {src ? <span fg={C.dim}>{` (${src})`}</span> : null}
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
      {/* Column header */}
      <text>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} bold>
          {"PROVIDER        "}
        </span>
        <span fg={C.blue} bold>
          {"STATUS    "}
        </span>
        <span fg={C.blue} bold>
          {"KEY         "}
        </span>
        <span fg={C.blue} bold>
          DESCRIPTION
        </span>
      </text>
      {displayProviders.slice(0, listH).map(getRow)}
    </box>
  );
}
