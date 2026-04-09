import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  setupSession,
  type TeamManifest,
  type TeamStatus,
} from "./team-orchestrator.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { matchRoutingRule, buildRoutingChain } from "./providers/routing-rules.js";
import { getFallbackChain } from "./providers/auto-route.js";
import { loadConfig, loadLocalConfig } from "./profile-config.js";

// ─── Routing Resolution ──────────────────────────────────────────────────────

interface RouteInfo {
  chain: string[];       // e.g. ["LiteLLM", "OpenRouter"]
  source: string;        // "direct", "project routing", "user routing", "auto"
  sourceDetail?: string; // matched pattern for custom rules
}

function resolveRouteInfo(modelId: string): RouteInfo {
  const parsed = parseModelSpec(modelId);

  // Explicit provider prefix (e.g. or@model) — no fallback chain
  if (parsed.isExplicitProvider) {
    return { chain: [parsed.provider], source: "direct" };
  }

  // Check local (project-scope) routing rules first
  const local = loadLocalConfig();
  if (local?.routing && Object.keys(local.routing).length > 0) {
    const matched = matchRoutingRule(parsed.model, local.routing);
    if (matched) {
      const routes = buildRoutingChain(matched, parsed.model);
      const pattern = Object.keys(local.routing).find((k) => {
        if (k === parsed.model) return true;
        if (k.includes("*")) {
          const star = k.indexOf("*");
          return parsed.model.startsWith(k.slice(0, star)) && parsed.model.endsWith(k.slice(star + 1));
        }
        return false;
      });
      return {
        chain: routes.map((r) => r.displayName),
        source: "project routing",
        sourceDetail: pattern,
      };
    }
  }

  // Check global (user-scope) routing rules
  const global_ = loadConfig();
  if (global_.routing && Object.keys(global_.routing).length > 0) {
    const matched = matchRoutingRule(parsed.model, global_.routing);
    if (matched) {
      const routes = buildRoutingChain(matched, parsed.model);
      const pattern = Object.keys(global_.routing).find((k) => {
        if (k === parsed.model) return true;
        if (k.includes("*")) {
          const star = k.indexOf("*");
          return parsed.model.startsWith(k.slice(0, star)) && parsed.model.endsWith(k.slice(star + 1));
        }
        return false;
      });
      return {
        chain: routes.map((r) => r.displayName),
        source: "user routing",
        sourceDetail: pattern,
      };
    }
  }

  // Default auto-routing
  const routes = getFallbackChain(parsed.model, parsed.provider);
  return {
    chain: routes.map((r) => r.displayName),
    source: "auto",
  };
}

/**
 * Build shell commands for the pane header.
 * Layout:
 *   ┌──────────────────────────────────────┐
 *   │  ██ model-name ██                    │  (white on colored bg)
 *   │  route: LiteLLM → OpenRouter (auto)  │  (dim)
 *   │  ──────────────────────────────────── │  (dim line)
 *   │  The full prompt text, word-wrapped   │  (normal)
 *   │  across multiple lines if needed...   │
 *   │  ──────────────────────────────────── │  (dim line)
 *   └──────────────────────────────────────┘
 */
