/** @jsxImportSource @opentui/react */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadConfig,
  loadLocalConfig,
  disableLocalProvider,
  enableLocalProvider,
  isLocalProviderEnabled,
  removeApiKey,
  removeEndpoint,
  saveConfig,
  saveLocalConfig,
  setApiKey,
  setEndpoint,
} from "../profile-config.js";
import { DEFAULT_ROUTING_RULES } from "../providers/default-routing-rules.js";
import { getProviderByName } from "../providers/provider-definitions.js";
import {
  discoverProbeModelFromEndpoint,
  ensureProbeModelsCached,
  getProbeModel,
} from "../providers/probe-catalog.js";
import { invalidateProbeDiscovery } from "../providers/transport/probe-discovery.js";
import { describeProbeState } from "../providers/probe-live.js";
import { probeProviderRoute } from "../providers/probe-runner.js";
import { clearBuffer, getBufferStats } from "../stats-buffer.js";
import {
  ensureProbeProxy,
  invalidateProbeProxyHandlers,
  isProbeProxyReady,
} from "./probe-proxy.js";
import {
  PROVIDERS,
  maskKey,
  providerAuthCapabilities,
  providerIsReady,
  type ProviderDef,
} from "./providers.js";
import { A, C } from "./theme.js";
import {
  CHAIN_PROVIDERS,
  HEADER_H,
  TABS_H,
  FOOTER_H,
  DETAIL_H,
  VERSION,
} from "./constants.js";
import type { MergedRule, Mode, RoutingScope, Tab, TestResultsMap } from "./types.js";
import { useRouteProbe } from "./hooks/useRouteProbe.js";
import { useProfileWizard } from "./hooks/useProfileWizard.js";
import { TabBar } from "./components/TabBar.js";
import { Footer } from "./components/Footer.js";
import { ProvidersContent } from "./components/ProvidersContent.js";
import { ProviderDetail } from "./components/ProviderDetail.js";
import { ProfilesContent } from "./components/ProfilesContent.js";
import { ProfileDetail } from "./components/ProfileDetail.js";
import { RoutingContent } from "./components/RoutingContent.js";
import { RoutingDetail } from "./components/RoutingDetail.js";
import { PrivacyContent } from "./components/PrivacyContent.js";
import { PrivacyDetail } from "./components/PrivacyDetail.js";

interface AppProps {
  /**
   * Called from the Providers tab `l` handler. The wrapper in
   * tui/index.tsx records the requested slug, then after the renderer
   * is destroyed it spawns `claudish login {slug}` as a child process
   * and re-enters startConfigTui when the child exits. App.tsx just
   * signals intent; lifecycle is the wrapper's responsibility.
   */
  requestLogin?: (slug: "gemini" | "codex" | "kimi") => void;
}

