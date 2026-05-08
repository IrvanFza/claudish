/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { DETAIL_H } from "../constants.js";
import type { ProbeMode } from "../types.js";

interface RoutingDetailProps {
  probeMode: ProbeMode;
  ruleEntries: Array<[string, string[]]>;
}

export function RoutingDetail({ probeMode, ruleEntries }: RoutingDetailProps) {
  // Probe is full-screen — no separate detail panel shown
  if (probeMode !== "idle") {
    return null;
  }

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title=" Examples "
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.fgMuted}>{"  kimi-*      "}</span>
        <span fg={C.dim}>{" → "}</span>
        <span fg={C.cyan}>{"kimi, openrouter"}</span>
      </text>
      <text>
        <span fg={C.fgMuted}>{"  gpt-*       "}</span>
        <span fg={C.dim}>{" → "}</span>
        <span fg={C.cyan}>{"oai, litellm"}</span>
      </text>
      <text>
        <span fg={C.fgMuted}>{"  gemini-*    "}</span>
        <span fg={C.dim}>{" → "}</span>
        <span fg={C.cyan}>{"google, zen, openrouter"}</span>
      </text>
      <text>
        <span fg={C.fgMuted}>{"  deepseek-*  "}</span>
        <span fg={C.dim}>{" → "}</span>
        <span fg={C.cyan}>{"zen, openrouter"}</span>
      </text>
      <text>
        <span fg={C.dim}>{"  Glob pattern (* = any). Chain tried left to right. "}</span>
        <span fg={C.cyan} bold>
          {ruleEntries.length}
        </span>
        <span fg={C.fgMuted}>
          {" custom rule"}
          {ruleEntries.length !== 1 ? "s" : ""}
        </span>
      </text>
    </box>
  );
}
