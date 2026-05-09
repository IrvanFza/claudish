/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { DETAIL_H } from "../constants.js";
import type { ProbeMode } from "../types.js";
import type { MergedRule } from "./RoutingContent.js";

interface RoutingDetailProps {
  probeMode: ProbeMode;
  mergedRules: MergedRule[];
}

export function RoutingDetail({ probeMode, mergedRules }: RoutingDetailProps) {
  // Probe is full-screen — no separate detail panel shown
  if (probeMode !== "idle") {
    return null;
  }

  const defaults = mergedRules.filter((r) => r.kind === "default").length;
  const userRules = mergedRules.filter((r) => r.kind === "user");
  const overrides = userRules.filter((r) => r.overridesDefault).length;
  const userOnly = userRules.length - overrides;

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title=" Legend "
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.dim} bold>
          {" · "}
        </span>
        <span fg={C.fgMuted}>
          {"built-in default · "}
        </span>
        <span fg={C.green} bold>
          {"•"}
        </span>
        <span fg={C.fgMuted}>{" custom rule · "}</span>
        <span fg={C.yellow} bold>
          {"★"}
        </span>
        <span fg={C.fgMuted}>{" custom override of a built-in default"}</span>
      </text>
      <text>
        <span fg={C.fgMuted}>{"  Chains tried left to right; built-in defaults can be overridden via "}</span>
        <span fg={C.green} bold>{"e"}</span>
        <span fg={C.fgMuted}>{"."}</span>
      </text>
      <text>
        <span fg={C.cyan} bold>{`  ${defaults}`}</span>
        <span fg={C.fgMuted}>{" built-in"}</span>
        <span fg={C.dim}>{"  ·  "}</span>
        <span fg={C.cyan} bold>{`${userOnly}`}</span>
        <span fg={C.fgMuted}>{" custom"}</span>
        <span fg={C.dim}>{"  ·  "}</span>
        <span fg={C.yellow} bold>{`${overrides}`}</span>
        <span fg={C.fgMuted}>{" override" + (overrides === 1 ? "" : "s")}</span>
      </text>
    </box>
  );
}