export function App({ requestLogin }: AppProps = {}) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [config, setConfig] = useState(() => loadConfig());
  const [bufStats, setBufStats] = useState(() => getBufferStats());
  const [providerIndex, setProviderIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("providers");
  const [mode, setMode] = useState<Mode>("browse");
  const [inputValue, setInputValue] = useState("");
  const [routingPattern, setRoutingPattern] = useState("");
  const [chainSelected, setChainSelected] = useState<Set<string>>(new Set());
  const [chainOrder, setChainOrder] = useState<string[]>([]);
  const [chainCursor, setChainCursor] = useState(0);
  // Routing scope wizard state. `routingScope` carries the user's `g`/`p`
  // choice from `pick_routing_scope` into `add_routing_chain`'s save logic.
  // `routingScopeReturnsToEdit=true` when entering the chain builder via
  // `e` (edit existing rule), so the picker is skipped and the rule's own
  // scope is used (edit-in-place semantics, matching Profiles wizard).
  const [routingScope, setRoutingScope] = useState<RoutingScope>("global");
  // Cursor for the scope picker menu. 0 = global, 1 = project. Mirrors the
  // chain-selector navigation pattern (↑↓ + Enter) instead of g/p shortcuts.
  const [routingScopeCursor, setRoutingScopeCursor] = useState<0 | 1>(0);
  const [routingScopeReturnsToEdit, setRoutingScopeReturnsToEdit] = useState(false);
  // When `e` is pressed on an existing user/project rule, these track WHICH
  // rule we're editing. If the user picks a DIFFERENT scope in the picker,
  // the save path also deletes the old rule (effectively a move). For new
  // rules (a) and overrides of defaults (e on default), both are null.
  const [editingExistingScope, setEditingExistingScope] = useState<RoutingScope | null>(null);
  const [editingExistingPattern, setEditingExistingPattern] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResultsMap>({});
  const [animTick, setAnimTick] = useState(0);
  const anyTesting = useMemo(
    () => Object.values(testResults).some((r) => r?.status === "testing"),
    [testResults]
  );

  useEffect(() => {
    if (!anyTesting) return;
    const id = setInterval(() => setAnimTick((tick) => (tick + 1) % 1_000_000), 90);
    return () => clearInterval(id);
  }, [anyTesting]);

  // Profile tab state — only the cursor is owned by App. The rest of the
  // profile-edit wizard state lives in useProfileWizard.
  const [profileIndex, setProfileIndex] = useState(0);

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  // Sort: configured providers first (env/cfg key OR OAuth credentials),
  // then unconfigured. Original order preserved within each group.
  const displayProviders = useMemo(() => {
    return [...PROVIDERS].sort((a, b) => {
      const aReady = providerIsReady(a, config);
      const bReady = providerIsReady(b, config);
      if (aReady === bReady) return PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b);
      return aReady ? -1 : 1;
    });
  }, [config]);

  const selectedProvider = displayProviders[providerIndex]!;
  const selectedProviderDef = getProviderByName(selectedProvider.catalogName);
  const selectedProviderIsLocal = !!(selectedProvider.isLocal || selectedProviderDef?.isLocal);
  const selectedLocalEnabled =
    selectedProviderIsLocal && isLocalProviderEnabled(selectedProvider.catalogName, config);
  const refreshConfig = useCallback(() => {
    setConfig(loadConfig());
    setBufStats(getBufferStats());
  }, []);

  // Route probe wizard — owns probeMode/probeModel/probeResults internally.
  // The keyboard handler delegates to verb methods (startInput, submit, etc.).
  const probe = useRouteProbe(config);
  const { probeMode, probeModel, probeResults } = probe;

  // Profile editor wizard — owns editProfileName/Value, profileScope,
  // suggestions/suggestionIndex, providerPickerIndex, and the
  // (intentionally hook-internal) providerPickerReturnMode. The keyboard
  // handler dispatches verb methods; the hook flips parent `mode` for its
  // visible sub-states.
  const wizard = useProfileWizard({ mode, setMode, refreshConfig, setStatusMsg });
  const {
    editProfileName,
    editProfileValue,
    profileScope,
    suggestions,
    suggestionIndex,
    providerPickerIndex,
  } = wizard;

  const hasCfgKey = !!config.apiKeys?.[selectedProvider.apiKeyEnvVar];
  const hasEnvKey = !!process.env[selectedProvider.apiKeyEnvVar];
  const hasKey = hasCfgKey || hasEnvKey || selectedLocalEnabled;
  const cfgKeyMask = maskKey(config.apiKeys?.[selectedProvider.apiKeyEnvVar]);
  const envKeyMask = maskKey(process.env[selectedProvider.apiKeyEnvVar]);
  const activeEndpointEnvVar = selectedProvider.endpointEnvVar;
  const activeEndpointFromConfig = activeEndpointEnvVar
    ? config.endpoints?.[activeEndpointEnvVar]
    : undefined;
  const activeEndpointFromEnv = selectedProvider.endpointEnvVars
    ?.map((envVar) => process.env[envVar])
    .find((value): value is string => !!value);
  const activeEndpoint =
    activeEndpointFromConfig ||
    activeEndpointFromEnv ||
    selectedProvider.defaultEndpoint ||
    "";

  const telemetryEnabled =
    process.env.CLAUDISH_TELEMETRY !== "0" &&
    process.env.CLAUDISH_TELEMETRY !== "false" &&
    config.telemetry?.enabled === true;

  const statsDisabledByEnv =
    process.env.CLAUDISH_STATS === "0" || process.env.CLAUDISH_STATS === "false";
  const statsEnabled = !statsDisabledByEnv && config.stats?.enabled === true;

  // Merged routing rules: built-in defaults + global config + project-local
  // config rendered as a flat list with NO shadowing. If a pattern exists at
  // multiple layers (e.g. a global override AND a project rule for `gpt-*`),
  // BOTH rows are visible — the user can edit/delete each independently.
  //
  // The runtime routing engine (loadRoutingRules + matchRoutingRule) still
  // applies precedence (project beats global beats default), but the TUI
  // shows the data as it exists on disk, not the runtime resolution.
  //
  // Catch-all `*` is rendered separately above the table and excluded here.
  //
  // Sort order: defaults first (alphabetical), then global, then project.
  // `loadLocalConfig()` is called inside the memo so a `refreshConfig()`
  // after a project save triggers re-derivation.
  const mergedRules: MergedRule[] = useMemo(() => {
    const out: MergedRule[] = [];
    const localCfg = loadLocalConfig();

    for (const [pat, chain] of Object.entries(DEFAULT_ROUTING_RULES)) {
      if (pat === "*") continue;
      out.push({ kind: "default", pattern: pat, chain, overridesDefault: false });
    }
    for (const [pat, chain] of Object.entries(config.routing ?? {})) {
      if (pat === "*") continue;
      out.push({
        kind: "global",
        pattern: pat,
        chain,
        overridesDefault: pat in DEFAULT_ROUTING_RULES,
      });
    }
    if (localCfg?.routing) {
      for (const [pat, chain] of Object.entries(localCfg.routing)) {
        if (pat === "*") continue;
        out.push({
          kind: "project",
          pattern: pat,
          chain,
          overridesDefault: pat in DEFAULT_ROUTING_RULES,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.routing, JSON.stringify(loadLocalConfig()?.routing ?? {})]);
  const profileName = config.defaultProfile || "default";

  const readyCount = PROVIDERS.filter(
    (p) => !!(config.apiKeys?.[p.apiKeyEnvVar] || process.env[p.apiKeyEnvVar])
  ).length;

  /**
   * Run a single provider's connectivity test via the shared probe proxy.
   *
   * Flips testResults[prov.name] to "testing", lazily ensures the proxy is
   * running, then sends a 1-token probe through the same stack
   * `claudish --probe` uses. The proxy resolves credentials uniformly across
   * env / config / OAuth — so this is a true "will it work?" answer for any
   * auth method.
   *
   * Returns silently after writing the final TestResult, so callers can fire
   * a batch of these in parallel without awaiting.
   */
  const runProbeTest = useCallback(async (prov: ProviderDef): Promise<void> => {
    const provName = prov.name;

    setTestResults((prev) => ({ ...prev, [provName]: { status: "testing" } }));
    const outcome = await ensureProbeModelsCached();
    if (outcome.kind !== "ok") {
      setTestResults((prev) => ({
        ...prev,
        [provName]: {
          status: "failed",
          error: `could not reach model catalog (${outcome.kind})`,
        },
      }));
      return;
    }

    const startMs = Date.now();
    try {
      const proxyUrl = await ensureProbeProxy();
      const catalogModel = getProbeModel(prov.catalogName);
      // Models that already failed this round — passed to discovery so we
      // get the NEXT candidate, not the same one again.
      const tried = new Set<string>();
      const MAX_ATTEMPTS = 3;
      let lastResult: import("../providers/probe-live.js").ProbeResult | null = null;
      let lastDiscoveryReason: string | undefined;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let testModel: string | null = null;
        // On the first attempt, the cloud catalog's pick wins. On retries,
        // the cloud catalog is exhausted (it returns one model) so we always
        // walk the endpoint's own list via discovery.
        if (attempt === 0 && catalogModel && !tried.has(catalogModel)) {
          testModel = catalogModel;
        } else {
          const discovery = await discoverProbeModelFromEndpoint(
            proxyUrl,
            prov.catalogName,
            tried
          );
          testModel = discovery.model;
          lastDiscoveryReason = discovery.reason;
        }
        if (!testModel) break;

        tried.add(testModel);
        const result = await probeProviderRoute(
          proxyUrl,
          {
            provider: prov.catalogName,
            modelSpec: testModel,
            // Let the shared probe path and proxy resolve credentials (env,
            // cfg, OAuth). The live request is the source of truth.
            hasCredentials: true,
          },
          15000
        );
        lastResult = result;

        if (result.state === "live" || result.state === "rate-limited") break;
        // Retry on per-model failures (the next candidate might work).
        // Don't retry on transport-level failures (auth/network/timeout) —
        // those won't get better by changing model.
        const retryable =
          result.state === "model-not-found" || result.state === "error";
        if (!retryable) break;
      }

      const ms = Date.now() - startMs;
      if (!lastResult) {
        // Discovery never produced even one model.
        setTestResults((prev) => ({
          ...prev,
          [provName]: {
            status: "failed",
            error: lastDiscoveryReason
              ? `no probe model: ${lastDiscoveryReason}`
              : "no probe model available",
            ms,
          },
        }));
        return;
      }
      const result = lastResult;
      if (result.state === "live") {
        setTestResults((prev) => ({ ...prev, [provName]: { status: "valid", ms } }));
      } else if (result.state === "rate-limited") {
        // 429 proves auth+endpoint+model are all reachable — the only thing
        // wrong is the user's current request rate. Treat as healthy, just
        // annotate so the user knows why latency is high right now.
        setTestResults((prev) => ({
          ...prev,
          [provName]: { status: "valid", ms, note: "throttled" },
        }));
      } else {
        const baseError = describeProbeState(result);
        const error =
          tried.size > 1
            ? `${baseError} (tried ${tried.size} models)`
            : baseError;
        setTestResults((prev) => ({
          ...prev,
          [provName]: { status: "failed", error, ms },
        }));
      }
    } catch (err: unknown) {
      const ms = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      setTestResults((prev) => ({
        ...prev,
        [provName]: { status: "failed", error: `proxy: ${msg}`, ms },
      }));
    }
  }, []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();

    // Probe input mode — handled independently of main mode (non-blocking).
    // Delegates to useRouteProbe verb methods. Note: probe.submit() kicks off
    // an async test loop that does NOT abort on cancel — see the hook comment.
    if (probeMode === "input") {
      if (key.name === "return" || key.name === "enter") {
        probe.submit();
      } else if (key.name === "escape") {
        probe.cancel();
      } else if (key.name === "backspace" || key.name === "delete") {
        probe.backspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        probe.typeChar(key.raw);
      }
      return;
    }

    // Probe running/done — handle keys before normal routing handlers
    if (probeMode === "running" && activeTab === "routing") {
      if (key.name === "escape") {
        probe.cancel();
      }
      // Block all other keys while running
      return;
    }

    if (probeMode === "done" && activeTab === "routing") {
      if (key.name === "q") {
        return quit();
      } else if (key.name === "escape" || key.name === "p") {
        // Return to normal routing view
        probe.cancel();
      } else if (key.name === "return" || key.name === "enter") {
        // Start a new probe
        probe.enterFromDone();
      }
      return;
    }

    // Input modes
    if (mode === "input_key" || mode === "input_endpoint") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          return;
        }
        if (mode === "input_key") {
          if (!selectedProvider.apiKeyEnvVar) {
            setStatusMsg(
              `${selectedProvider.displayName} has no apiKeyEnvVar — cannot save key.`
            );
          } else {
            setApiKey(selectedProvider.apiKeyEnvVar, val);
            process.env[selectedProvider.apiKeyEnvVar] = val;
            setStatusMsg(
              `Key saved for ${selectedProvider.displayName} (${selectedProvider.apiKeyEnvVar}).`
            );
          }
        } else {
          if (!selectedProvider.endpointEnvVar) {
            setStatusMsg(
              `${selectedProvider.displayName} has no endpointEnvVar — cannot save URL.`
            );
          } else {
            setEndpoint(selectedProvider.endpointEnvVar, val);
            process.env[selectedProvider.endpointEnvVar] = val;
            setStatusMsg(
              `URL saved for ${selectedProvider.displayName} (${selectedProvider.endpointEnvVar}=${val}).`
            );
          }
        }
        // Drop stale caches so the next probe picks up the new URL/key.
        // Without this the probe-proxy keeps using a pre-built transport
        // pointing at the old endpoint, and discovery returns the cached
        // model lookup keyed by the old URL.
        invalidateProbeProxyHandlers(selectedProvider.catalogName);
        invalidateProbeDiscovery(selectedProvider.catalogName);
        refreshConfig();
        setInputValue("");
        setMode("browse");
      } else if (key.name === "escape") {
        setInputValue("");
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_pattern") {
      if (key.name === "return" || key.name === "enter") {
        if (routingPattern.trim()) {
          setChainSelected(new Set());
          setChainCursor(0);
          setChainOrder([]);
          // For NEW rules (a from browse) advance to scope picker. For
          // overrides invoked from `e` on a default, the picker is also
          // needed (the user is creating a fresh user rule). The flag
          // routingScopeReturnsToEdit=true is set ONLY on `e` of an
          // existing user rule (global or project) — those already know
          // their scope and skip the picker entirely.
          if (routingScopeReturnsToEdit) {
            setMode("add_routing_chain");
          } else {
            setRoutingScopeCursor(0);
            setMode("pick_routing_scope");
          }
        }
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setMode("browse");
      } else if (key.name === "backspace" || key.name === "delete") {
        setRoutingPattern((p) => p.slice(0, -1));
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setRoutingPattern((p) => p + key.raw);
      }
      return;
    }

    // Routing scope picker — menu-style navigation (↑↓ + Enter), matching the
    // chain selector and Providers tab. Letter shortcuts (g/p) still work as
    // silent accelerators for users who learned the prior version, but the
    // primary interaction is the menu and the footer advertises that.
    if (mode === "pick_routing_scope") {
      if (key.name === "up" || key.name === "k") {
        setRoutingScopeCursor((i) => (i === 0 ? 0 : 0));
      } else if (key.name === "down" || key.name === "j") {
        setRoutingScopeCursor((i) => (i === 0 ? 1 : 1));
      } else if (key.name === "return" || key.name === "enter") {
        setRoutingScope(routingScopeCursor === 0 ? "global" : "project");
        setMode("add_routing_chain");
      } else if (key.raw === "g" || key.raw === "G") {
        // Silent accelerator — picks AND commits in one keystroke.
        setRoutingScope("global");
        setMode("add_routing_chain");
      } else if (key.raw === "p" || key.raw === "P") {
        setRoutingScope("project");
        setMode("add_routing_chain");
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setRoutingScopeCursor(0);
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_chain") {
      if (key.name === "up" || key.name === "k") {
        setChainCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setChainCursor((i) => Math.min(CHAIN_PROVIDERS.length - 1, i + 1));
      } else if (key.name === "space" || key.raw === " ") {
        // Toggle: add to end or remove
        const prov = CHAIN_PROVIDERS[chainCursor];
        if (prov.isLocal && !providerIsReady(prov, config)) {
          setStatusMsg(`${prov.displayName} is disabled. Enable it in Providers first.`);
          return;
        }
        const provName = prov.name;
        setChainSelected((prev) => {
          const next = new Set(prev);
          if (next.has(provName)) {
            next.delete(provName);
            setChainOrder((o) => o.filter((p) => p !== provName));
          } else {
            next.add(provName);
            setChainOrder((o) => [...o, provName]);
          }
          return next;
        });
      } else if (key.raw && key.raw >= "1" && key.raw <= "9") {
        // Number key: move current provider to that position in chain
        const prov = CHAIN_PROVIDERS[chainCursor];
        if (prov.isLocal && !providerIsReady(prov, config)) {
          setStatusMsg(`${prov.displayName} is disabled. Enable it in Providers first.`);
          return;
        }
        const provName = prov.name;
        const targetPos = parseInt(key.raw, 10) - 1; // 0-indexed
        setChainSelected((prev) => {
          const next = new Set(prev);
          next.add(provName);
          return next;
        });
        setChainOrder((prev) => {
          const without = prev.filter((p) => p !== provName);
          const insertAt = Math.min(targetPos, without.length);
          without.splice(insertAt, 0, provName);
          return without;
        });
      } else if (key.name === "return" || key.name === "enter") {
        const pat = routingPattern.trim();
        if (pat && chainOrder.length) {
          // Move detection: if `e` was used on an existing rule AND the user
          // picked a different scope in the picker, write to the new scope
          // and delete from the old one. Otherwise this is a plain update
          // or a fresh add — just write.
          const isMove =
            editingExistingScope !== null &&
            editingExistingScope !== routingScope &&
            editingExistingPattern === pat;

          if (routingScope === "project") {
            const local = loadLocalConfig() ?? {
              version: "1.0.0",
              defaultProfile: "",
              profiles: {},
            };
            if (!local.routing) local.routing = {};
            local.routing[pat] = chainOrder;
            saveLocalConfig(local);
          } else {
            const cfg = loadConfig();
            if (!cfg.routing) cfg.routing = {};
            cfg.routing[pat] = chainOrder;
            saveConfig(cfg);
          }
          if (isMove && editingExistingScope === "global") {
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[pat] !== undefined) {
              delete cfg.routing[pat];
              saveConfig(cfg);
            }
            setStatusMsg(`Rule moved global → project: ${pat}`);
          } else if (isMove && editingExistingScope === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[pat] !== undefined) {
              delete local.routing[pat];
              saveLocalConfig(local);
            }
            setStatusMsg(`Rule moved project → global: ${pat}`);
          } else if (routingScope === "project") {
            setStatusMsg(`Project rule saved: ${pat} → ${chainOrder.join(", ")}`);
          } else {
            setStatusMsg(`Global rule saved: ${pat} → ${chainOrder.join(", ")}`);
          }
          refreshConfig();
        }
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // Reset scope state for the next add cycle.
        setRoutingScope("global");
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      } else if (key.name === "escape") {
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // If we entered the chain builder via `e` on an existing rule, the
        // pattern is fixed — go straight to browse. For fresh adds, fall
        // back to pattern input so the user can fix the pattern.
        if (routingScopeReturnsToEdit) {
          setRoutingPattern("");
          setRoutingScope("global");
          setRoutingScopeReturnsToEdit(false);
          setEditingExistingScope(null);
          setEditingExistingPattern(null);
          setMode("browse");
        } else {
          setMode("add_routing_pattern");
        }
      }
      return;
    }

    // Profile wizard: scope picker (g = global, p = project)
    if (mode === "pick_profile_scope") {
      if (key.raw === "g" || key.raw === "G") {
        wizard.pickScope("global");
      } else if (key.raw === "p" || key.raw === "P") {
        wizard.pickScope("project");
      } else if (key.name === "escape") {
        wizard.cancelPickScope();
      }
      return;
    }

    // Profile wizard: new profile name input
    if (mode === "new_profile") {
      if (key.name === "return" || key.name === "enter") {
        wizard.newProfileSubmit();
      } else if (key.name === "escape") {
        wizard.newProfileEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.newProfileBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.newProfileTypeChar(key.raw);
      }
      return;
    }

    // Profile wizard: provider prefix picker (side-trip from edit fields)
    if (mode === "pick_provider_prefix") {
      if (key.name === "up" || key.name === "k") {
        wizard.prefixPickerUp();
      } else if (key.name === "down" || key.name === "j") {
        wizard.prefixPickerDown();
      } else if (key.name === "return" || key.name === "enter") {
        wizard.prefixPickerSubmit();
      } else if (key.name === "escape") {
        wizard.prefixPickerCancel();
      }
      return;
    }

    // Profile wizard: edit model role fields (opus → sonnet → haiku → subagent)
    if (
      mode === "edit_profile_opus" ||
      mode === "edit_profile_sonnet" ||
      mode === "edit_profile_haiku" ||
      mode === "edit_profile_subagent"
    ) {
      if (key.name === "return" || key.name === "enter") {
        wizard.editFieldSubmit();
      } else if (key.name === "tab") {
        wizard.editFieldTab();
      } else if (key.name === "up" || key.name === "k") {
        wizard.editFieldUp();
      } else if (key.name === "down" || key.name === "j") {
        wizard.editFieldDown();
      } else if (key.name === "escape") {
        wizard.editFieldEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.editFieldBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.editFieldTypeChar(key.raw);
      }
      return;
    }

    // Browse mode
    if (key.name === "q") return quit();

    if (key.name === "tab") {
      const tabs: Tab[] = ["providers", "profiles", "routing", "privacy"];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx + 1) % tabs.length]!);
      setStatusMsg(null);
      return;
    }

    // Number keys switch tabs directly
    if (key.name === "1") {
      setActiveTab("providers");
      setStatusMsg(null);
      return;
    }
    if (key.name === "2") {
      setActiveTab("profiles");
      setStatusMsg(null);
      return;
    }
    if (key.name === "3") {
      setActiveTab("routing");
      setStatusMsg(null);
      return;
    }
    if (key.name === "4") {
      setActiveTab("privacy");
      setStatusMsg(null);
      return;
    }

    if (activeTab === "providers") {
      if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(displayProviders.length - 1, i + 1));
        setStatusMsg(null);
      } else if (key.name === "s") {
        if (selectedProvider.apiKeyEnvVar) {
          setInputValue("");
          setStatusMsg(null);
          setMode("input_key");
        } else if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg(`${selectedProvider.displayName} has no API-key setup.`);
        }
      } else if (key.name === "e") {
        if (selectedProviderIsLocal) {
          if (selectedLocalEnabled) {
            disableLocalProvider(selectedProvider.catalogName);
            setStatusMsg(`${selectedProvider.displayName} disabled in global config.`);
          } else {
            enableLocalProvider(selectedProvider.catalogName);
            setStatusMsg(`${selectedProvider.displayName} enabled in global config.`);
          }
          refreshConfig();
        } else if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no custom endpoint.");
        }
      } else if (key.name === "u") {
        // Edit URL for any provider that has a configurable endpoint.
        // For local providers `e` is taken by the enable/disable toggle, so
        // `u` is the consistent way to edit the URL across all provider types.
        if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no editable URL.");
        }
      } else if (key.name === "x") {
        let changed = false;
        if (hasCfgKey) {
          removeApiKey(selectedProvider.apiKeyEnvVar);
          changed = true;
        }
        if (activeEndpointEnvVar && config.endpoints?.[activeEndpointEnvVar]) {
          removeEndpoint(activeEndpointEnvVar);
          delete process.env[activeEndpointEnvVar];
          changed = true;
        }
        if (changed) {
          invalidateProbeProxyHandlers(selectedProvider.catalogName);
          invalidateProbeDiscovery(selectedProvider.catalogName);
          refreshConfig();
          setStatusMsg(`Stored config removed for ${selectedProvider.displayName}.`);
        } else {
          setStatusMsg("No stored config to remove.");
        }
      } else if (key.name === "l") {
        // OAuth login for the selected provider. Signal the wrapper
        // (tui/index.tsx) which slug to log into, then destroy the
        // renderer. The wrapper spawns `claudish login {slug}` as a
        // child process so the OAuth callback server and inquirer
        // prompts run in a clean stdio environment. When the child
        // exits, the wrapper re-enters startConfigTui and we're back
        // on a fresh Providers tab.
        //
        // Child-process isolation avoids the ERR_CONNECTION_REFUSED
        // issue that an earlier in-process attempt hit — the child
        // gets a fresh Node runtime with no OpenTUI residue.
        const slug = selectedProvider.oauthSlug;
        if (!slug) {
          setStatusMsg(
            `${selectedProvider.displayName} doesn't support OAuth login. Press s to set an API key.`
          );
        } else if (!requestLogin) {
          // Fallback: wrapper didn't provide the login bridge. Tell the
          // user the command to run manually.
          setStatusMsg(`Run: claudish login ${slug}`);
        } else {
          setStatusMsg(`Launching: claudish login ${slug}…`);
          // Defer destroy so React commits the status message first.
          setTimeout(() => {
            requestLogin(slug);
            renderer.destroy();
          }, 50);
        }
      } else if (key.raw === "T") {
        // Test ALL credentialed providers in parallel. Each call goes through
        // the shared probe proxy (same stack as `claudish --probe`), so
        // credentials are resolved uniformly from env / config / OAuth.
        //
        // Providers without ANY credentials are SKIPPED — they keep their
        // default "not set" / "not configured" badge. Marking them as FAIL
        // would be misleading: "no key, no oauth" isn't a test failure, it's
        // just an unused row.
        //
        // The probe model for each provider is picked from the cached
        // /probeModels catalog inside runProbeTest. Providers with no entry
        // surface as "no probe model in catalog" rather than being skipped
        // silently — that's a more useful signal than an absent row.
        const fired: string[] = [];
        for (const prov of PROVIDERS) {
          if (!providerIsReady(prov, config)) continue;
          fired.push(prov.displayName);
          // Fire-and-forget — errors are written into testResults inside
          // runProbeTest, no need to await.
          void runProbeTest(prov);
        }
        if (fired.length === 0) {
          setStatusMsg("No credentialed providers to test.");
        } else {
          const startupHint = !isProbeProxyReady()
            ? " (starting probe proxy…)"
            : "";
          setStatusMsg(
            `Testing ${fired.length} provider${fired.length === 1 ? "" : "s"} in parallel…${startupHint}`
          );
        }
      } else if (key.name === "t") {
        // Single-provider test. No-op if there's no credential of any kind —
        // we don't want to flip the badge to FAIL just because nothing is
        // configured. Use the right hint based on provider capabilities.
        const caps = providerAuthCapabilities(selectedProvider, config);
        const ready = providerIsReady(selectedProvider, config);
        if (!ready) {
          if (selectedProviderIsLocal) {
            setStatusMsg(
              `${selectedProvider.displayName}: disabled. Press e to enable in global config.`
            );
          } else if (caps.apiKey.supported && caps.oauth.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no credentials. Press s to set a key or l to login.`
            );
          } else if (caps.oauth.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no credentials. Press l to login.`
            );
          } else if (caps.apiKey.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no key set. Press s to set an API key.`
            );
          } else {
            setStatusMsg(
              `${selectedProvider.displayName} doesn't support auth from the TUI.`
            );
          }
          return;
        }
        if (!isProbeProxyReady()) {
          setStatusMsg("Starting probe proxy…");
        }
        // Probe model is picked from the cached /probeModels catalog inside
        // runProbeTest. A missing entry surfaces as a failure row, not a
        // status-line message, so the user sees it on the provider row itself.
        void runProbeTest(selectedProvider);
      }
    } else if (activeTab === "profiles") {
      // Build profile list for navigation
      const globalCfg = loadConfig();
      const localCfg = loadLocalConfig();
      const localNames = localCfg ? Object.keys(localCfg.profiles) : [];
      const globalNames = Object.keys(globalCfg.profiles);
      const allNames = [...new Set([...localNames, ...globalNames])];

      if (key.name === "up" || key.name === "k") {
        setProfileIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProfileIndex((i) => Math.min(Math.max(0, allNames.length - 1), i + 1));
        setStatusMsg(null);
      } else if (key.name === "return" || key.name === "enter" || key.name === "a") {
        // Activate selected profile
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const cfg = loadConfig();
          cfg.defaultProfile = selectedName;
          saveConfig(cfg);
          refreshConfig();
          setStatusMsg(`Profile "${selectedName}" activated.`);
        }
      } else if (key.name === "n") {
        // New profile — first pick scope (delegates to wizard)
        wizard.startNewProfile();
      } else if (key.name === "e") {
        // Edit selected profile's model mappings (delegates to wizard)
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const isLocal = localCfg ? !!localCfg.profiles[selectedName] : false;
          wizard.startEditExisting(selectedName, isLocal);
        }
      } else if (key.name === "d") {
        // Delete selected profile (can't delete active one)
        const selectedName = allNames[profileIndex];
        const cfg = loadConfig();
        if (!selectedName) {
          setStatusMsg("No profile selected.");
        } else if (selectedName === cfg.defaultProfile) {
          setStatusMsg("Cannot delete the active profile.");
        } else {
          // Check if it's a local profile
          const localCfgCheck = loadLocalConfig();
          if (localCfgCheck?.profiles[selectedName]) {
            delete localCfgCheck.profiles[selectedName];
            saveLocalConfig(localCfgCheck);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Project profile "${selectedName}" deleted.`);
          } else if (Object.keys(cfg.profiles).length <= 1) {
            setStatusMsg("Cannot delete the last global profile.");
          } else if (cfg.profiles[selectedName]) {
            delete cfg.profiles[selectedName];
            saveConfig(cfg);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Profile "${selectedName}" deleted.`);
          } else {
            setStatusMsg("Profile not found.");
          }
        }
      }
    } else if (activeTab === "routing") {
      if (key.name === "a") {
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setStatusMsg(null);
        setMode("add_routing_pattern");
      } else if (key.name === "e") {
        // Edit selected rule. ALWAYS opens the scope picker so the user can
        // either confirm the current scope (and proceed to chain edit) or
        // move the rule to the other scope (effectively a single-keystroke
        // promote/demote). The picker is prefilled with the rule's current
        // scope as the suggested choice.
        //
        // For `default` rows, there's no current scope — the picker just
        // asks the user to choose where to write the new override.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to edit.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          setRoutingPattern(rule.pattern);
          setChainSelected(new Set(rule.chain));
          setChainOrder([...rule.chain]);
          setChainCursor(0);
          setStatusMsg(null);
          // Default scope to the rule's current scope (or "global" for defaults
          // — matches the typical case where users write personal overrides).
          const initialScope: RoutingScope = rule.kind === "project" ? "project" : "global";
          setRoutingScope(initialScope);
          setRoutingScopeCursor(initialScope === "global" ? 0 : 1);
          setEditingExistingScope(rule.kind === "default" ? null : rule.kind);
          setEditingExistingPattern(rule.pattern);
          setRoutingScopeReturnsToEdit(true);
          setMode("pick_routing_scope");
        }
      } else if (key.name === "d") {
        // No more peel: each row owns its scope. Delete from that scope only.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to delete.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          if (rule.kind === "default") {
            setStatusMsg(
              `Built-in default '${rule.pattern}' cannot be deleted. Press e to override.`
            );
          } else if (rule.kind === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[rule.pattern] !== undefined) {
              delete local.routing[rule.pattern];
              saveLocalConfig(local);
              refreshConfig();
              setStatusMsg(`Project rule deleted: '${rule.pattern}'.`);
            }
          } else {
            // rule.kind === "global"
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[rule.pattern] !== undefined) {
              delete cfg.routing[rule.pattern];
              saveConfig(cfg);
              refreshConfig();
              setStatusMsg(`Global rule deleted: '${rule.pattern}'.`);
            }
          }
        }
      } else if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(Math.max(0, mergedRules.length - 1), i + 1));
      } else if (key.name === "p") {
        setStatusMsg(null);
        probe.startInput();
      }
    } else if (activeTab === "privacy") {
      if (key.name === "t") {
        const cfg = loadConfig();
        const next = !telemetryEnabled;
        cfg.telemetry = {
          ...(cfg.telemetry ?? {}),
          enabled: next,
          askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Telemetry ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "u") {
        const cfg = loadConfig();
        const next = !statsEnabled;
        cfg.stats = {
          ...(cfg.stats ?? {}),
          enabled: next,
          enabledAt: next ? (cfg.stats?.enabledAt ?? new Date().toISOString()) : cfg.stats?.enabledAt,
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Usage stats ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "c") {
        clearBuffer();
        setBufStats(getBufferStats());
        setStatusMsg("Stats buffer cleared.");
      }
    }
  });

  if (height < 15 || width < 60) {
    return (
      <box width="100%" height="100%" padding={1} backgroundColor={C.bg}>
        <text>
          <span fg={C.red} attributes={A.bold}>
            Terminal too small ({width}x{height}). Resize to at least 60x15.
          </span>
        </text>
      </box>
    );
  }

  const isInputMode = mode === "input_key" || mode === "input_endpoint";
  const isRoutingInput =
    mode === "add_routing_pattern" ||
    mode === "add_routing_chain" ||
    mode === "pick_routing_scope";

  // ── Layout math ───────────────────────────────────────────────────────────
  // header(1) + tab-bar(3) + content(flex) + detail(fixed) + footer(1)
  const contentH = Math.max(4, height - HEADER_H - TABS_H - DETAIL_H - FOOTER_H - 1);

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      {/* Header */}
      <box height={HEADER_H} flexDirection="row" backgroundColor={C.bgAlt} paddingX={1}>
        <text>
          <span fg={C.white} attributes={A.bold}>
            claudish
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.blue} attributes={A.bold}>
            {VERSION}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.orange} attributes={A.bold}>
            ★ {profileName}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.green} attributes={A.bold}>
            {readyCount}
          </span>
          <span fg={C.fgMuted}> providers configured</span>
          <span fg={C.dim}>
            {"─".repeat(Math.max(1, width - 38 - profileName.length - VERSION.length))}
          </span>
        </text>
      </box>

      {/* Tab bar */}
      <TabBar activeTab={activeTab} statusMsg={statusMsg} width={width} />

      {/* Content + detail */}
      {activeTab === "providers" && (
        <>
          <ProvidersContent
            config={config}
            displayProviders={displayProviders}
            providerIndex={providerIndex}
            testResults={testResults}
            width={width}
            contentH={contentH}
            isInputMode={isInputMode}
            animTick={animTick}
          />
          <ProviderDetail
            selectedProvider={selectedProvider}
            mode={mode}
            inputValue={inputValue}
            setInputValue={setInputValue}
            width={width}
            hasCfgKey={hasCfgKey}
            hasEnvKey={hasEnvKey}
            hasKey={hasKey}
            cfgKeyMask={cfgKeyMask}
            envKeyMask={envKeyMask}
            activeEndpoint={activeEndpoint}
            testResults={testResults}
            isInputMode={isInputMode}
          />
        </>
      )}
      {activeTab === "profiles" && (
        <>
          <ProfilesContent
            config={config}
            activeTab={activeTab}
            mode={mode}
            profileScope={profileScope}
            profileIndex={profileIndex}
            editProfileName={editProfileName}
            editProfileValue={editProfileValue}
            suggestions={suggestions}
            suggestionIndex={suggestionIndex}
            providerPickerIndex={providerPickerIndex}
            width={width}
            contentH={contentH}
          />
          <ProfileDetail config={config} profileIndex={profileIndex} />
        </>
      )}
      {activeTab === "routing" && (
        <>
          <RoutingContent
            config={config}
            probeMode={probeMode}
            probeModel={probeModel}
            probeResults={probeResults}
            mode={mode}
            routingPattern={routingPattern}
            chainSelected={chainSelected}
            chainOrder={chainOrder}
            chainCursor={chainCursor}
            // NOTE: `providerIndex` is shared with the Providers tab here. See
            // "Known wart" in ai-docs/app-tsx-split/walkthrough.md — switching
            // tabs preserves the cursor across two unrelated lists.
            providerIndex={providerIndex}
            mergedRules={mergedRules}
            width={width}
            contentH={contentH}
            isRoutingInput={isRoutingInput}
            editingExistingScope={editingExistingScope}
            routingScopeCursor={routingScopeCursor}
          />
          <RoutingDetail probeMode={probeMode} mergedRules={mergedRules} />
        </>
      )}
      {activeTab === "privacy" && (
        <>
          <PrivacyContent
            activeTab={activeTab}
            telemetryEnabled={telemetryEnabled}
            statsEnabled={statsEnabled}
            bufStats={bufStats}
            width={width}
            contentH={contentH}
          />
          <PrivacyDetail />
        </>
      )}

      {/* Footer */}
      <Footer
        activeTab={activeTab}
        mode={mode}
        probeMode={probeMode}
        // Per-row capabilities so the Providers tab footer hides chips
        // (s set key / l login / e endpoint / x remove) on rows that
        // don't support the corresponding method.
        providerCaps={
          activeTab === "providers" && selectedProvider
            ? {
                apiKey: !!selectedProvider.apiKeyEnvVar,
                oauth: !!selectedProvider.oauthSlug,
                endpoint: !!selectedProvider.endpointEnvVar,
                local: selectedProviderIsLocal,
                localEnabled: selectedLocalEnabled,
              }
            : undefined
        }
      />
    </box>
  );
}
