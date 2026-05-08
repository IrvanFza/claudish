/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import type { Tab } from "../types.js";

function bytesHuman(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

interface PrivacyContentProps {
  activeTab: Tab;
  telemetryEnabled: boolean;
  statsEnabled: boolean;
  bufStats: { events: number; bytes: number };
  width: number;
  contentH: number;
}

export function PrivacyContent({
  activeTab,
  telemetryEnabled,
  statsEnabled,
  bufStats,
  width,
  contentH,
}: PrivacyContentProps) {
  const halfW = Math.floor((width - 4) / 2);
  const cardH = Math.max(7, contentH - 1);

  return (
    <box height={contentH} flexDirection="row" backgroundColor={C.bg} paddingX={1}>
      {/* Telemetry card */}
      <box
        width={halfW}
        height={cardH}
        border
        borderStyle="single"
        borderColor={activeTab === "privacy" ? C.blue : C.dim}
        title=" Telemetry "
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.blue} bold>
            Status:{" "}
          </span>
          {telemetryEnabled ? (
            <span fg={C.green} bold>
              ● Enabled
            </span>
          ) : (
            <span fg={C.fgMuted}>○ Disabled</span>
          )}
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>Collects anonymized platform info and</span>
        </text>
        <text>
          <span fg={C.fgMuted}>sanitized error types to improve claudish.</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.white} bold>
            Never sends keys, prompts, or paths.
          </span>
        </text>
        <text> </text>
        <text>
          <span fg={C.dim}>Press [</span>
          <span fg={C.green} bold>
            t
          </span>
          <span fg={C.dim}>] to toggle.</span>
        </text>
      </box>

      {/* Usage stats card */}
      <box
        width={width - 4 - halfW}
        height={cardH}
        border
        borderStyle="single"
        borderColor={activeTab === "privacy" ? C.blue : C.dim}
        title=" Usage Stats "
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.blue} bold>
            Status:{" "}
          </span>
          {statsEnabled ? (
            <span fg={C.green} bold>
              ● Enabled
            </span>
          ) : (
            <span fg={C.fgMuted}>○ Disabled</span>
          )}
        </text>
        <text>
          <span fg={C.blue} bold>
            Buffer:{" "}
          </span>
          <span fg={C.white} bold>
            {bufStats.events}
          </span>
          <span fg={C.fgMuted}> events (</span>
          <span fg={C.yellow}>{bytesHuman(bufStats.bytes)}</span>
          <span fg={C.fgMuted}>)</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>Collects local, anonymous stats on model</span>
        </text>
        <text>
          <span fg={C.fgMuted}>usage, latency, and token counts.</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.dim}>Press [</span>
          <span fg={C.green} bold>
            u
          </span>
          <span fg={C.dim}>] to toggle, [</span>
          <span fg={C.red} bold>
            c
          </span>
          <span fg={C.dim}>] to clear buffer.</span>
        </text>
      </box>
    </box>
  );
}
