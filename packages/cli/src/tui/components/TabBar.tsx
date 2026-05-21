/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { TABS_H } from "../constants.js";
import type { Tab } from "../types.js";

interface TabBarProps {
  activeTab: Tab;
  statusMsg: string | null;
  width: number;
}

export function TabBar({ activeTab, statusMsg, width }: TabBarProps) {
  const tabs: Array<{ label: string; value: Tab; num: string }> = [
    { label: "Providers", value: "providers", num: "1" },
    { label: "Profiles", value: "profiles", num: "2" },
    { label: "Routing", value: "routing", num: "3" },
    { label: "Privacy", value: "privacy", num: "4" },
  ];

  // Collapse newlines + extra whitespace so the status message stays one
  // line. The host box uses flex layout to clip overflow; we don't compute
  // the truncation point ourselves.
  const statusText = (statusMsg ?? "").replace(/\s+/g, " ").trim();

  return (
    <box height={TABS_H} flexDirection="column" backgroundColor={C.bg}>
      {/* Tab buttons row — use box-level backgroundColor for unmistakable tab highlighting */}
      <box height={1} flexDirection="row">
        <box width={1} height={1} backgroundColor={C.bg} />
        {tabs.map((t, i) => {
          const active = activeTab === t.value;
          return (
            <box key={t.value} flexDirection="row" height={1}>
              {i > 0 && <box width={2} height={1} backgroundColor={C.bg} />}
              <box
                height={1}
                backgroundColor={active ? C.tabActiveBg : C.tabInactiveBg}
                paddingX={1}
              >
                <text>
                  <span fg={active ? C.tabActiveFg : C.tabInactiveFg} bold>
                    {`${t.num}. ${t.label}`}
                  </span>
                </text>
              </box>
            </box>
          );
        })}
      </box>
      {/* Separator line */}
      <box height={1} paddingX={1}>
        <text>
          <span fg={C.tabActiveBg}>{"─".repeat(Math.max(0, width - 2))}</span>
        </text>
      </box>
      {/* Status line — sits on the otherwise-blank row beneath the separator.
          Moved here from the tab-buttons row so long error messages have the
          full content width and don't share real estate with the tabs.
          flexGrow makes the box claim the full row; OpenTUI's height={1}
          clips wrapping, and overflow="hidden" prevents wrap-out spill. */}
      <box height={1} flexGrow={1} paddingX={1} backgroundColor={C.bg} overflow="hidden">
        {statusMsg && (
          <text>
            <span fg={C.dim}>{"─  "}</span>
            <span
              fg={
                statusMsg.startsWith("Key saved") ||
                statusMsg.startsWith("Rule added") ||
                statusMsg.startsWith("Endpoint") ||
                statusMsg.startsWith("Telemetry") ||
                statusMsg.startsWith("Usage") ||
                statusMsg.startsWith("Stats buffer") ||
                statusMsg.startsWith("Profile") ||
                statusMsg.startsWith("Key removed")
                  ? C.green
                  : C.yellow
              }
              bold
            >
              {statusText}
            </span>
          </text>
        )}
      </box>
    </box>
  );
}
