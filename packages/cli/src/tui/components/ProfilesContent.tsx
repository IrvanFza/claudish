/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import { PROVIDER_PREFIXES } from "../constants.js";
import { loadLocalConfig } from "../../profile-config.js";
import type { ClaudishProfileConfig, ModelMapping } from "../../profile-config.js";
import type { Mode, Tab } from "../types.js";

interface ProfilesContentProps {
  config: ClaudishProfileConfig;
  activeTab: Tab;
  mode: Mode;
  profileScope: "global" | "project";
  profileIndex: number;
  editProfileName: string;
  editProfileValue: string;
  suggestions: string[];
  suggestionIndex: number;
  providerPickerIndex: number;
  width: number;
  contentH: number;
}

export function ProfilesContent({
  config,
  activeTab,
  mode,
  profileScope,
  profileIndex,
  editProfileName,
  editProfileValue,
  suggestions,
  suggestionIndex,
  providerPickerIndex,
  contentH,
}: ProfilesContentProps) {
  const isProfileEditMode =
    mode === "new_profile" ||
    mode === "pick_profile_scope" ||
    mode === "pick_provider_prefix" ||
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent";

  const globalCfg = config;
  const localCfg = loadLocalConfig();
  const localProfileNames = localCfg
    ? new Set(Object.keys(localCfg.profiles))
    : new Set<string>();

  // Build unified list: local profiles first, then global
  const allEntries: Array<{
    name: string;
    scope: "local" | "global";
    models: ModelMapping;
  }> = [];
  if (localCfg) {
    for (const [name, prof] of Object.entries(localCfg.profiles)) {
      allEntries.push({ name, scope: "local", models: prof.models });
    }
  }
  for (const [name, prof] of Object.entries(globalCfg.profiles)) {
    allEntries.push({ name, scope: "global", models: prof.models });
  }

  const activeProfileName = globalCfg.defaultProfile;
  const listH = contentH - 2;

  // Edit mode prompt
  const editPromptLabel =
    mode === "new_profile"
      ? `New ${profileScope} profile — name:`
      : mode === "pick_profile_scope"
        ? "Scope for new profile:"
        : mode === "pick_provider_prefix"
          ? "Select provider:"
          : mode === "edit_profile_opus"
            ? `${editProfileName} — opus model:`
            : mode === "edit_profile_sonnet"
              ? `${editProfileName} — sonnet model:`
              : mode === "edit_profile_haiku"
                ? `${editProfileName} — haiku model:`
                : mode === "edit_profile_subagent"
                  ? `${editProfileName} — subagent model (optional):`
                  : null;

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={activeTab === "profiles" && !isProfileEditMode ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Active profile indicator */}
      <text>
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.fgMuted}>Active profile: </span>
        <span fg={C.orange} attributes={A.bold}>
          {activeProfileName}
        </span>
      </text>
      {/* Column header */}
      <text>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>
          {"PROFILE         "}
        </span>
        <span fg={C.blue} attributes={A.bold}>
          {"SCOPE    "}
        </span>
        <span fg={C.blue} attributes={A.bold}>
          {"MODELS"}
        </span>
      </text>
      {/* Profile rows */}
      {allEntries.slice(0, Math.max(0, listH - 3)).map((entry, idx) => {
        const isActive = entry.name === activeProfileName;
        const selected = idx === profileIndex;
        const namePad = entry.name.padEnd(16).substring(0, 16);
        const scopePad = entry.scope.padEnd(8).substring(0, 8);
        const shadowed = entry.scope === "global" && localProfileNames.has(entry.name);

        const modelSummary =
          [
            entry.models.opus ? `opus→${entry.models.opus.substring(0, 14)}` : null,
            entry.models.sonnet ? `sonnet→${entry.models.sonnet.substring(0, 14)}` : null,
          ]
            .filter(Boolean)
            .join("  ") || "(auto-route)";

        return (
          <box
            key={`${entry.scope}-${entry.name}`}
            height={1}
            flexDirection="row"
            backgroundColor={selected ? C.bgHighlight : C.bg}
          >
            <text>
              <span fg={isActive ? C.orange : C.dim}>{isActive ? "●" : " "}</span>
              <span fg={C.dim}> </span>
              <span
                fg={selected ? C.white : isActive ? C.orange : C.fgMuted}
                attributes={A.boldIf(selected || isActive)}
              >
                {namePad}
              </span>
              <span fg={C.dim}>{"  "}</span>
              <span fg={entry.scope === "local" ? C.cyan : C.fgMuted}>{scopePad}</span>
              <span fg={C.dim}>{"  "}</span>
              <span fg={selected ? C.white : shadowed ? C.dim : C.fgMuted}>
                {shadowed ? "(shadowed by local)  " : modelSummary}
              </span>
            </text>
          </box>
        );
      })}

      {/* Local profiles note */}
      {!localCfg && (
        <text>
          <span fg={C.dim}>{"  No project-level profiles (.claudish.json)"}</span>
        </text>
      )}

      {/* Edit mode input */}
      {isProfileEditMode && editPromptLabel && (
        <box flexDirection="column" paddingTop={1}>
          <text>
            <span fg={C.blue} attributes={A.bold}>
              {editPromptLabel + " "}
            </span>
          </text>

          {/* Scope picker */}
          {mode === "pick_profile_scope" && (
            <box flexDirection="column">
              <box height={1} flexDirection="row">
                <box width={16} height={1} backgroundColor={C.bgHighlight} paddingX={1}>
                  <text>
                    <span fg={C.green} attributes={A.bold}>
                      g
                    </span>
                    <span fg={C.white}> global</span>
                  </text>
                </box>
                <box width={2} />
                <box width={16} height={1} paddingX={1}>
                  <text>
                    <span fg={C.cyan} attributes={A.bold}>
                      p
                    </span>
                    <span fg={C.fgMuted}> project (.claudish.json)</span>
                  </text>
                </box>
              </box>
              <text>
                <span fg={C.green} attributes={A.bold}>
                  g{" "}
                </span>
                <span fg={C.fgMuted}>global · </span>
                <span fg={C.cyan} attributes={A.bold}>
                  p{" "}
                </span>
                <span fg={C.fgMuted}>project · </span>
                <span fg={C.red} attributes={A.bold}>
                  Esc{" "}
                </span>
                <span fg={C.fgMuted}>cancel</span>
              </text>
            </box>
          )}

          {/* Provider prefix picker */}
          {mode === "pick_provider_prefix" && (
            <box flexDirection="column">
              {PROVIDER_PREFIXES.slice(0, 8).map((p, idx) => (
                <box
                  key={p.name}
                  height={1}
                  backgroundColor={idx === providerPickerIndex ? C.bgHighlight : C.bg}
                >
                  <text>
                    <span fg={idx === providerPickerIndex ? C.white : C.dim}> </span>
                    <span
                      fg={idx === providerPickerIndex ? C.cyan : C.fgMuted}
                      attributes={A.boldIf(idx === providerPickerIndex)}
                    >
                      {p.prefix.padEnd(14).substring(0, 14)}
                    </span>
                    <span fg={C.dim}>{"  "}</span>
                    <span fg={idx === providerPickerIndex ? C.fgMuted : C.dim}>
                      {p.displayName}
                    </span>
                  </text>
                </box>
              ))}
              <text>
                <span fg={C.blue} attributes={A.bold}>
                  ↑↓{" "}
                </span>
                <span fg={C.fgMuted}>navigate · </span>
                <span fg={C.green} attributes={A.bold}>
                  Enter{" "}
                </span>
                <span fg={C.fgMuted}>select prefix · </span>
                <span fg={C.red} attributes={A.bold}>
                  Esc{" "}
                </span>
                <span fg={C.fgMuted}>back</span>
              </text>
            </box>
          )}

          {/* Normal text input (not scope/provider picker) */}
          {mode !== "pick_profile_scope" && mode !== "pick_provider_prefix" && (
            <box flexDirection="column">
              <text>
                <span fg={C.green} attributes={A.bold}>
                  {"> "}
                </span>
                <span fg={editProfileValue === "auto" ? C.yellow : C.white}>
                  {editProfileValue}
                </span>
                <span fg={C.cyan}>{"█"}</span>
              </text>

              {/* Suggestion list */}
              {suggestions.length > 0 && (
                <box flexDirection="column">
                  {suggestions.map((s, idx) => {
                    const selected = idx === suggestionIndex;
                    // Highlight matching portion
                    const lower = editProfileValue.toLowerCase();
                    const matchIdx = lower ? s.toLowerCase().indexOf(lower) : -1;
                    return (
                      <box key={s} height={1} backgroundColor={selected ? C.bgHighlight : C.bg}>
                        <text>
                          <span fg={selected ? C.dim : C.dim}>{"  "}</span>
                          {matchIdx >= 0 && lower ? (
                            <>
                              <span fg={selected ? C.fgMuted : C.dim}>
                                {s.substring(0, matchIdx)}
                              </span>
                              <span fg={selected ? C.white : C.cyan} attributes={A.bold}>
                                {s.substring(matchIdx, matchIdx + lower.length)}
                              </span>
                              <span fg={selected ? C.fgMuted : C.dim}>
                                {s.substring(matchIdx + lower.length)}
                              </span>
                            </>
                          ) : (
                            <span fg={selected ? C.white : C.fgMuted}>{s}</span>
                          )}
                        </text>
                      </box>
                    );
                  })}
                </box>
              )}

              {editProfileValue === "auto" ? (
                <text>
                  <span fg={C.yellow} attributes={A.bold}>
                    auto-route{" "}
                  </span>
                  <span fg={C.fgMuted}>— claudish will use the routing table · </span>
                  <span fg={C.green} attributes={A.bold}>
                    Enter{" "}
                  </span>
                  <span fg={C.fgMuted}>to confirm · </span>
                  <span fg={C.red} attributes={A.bold}>
                    Esc{" "}
                  </span>
                  <span fg={C.fgMuted}>cancel</span>
                </text>
              ) : (
                <text>
                  <span fg={C.green} attributes={A.bold}>
                    Enter{" "}
                  </span>
                  <span fg={C.fgMuted}>save · </span>
                  <span fg={C.blue} attributes={A.bold}>
                    Tab{" "}
                  </span>
                  <span fg={C.fgMuted}>
                    {editProfileValue === "" ? "pick provider · " : "autocomplete · "}
                  </span>
                  <span fg={C.blue} attributes={A.bold}>
                    ↑↓{" "}
                  </span>
                  <span fg={C.fgMuted}>suggestion · </span>
                  <span fg={C.yellow} attributes={A.bold}>
                    a{" "}
                  </span>
                  <span fg={C.fgMuted}>auto-route · </span>
                  <span fg={C.red} attributes={A.bold}>
                    Esc{" "}
                  </span>
                  <span fg={C.fgMuted}>cancel</span>
                </text>
              )}
            </box>
          )}
        </box>
      )}
    </box>
  );
}