function buildPaneHeader(model: string, prompt: string): string {
  const route = resolveRouteInfo(model);

  // Shell-escape single quotes in model name and route strings
  const esc = (s: string) => s.replace(/'/g, "'\\''");

  // Color palette for model name background (rotate by hash)
  const bgColors = [
    "48;2;40;90;180",   // blue
    "48;2;140;60;160",  // purple
    "48;2;30;130;100",  // teal
    "48;2;160;80;40",   // orange
    "48;2;60;120;60",   // green
    "48;2;160;50;70",   // red
  ];
  let hash = 0;
  for (let i = 0; i < model.length; i++) hash = ((hash << 5) - hash + model.charCodeAt(i)) | 0;
  const bg = bgColors[Math.abs(hash) % bgColors.length];

  // Route chain string: "LiteLLM → OpenRouter"
  const chainStr = route.chain.join(" → ");
  const sourceLabel = route.sourceDetail
    ? `${route.source}: ${route.sourceDetail}`
    : route.source;

  const lines: string[] = [];

  // Line 1: model name with colored background, padded
  lines.push(`printf '\\033[1;97;${bg}m  %s  \\033[0m\\n' '${esc(model)}';`);

  // Line 2: route chain in dim with arrow symbols
  lines.push(`printf '\\033[2m  route: ${esc(chainStr)}  (${esc(sourceLabel)})\\033[0m\\n' ;`);

  // Line 3: thin separator
  lines.push(`printf '\\033[2m  %s\\033[0m\\n' '────────────────────────────────────────';`);

  // Lines 4+: prompt text, word-wrapped via fold
  // Replace newlines with \n escape for printf %b (gridfile must be single-line)
  const promptForShell = esc(prompt).replace(/\n/g, "\\n");
  lines.push(`printf '%b\\n' '${promptForShell}' | fold -s -w 78 | sed 's/^/  /';`);

  // Final separator
  lines.push(`printf '\\033[2m  %s\\033[0m\\n\\n' '────────────────────────────────────────';`);

  return lines.join(" ");
}

// ─── Multiplexer Binary Detection ────────────────────────────────────────────

/**
 * Find the magmux binary. Priority:
 * 1. Dev-built magmux (native/magmux/magmux — freshest, has latest features)
 * 2. Bundled magmux (native/magmux/magmux-<platform>-<arch>)
 * 3. Platform-specific npm package (@claudish/magmux-<platform>-<arch>)
 * 4. magmux in PATH
 */
function findMagmuxBinary(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const pkgRoot = join(thisDir, "..");
  const platform = process.platform;
  const arch = process.arch;

  // 1. Dev-built magmux (native/magmux/magmux — freshest, has latest features)
  const builtMagmux = join(pkgRoot, "native", "magmux", "magmux");
  if (existsSync(builtMagmux)) return builtMagmux;

  // 2. Bundled magmux (native/magmux/magmux-<platform>-<arch>)
  const bundledMagmux = join(pkgRoot, "native", "magmux", `magmux-${platform}-${arch}`);
  if (existsSync(bundledMagmux)) return bundledMagmux;

  // 3. Platform-specific npm package (@claudish/magmux-<platform>-<arch>)
  //    npm installs only the matching platform's optional dep
  try {
    const pkgName = `@claudish/magmux-${platform}-${arch}`;
    // Walk up from this file to find node_modules
    let searchDir = pkgRoot;
    for (let i = 0; i < 5; i++) {
      const candidate = join(searchDir, "node_modules", pkgName, "bin", "magmux");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
  } catch { /* not installed */ }

  // 4. magmux in PATH
  try {
    const result = execSync("which magmux", { encoding: "utf-8" }).trim();
    if (result) return result;
  } catch {
    /* not in PATH */
  }

  throw new Error(
    "magmux not found. Install it:\n  brew install MadAppGang/tap/magmux"
  );
}

/**
 * Read exit-code files and update status.json (called once after magmux exits).
 */
function finalizeStatus(statusPath: string, sessionPath: string, anonIds: string[]): void {
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));

  for (const anonId of anonIds) {
    const current = statusCache.models[anonId];
    if (current.state === "COMPLETED" || current.state === "FAILED") continue;

    const exitCodePath = join(sessionPath, "work", anonId, ".exit-code");
    if (existsSync(exitCodePath)) {
      const code = parseInt(readFileSync(exitCodePath, "utf-8").trim(), 10);
      statusCache.models[anonId] = {
        ...current,
        state: code === 0 ? "COMPLETED" : "FAILED",
        exitCode: code,
        startedAt: current.startedAt ?? statusCache.startedAt,
        completedAt: new Date().toISOString(),
      };
    } else {
      statusCache.models[anonId] = { ...current, state: "TIMEOUT" };
    }
  }

  writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run multiple models in grid mode using magmux.
 *
 * Sets up the session directory, writes a gridfile with one claudish command
 * per line, launches magmux with the grid, and polls for completion.
 *
 * @param sessionPath  Absolute path to the session directory
 * @param models       Model IDs to run in parallel
 * @param input        Task prompt text
 * @param opts         Optional timeout (seconds, default 300)
 */
export async function runWithGrid(
  sessionPath: string,
  models: string[],
  input: string,
  opts?: { timeout?: number; keep?: boolean; mode?: "default" | "interactive" }
): Promise<TeamStatus> {
  const mode = opts?.mode ?? "default";
  const keep = opts?.keep ?? false;

  // 1. Set up session directory (manifest.json, status.json, work dirs, input.md)
  const manifest: TeamManifest = setupSession(sessionPath, models, input);

  // 2. Ensure errors directory exists and clean stale .exit-code files from previous runs
  mkdirSync(join(sessionPath, "errors"), { recursive: true });
  for (const anonId of Object.keys(manifest.models)) {
    const stale = join(sessionPath, "work", anonId, ".exit-code");
    try {
      unlinkSync(stale);
    } catch {
      /* doesn't exist — fine */
    }
  }

  // 3. Generate gridfile — one shell command per pane
  const gridfilePath = join(sessionPath, "gridfile.txt");
  // Read prompt once, shell-escape single quotes
  const prompt = readFileSync(join(sessionPath, "input.md"), "utf-8")
    .replace(/'/g, "'\\''")
    .replace(/\n/g, " ");  // Flatten newlines — gridfile is one command per line

  // Shell function: count .exit-code files, derive done/running/failed, send status IPC.
  // magmux handles {"cmd":"status","text":"..."} and renders it directly — no file needed.
  const totalPanes = Object.keys(manifest.models).length;
  const workDir = join(sessionPath, "work");
  const statusFunc = [
    `_update_bar() {`,
    `_d=0; _f=0;`,
    `for _ecf in $(find ${workDir} -name .exit-code 2>/dev/null); do`,
    `_c=$(cat "$_ecf" 2>/dev/null);`,
    `if [ "$_c" = "0" ]; then _d=$((_d+1)); else _f=$((_f+1)); fi;`,
    `done;`,
    `_r=$((${totalPanes}-_d-_f));`,
    `_e=$SECONDS;`,
    `if [ $_e -ge 60 ]; then _ts="$((_e/60))m $((_e%60))s"; else _ts="\${_e}s"; fi;`,
    `if [ $_r -eq 0 ] && [ $_f -eq 0 ]; then`,
    `_t="C: claudish team\tG: ${totalPanes} done\tG: complete\tD: \${_ts}\tD: ctrl-g q to quit";`,
    `elif [ $_r -eq 0 ] && [ $_f -gt 0 ]; then`,
    `_t="C: claudish team\tG: \${_d} done\tR: \${_f} failed\tD: \${_ts}\tD: ctrl-g q to quit";`,
    `else`,
    `_t="C: claudish team\tG: \${_d} done\tC: \${_r} running\tR: \${_f} failed\tD: \${_ts}";`,
    `fi;`,
    `_j=$(printf '%s' "$_t" | sed 's/\t/\\\\t/g');`,
    `printf '{\"cmd\":\"status\",\"text\":\"%s\"}' "$_j" | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
    `};`,
  ].join(" ");

  // Read raw prompt (preserving newlines) for the pane header display
  const rawPrompt = readFileSync(join(sessionPath, "input.md"), "utf-8");

  const gridLines = Object.entries(manifest.models).map(([anonId]) => {
    const errorLog = join(sessionPath, "errors", `${anonId}.log`);
    const exitCodeFile = join(sessionPath, "work", anonId, ".exit-code");
    const model = manifest.models[anonId].model;
    const paneIndex = Object.keys(manifest.models).indexOf(anonId);

    if (mode === "interactive") {
      // Interactive mode: full Claude Code TUI sessions.
      // -i forces interactive (TUI) mode even with a prompt argument.
      // --dangerously-skip-permissions skips the consent prompt.
      // Static status bar — interactive sessions don't have "done" state until user quits.
      const modelList = Object.values(manifest.models).map((m) => m.model).join(", ");
      const interactiveStatus = `C: claudish team\tD: ${modelList}\tD: ctrl-g Tab switch\tD: ctrl-g q quit`;
      const interactiveStatusEsc = interactiveStatus.replace(/\t/g, "\\\\t");
      return [
        `if [ -n "$MAGMUX_SOCK" ]; then printf '{\"cmd\":\"status\",\"text\":\"%s\"}' '${interactiveStatusEsc}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null; fi;`,
        `claudish --model ${model} -i --dangerously-skip-permissions '${prompt}' 2>${errorLog};`,
        `_ec=$?; echo $_ec > ${exitCodeFile}`,
      ].join(" ");
    }

    // Default mode: header + quiet output + IPC updates + sleep to keep pane alive
    const header = buildPaneHeader(model, rawPrompt);

    return [
      `${statusFunc}`,
      `if [ -n "$MAGMUX_SOCK" ]; then _update_bar; fi;`,
      `${header}`,
      `claudish --model ${model} -y --quiet '${prompt}' 2>${errorLog};`,
      `_ec=$?; echo $_ec > ${exitCodeFile};`,
      `if [ -n "$MAGMUX_SOCK" ]; then`,
      `  _update_bar;`,
      `  if [ $_ec -eq 0 ]; then`,
      `    echo '{"cmd":"tint","pane":${paneIndex},"color":"green"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `    echo '{"cmd":"overlay","pane":${paneIndex},"text":"DONE","color":"green"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `  else`,
      `    echo '{"cmd":"tint","pane":${paneIndex},"color":"red"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `    echo '{"cmd":"overlay","pane":${paneIndex},"text":"FAIL","color":"red"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `  fi;`,
      `fi;`,
      `exec sleep 86400`,
    ].join(" ");
  });
  writeFileSync(gridfilePath, gridLines.join("\n") + "\n", "utf-8");

  // 4. Find magmux binary
  const magmuxPath = findMagmuxBinary();

  // 5. Spawn magmux — status bar updated by panes via IPC (no file needed)
  const statusPath = join(sessionPath, "status.json");
  const anonIds = Object.keys(manifest.models);
  const spawnArgs = ["-g", gridfilePath];
  if (!keep && mode === "default") {
    spawnArgs.push("-w"); // auto-exit when all panes complete (default mode only)
  }
  const proc = spawn(magmuxPath, spawnArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  // 6. Wait for multiplexer to exit
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });

  // 7. Final status.json update from exit-code files
  finalizeStatus(statusPath, sessionPath, anonIds);

  return JSON.parse(readFileSync(statusPath, "utf-8")) as TeamStatus;
}
