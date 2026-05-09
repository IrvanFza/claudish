/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { DETAIL_H } from "../constants.js";
import type { ProbeMode } from "../types.js";
import type { MergedRule } from "../types.js";

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
  const globalRules = mergedRules.filter((r) => r.kind === "global");
  const projectRules = mergedRules.filter((r) => r.kind === "project");
  const projectCount = projectRules.length;
  // "overrides" counts user customizations that shadow a built-in default.
  // Both global and project rules can override defaults.
  const overrides =
    globalRules.filter((r) => r.overridesDefault).length +
    projectRules.filter((r) => r.overridesDefault).length;
  const userOnly = globalRules.length + projectRules.length - overrides;

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
        {projectCount > 0 && (
          <>
            <span fg={C.fgMuted}>{" · "}</span>
            <span fg={C.cyan} bold>{"▴"}</span>
            <span fg={C.fgMuted}>{" project rule (.claudish.json)"}</span>
          </>
        )}
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
        {projectCount > 0 && (
          <>
            <span fg={C.dim}>{"  ·  "}</span>
            <span fg={C.cyan} bold>{`${projectCount}`}</span>
            <span fg={C.fgMuted}>{" project"}</span>
          </>
        )}
      </text>
    </box>
  );
}
