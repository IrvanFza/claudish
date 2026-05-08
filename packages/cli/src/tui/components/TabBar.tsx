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
        {statusMsg && (
          <box height={1} backgroundColor={C.bg} paddingX={1}>
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
                {statusMsg}
              </span>
            </text>
          </box>
        )}
      </box>
      {/* Separator line */}
      <box height={1} paddingX={1}>
        <text>
          <span fg={C.tabActiveBg}>{"─".repeat(Math.max(0, width - 2))}</span>
        </text>
      </box>
      {/* Spacer */}
      <box height={1} />
    </box>
  );
}
