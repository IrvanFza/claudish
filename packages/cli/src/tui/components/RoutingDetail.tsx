import { DETAIL_H } from "../constants.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
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
  // Among global rules, how many override a built-in default? (Project rules
  // get the ▴ marker regardless, so their override status doesn't change
  // the count.)
  const globalOverrides = globalRules.filter((r) => r.overridesDefault).length;
  const globalCustom = globalRules.length - globalOverrides;

  // Format counts with a fixed-width number column so the labels line up
  // even when counts grow into double digits.
  const fmtCount = (n: number): string => String(n).padStart(2, " ");

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
      {/* Two columns of marker/count pairs on each line. Markers stay in
          column 1 (single glyph) so the eye can scan vertically. Labels
          and counts line up via fixed-width pads. */}
      <box height={1} flexDirection="row">
        <box width={32}>
          <text>
            <span fg={C.dim} attributes={A.bold}>
              {" ·  "}
            </span>
            <span fg={C.fgMuted}>{"built-in default     "}</span>
            <span fg={C.cyan} attributes={A.bold}>
              {fmtCount(defaults)}
            </span>
          </text>
        </box>
        <box>
          <text>
            <span fg={C.green} attributes={A.bold}>
              {"  •  "}
            </span>
            <span fg={C.fgMuted}>{"global custom        "}</span>
            <span fg={C.green} attributes={A.bold}>
              {fmtCount(globalCustom)}
            </span>
          </text>
        </box>
      </box>
      <box height={1} flexDirection="row">
        <box width={32}>
          <text>
            <span fg={C.yellow} attributes={A.bold}>
              {" ★  "}
            </span>
            <span fg={C.fgMuted}>{"override of default  "}</span>
            <span fg={C.yellow} attributes={A.bold}>
              {fmtCount(globalOverrides)}
            </span>
          </text>
        </box>
        <box>
          <text>
            <span fg={C.cyan} attributes={A.bold}>
              {"  ▴  "}
            </span>
            <span fg={C.fgMuted}>{"project rule         "}</span>
            <span fg={C.cyan} attributes={A.bold}>
              {fmtCount(projectRules.length)}
            </span>
          </text>
        </box>
      </box>
    </box>
  );
}
