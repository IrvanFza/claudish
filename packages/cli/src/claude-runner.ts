import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isatty } from "node:tty";
import { lookupModelForProvider } from "./adapters/model-catalog.js";
import { ENV } from "./config.js";
// Aliased: runClaudeWithProxy declares its own local `log` (a quiet-aware
// console printer), and an unaliased import would be shadowed inside it.
import { log as debugLog, logStderr } from "./logger.js";
import { loadConfig } from "./profile-config.js";
import { discoverContextWindow } from "./providers/model-discovery.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { route } from "./providers/routing-rules.js";
import { setClaudeCodeRunning } from "./telemetry.js";
import { beginTerminalIsolation } from "./terminal-isolation.js";
import type { ClaudishConfig } from "./types.js";

/**
 * Terminal-isolation state for the running session. Module-level because the
 * firewall must be lifted from two places — the normal exit path and the signal
 * handler — and the signal handler is installed as a separate function.
 */
let restoreTerminal: (() => void) | null = null;

/**
 * Lift the terminal firewall.
 *
 * Deliberately prints NOTHING, not even a summary count: the terminal is the
 * one channel that must stay pristine, and a trailing "N messages suppressed"
 * line is noise the user can act on only by reading a log anyway. Suppressed
 * output is not lost — it is recorded to the durable session log at
 * ~/.claudish/logs/claudish_<timestamp>.log (see the "[Suppressed]" prefix in
 * the sink below; the ephemeral ~/.claudish/diag-<pid>.log is unlinked at
 * cleanup and cannot be the system of record).
 *
 * The user-facing channel for a real failure is the HTTP response body: the
 * proxy returns a 400 with an actionable message, which Claude Code renders in
 * its own native error UI, in the transcript, where the user is already looking.
 */
function releaseTerminalIsolation(): void {
  if (!restoreTerminal) return;
  restoreTerminal();
  restoreTerminal = null;
}

/**
 * Check if any resolved model mapping targets a native Anthropic model (claude-*).
 * When true, placeholder auth tokens must NOT be set — Claude Code needs its real
 * subscription credentials so NativeHandler can forward them to api.anthropic.com.
 */
function hasNativeAnthropicMapping(config: ClaudishConfig): boolean {
  const models = [
    config.model,
    config.modelOpus,
    config.modelSonnet,
    config.modelHaiku,
    config.modelSubagent,
  ];
  return models.some((m) => m && parseModelSpec(m).provider === "native-anthropic");
}

/**
 * Does the user explicitly want their real ANTHROPIC_API_KEY used, accepting
 * metered API billing instead of their claude.ai subscription?
 *
 * Opt-IN only — see the native-anthropic branch in runClaudeWithProxy for why
 * the default is to hide the key. Precedence (highest first):
 *   1. `--anthropic-api-billing` CLI flag
 *   2. `CLAUDISH_ANTHROPIC_API_BILLING` env var (any value except 0/false/"")
 *   3. `anthropicApiBilling: true` in ~/.claudish/config.json
 *
 * A config read failure must never block launch, so it degrades to "not opted
 * in" — the safe direction, since that only ever avoids spending money.
 */
function wantsAnthropicApiBilling(config: ClaudishConfig): boolean {
  if (config.anthropicApiBilling) return true;

  const raw = process.env[ENV.CLAUDISH_ANTHROPIC_API_BILLING];
  if (raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false") return true;

  try {
    return loadConfig().anthropicApiBilling === true;
  } catch {
    return false;
  }
}

/**
 * "Proxy mode" = claudish points Claude Code at its local proxy with a placeholder
 * API key (see the auth block in runClaudeWithProxy). In this mode the session
 * authenticates via ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN, so a user/project/local
 * setting of `forceLoginMethod: "claudeai"` would block it at startup.
 *
 * The inverse — native-Anthropic models or --monitor — uses the user's REAL claude.ai
 * subscription credentials, so we must NOT touch their login method there.
 */
export function isProxyAuthMode(config: ClaudishConfig): boolean {
  return !config.monitor && !hasNativeAnthropicMapping(config);
}

/**
 * OS-specific path to Claude Code's *managed* settings file — the highest-precedence
 * tier, which "cannot be overridden by anything" (not even our --settings overlay).
 * https://code.claude.com/docs/en/settings
 */
function managedSettingsPath(): string {
  if (isWindows()) {
    return join(
      process.env.PROGRAMDATA || "C:\\ProgramData",
      "ClaudeCode",
      "managed-settings.json"
    );
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Read-only check: does the OS managed-settings policy force the claude.ai login
 * method? If so, an API-key/proxy session is blocked at startup and NOTHING claudish
 * writes can override it. Best-effort — any read/parse failure returns false (absent).
 */
export function managedSettingsForcesClaudeAi(
  readFile: typeof readFileSync = readFileSync
): boolean {
  try {
    // A missing file throws ENOENT here, which the catch maps to "absent" — no separate
    // existsSync pre-check needed (and it would bypass the injected reader in tests).
    const raw = readFile(managedSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw as string) as { forceLoginMethod?: unknown };
    return parsed.forceLoginMethod === "claudeai";
  } catch {
    // Missing/unreadable/permission-denied/garbled → treat as "no managed block we can see".
    return false;
  }
}

// Use process.platform directly to ensure runtime evaluation
// (module-level constants can be inlined by bundlers at build time)
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Create a cross-platform Node.js script for status line
 * This replaces the bash script to work on Windows
 */
export function createStatusLineScript(tokenFilePath: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const claudishDir = join(homeDir, ".claudish");
  const timestamp = Date.now();
  const scriptPath = join(claudishDir, `status-${timestamp}.js`);

  // Escape backslashes for Windows paths in the script
  const escapedTokenPath = tokenFilePath.replace(/\\/g, "\\\\");

  const script = `
const fs = require('fs');
const path = require('path');

const CYAN = "\\x1b[96m";
const YELLOW = "\\x1b[93m";
const GREEN = "\\x1b[92m";
const RED = "\\x1b[91m";
const MAGENTA = "\\x1b[95m";
const DIM = "\\x1b[2m";
const RESET = "\\x1b[0m";
const BOLD = "\\x1b[1m";

// Format token count with k/M suffix
function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\\.0$/, '') + 'k';
  return String(n);
}

// The window Claude Code will actually enforce, which is not always the model's spec
// window: it compacts at min(CLAUDE_CODE_AUTO_COMPACT_WINDOW, maxContextTokens), and
// maxContextTokens falls back to a fixed default for model names it does not know —
// every model claudish proxies. This script runs inside Claude Code's environment, so
// it reads the governing values first-hand.
function effectiveWindow(specWindow) {
  if (!(specWindow > 0)) return 0;
  const num = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  let w = specWindow;
  const maxCtx = num(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, ${CLAUDE_CODE_DEFAULT_MAX_CONTEXT});
  if (maxCtx > 0 && maxCtx < w) w = maxCtx;
  const autoCompact = num(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
  if (autoCompact > 0 && autoCompact < w) w = autoCompact;
  return w;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    let dir = path.basename(process.cwd());
    if (dir.length > 15) dir = dir.substring(0, 12) + '...';

    let ctx = 100, cost = 0, inputTokens = 0, contextWindow = 0;
    let model = process.env.CLAUDISH_ACTIVE_MODEL_NAME || 'unknown';
    const isLocal = process.env.CLAUDISH_IS_LOCAL === 'true';

    let isFree = false, isEstimated = false, providerName = '';
    try {
      const tokens = JSON.parse(fs.readFileSync('${escapedTokenPath}', 'utf-8'));
      cost = tokens.total_cost || 0;
      ctx = tokens.context_left_percent ?? -1;
      inputTokens = tokens.input_tokens || 0;
      contextWindow = typeof tokens.context_window === 'number' ? tokens.context_window : 0;
      isFree = tokens.is_free || false;
      isEstimated = tokens.is_estimated || false;
      providerName = tokens.provider_name || '';
      if (tokens.model_name) model = tokens.model_name;
      var quotaRemaining = tokens.quota_remaining;
    } catch (e) {
      try {
        const json = JSON.parse(input);
        cost = json.total_cost_usd || 0;
      } catch {}
    }

    let costDisplay;
    if (isLocal) {
      costDisplay = 'LOCAL';
    } else if (isFree) {
      costDisplay = 'FREE';
    } else if (isEstimated) {
      costDisplay = '~$' + cost.toFixed(3);
    } else {
      costDisplay = '$' + cost.toFixed(3);
    }
    const modelDisplay = providerName ? providerName + ' ' + model : model;
    // Format context display as progress bar: [████░░░░░░] 116k/1M
    const effWindow = effectiveWindow(contextWindow);
    if (effWindow > 0 && inputTokens > 0) {
      ctx = Math.max(0, Math.min(100, Math.round(((effWindow - inputTokens) / effWindow) * 100)));
    }
    let ctxDisplay = '';
    if (ctx < 0 || effWindow <= 0) {
      // Unknown context window — show token count only
      ctxDisplay = inputTokens > 0 ? formatTokens(inputTokens) + ' tokens' : 'N/A';
    } else if (inputTokens > 0) {
      const usedPct = 100 - ctx; // ctx is "left", so used = 100 - left
      const barWidth = 15;
      const filled = Math.round((usedPct / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      // When Claude Code enforces less than the model advertises, show both — the
      // gap is the whole reason this line exists.
      const clamped = effWindow < contextWindow ? ' of ' + formatTokens(contextWindow) : '';
      ctxDisplay = '[' + bar + '] ' + formatTokens(inputTokens) + '/' + formatTokens(effWindow) + clamped;
    } else {
      ctxDisplay = ctx + '%';
    }
    let quotaDisplay = '';
    if (typeof quotaRemaining === 'number') {
      const usedPct = ((1 - quotaRemaining) * 100).toFixed(0);
      const remainPct = (quotaRemaining * 100).toFixed(0);
      const qColor = quotaRemaining > 0.5 ? GREEN : quotaRemaining > 0.2 ? YELLOW : RED;
      quotaDisplay = ' ' + DIM + '•' + RESET + ' ' + qColor + remainPct + '% quota' + RESET;
    }
    console.log(\`\${CYAN}\${BOLD}\${dir}\${RESET} \${DIM}•\${RESET} \${YELLOW}\${modelDisplay}\${RESET} \${DIM}•\${RESET} \${GREEN}\${costDisplay}\${RESET} \${DIM}•\${RESET} \${MAGENTA}\${ctxDisplay}\${RESET}\${quotaDisplay}\`);
  } catch (e) {
    console.log('claudish');
  }
});
`;

  writeFileSync(scriptPath, script, "utf-8");
  return scriptPath;
}

/** A token file older than this is from a dead session and is safe to remove. */
export const STALE_TOKEN_FILE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound on how many directory entries the opportunistic sweep will stat.
 * ~/.claudish accumulates one token file per port ever bound (2601 on the
 * developer's machine at the time of writing), and this runs on the launch
 * path — it must be cheap and predictably bounded, not exhaustive. Whatever the
 * sweep doesn't reach this run, it reaches the next one.
 */
const MAX_TOKEN_FILES_SCANNED = 4000;

/**
 * Blank the port-keyed token file before Claude Code starts.
 *
 * `~/.claudish/tokens-<port>.json` is keyed by PORT, not by session, and nothing
 * used to initialise it. Ports get reused, so a new session that happened to
 * bind a port some long-dead run had used inherited that run's numbers: a fresh
 * LM Studio-free session displayed `cli • LMStudio qc@qwen3.7-plus • $0.000 •
 * 0% (36k/32k)`, where every figure came from a five-week-old leftover file.
 *
 * The zeroed record is deliberately NEUTRAL rather than pre-populated: no
 * `provider_name` and no `model_name`, so the status line falls back to
 * `$CLAUDISH_ACTIVE_MODEL_NAME` and renders no provider label until the first
 * real response arrives. `context_window: "unknown"` / `context_left_percent:
 * -1` is the same "not known yet" pair TokenTracker itself writes, which the
 * status line renders as `N/A`.
 *
 * Best-effort: an I/O failure here must never block a launch.
 */
export function initializeTokenFile(tokenFilePath: string): void {
  try {
    mkdirSync(dirname(tokenFilePath), { recursive: true });
    writeFileSync(
      tokenFilePath,
      JSON.stringify({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        total_cost: 0,
        context_window: "unknown",
        context_left_percent: -1,
        updated_at: Date.now(),
        is_free: false,
        is_estimated: false,
      }),
      "utf-8"
    );
  } catch (e) {
    debugLog(`[claude-runner] Could not initialize token file ${tokenFilePath}: ${e}`);
  }
}

/**
 * Remove `tokens-*.json` files whose mtime is older than `STALE_TOKEN_FILE_MS`.
 *
 * Purely opportunistic housekeeping for the orphans the port-keyed naming leaves
 * behind. Anything newer than the cutoff is left alone — a concurrent claudish
 * on another port owns a live file, and deleting it would blank a running
 * session's status line.
 *
 * Never throws; returns the number of files removed (for tests/logging).
 */
export function cleanupStaleTokenFiles(
  dir: string,
  now: number = Date.now(),
  maxAgeMs: number = STALE_TOKEN_FILE_MS
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  const cutoff = now - maxAgeMs;
  let scanned = 0;
  for (const name of entries) {
    if (scanned >= MAX_TOKEN_FILES_SCANNED) break;
    if (!name.startsWith("tokens-") || !name.endsWith(".json")) continue;
    scanned++;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;
      unlinkSync(full);
      removed++;
    } catch {
      // Raced with another process, or not ours to delete. Skip it.
    }
  }

  if (removed > 0) {
    debugLog(`[claude-runner] Removed ${removed} stale token file(s) from ${dir}`);
  }
  return removed;
}

/**
 * What Claude Code assumes a model's context window is when it has never heard of
 * the model — which is every model claudish proxies.
 *
 * In Claude Code 2.1.220 the resolver ends:
 *
 *   let n = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
 *   if (n !== undefined && n > 0 && !model.startsWith("claude-")) return n
 *   return 200_000                              // ← this constant
 *
 * Numerically equal to `MIN_AUTO_COMPACT_WINDOW` today, but a DIFFERENT quantity:
 * that one is the arm-predicate cutoff below which configuring a window turns
 * auto-compaction off. They are free to drift, so they get separate names.
 *
 * Used only to render an honest status line — never to set anything.
 */
export const CLAUDE_CODE_DEFAULT_MAX_CONTEXT = 200_000;

/**
 * Create a temporary settings file with custom status line for this instance
 * This ensures each Claudish instance has its own status line without affecting
 * global Claude Code settings or other running instances
 *
 * Note: We use ~/.claudish/ instead of system temp directory to avoid Claude Code's
 * file watcher trying to watch socket files in /tmp (which causes UNKNOWN errors)
 */
export function createTempSettingsFile(
  _modelDisplay: string,
  port: string,
  proxyAuthMode: boolean
): { path: string; statusLine: { type: string; command: string; padding: number } } {
  const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const claudishDir = join(homeDir, ".claudish");

  // Ensure .claudish directory exists
  try {
    mkdirSync(claudishDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const timestamp = Date.now();
  const tempPath = join(claudishDir, `settings-${timestamp}.json`);

  // Token file path - also in .claudish directory
  const tokenFilePath = join(claudishDir, `tokens-${port}.json`);

  // Sweep the orphans FIRST (so this session's fresh file is never a candidate),
  // then blank the file for the port we are about to use. Without this the
  // status line can show a dead session's provider, cost and context — the file
  // is keyed by port, and ports are recycled.
  cleanupStaleTokenFiles(claudishDir);
  initializeTokenFile(tokenFilePath);

  let statusCommand: string;

  if (isWindows()) {
    // Windows: Use Node.js script for cross-platform compatibility
    const scriptPath = createStatusLineScript(tokenFilePath);
    statusCommand = `node "${scriptPath}"`;
  } else {
    // Unix: Use optimized bash script
    // ANSI color codes for visual enhancement
    const CYAN = "\\033[96m";
    const YELLOW = "\\033[93m";
    const GREEN = "\\033[92m";
    const MAGENTA = "\\033[95m";
    const DIM = "\\033[2m";
    const RESET = "\\033[0m";
    const BOLD = "\\033[1m";

    // Both cost and context percentage come from our token file
    // Helper function to format tokens with k/M suffix (pure bash, no awk)
    const formatTokensBash = `fmt_tok() { local n=\${1:-0}; if [ "$n" -ge 1000000 ]; then echo "$((n/1000000))M"; elif [ "$n" -ge 1000 ]; then echo "$((n/1000))k"; else echo "$n"; fi; }`;
    // Two independent fixes live in this one script; both must hold.
    //
    // (a) Report the window Claude Code will ACTUALLY enforce, not the model's spec
    //     window. Claude Code compacts at min(CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    //     maxContextTokens), and maxContextTokens falls back to a hardcoded 200,000
    //     for any model name it does not recognise — which is every model claudish
    //     proxies. So the model's real window can be silently halved on arrival, and
    //     a status line that shows only the spec window reports free space the
    //     session cannot use. This script runs inside Claude Code's environment, so
    //     eff_win() reads the governing values directly rather than have them plumbed
    //     through the proxy; when they clamp, say so out loud. The percentage is
    //     RECOMPUTED from the live EFF_WIN and input tokens instead of trusting the
    //     token file's stored context_left_percent, which is measured against the
    //     spec window and decays with session age.
    //
    // (b) Three reader properties, each learned the hard way:
    //
    //      1. Fields are read into a scratch `V` and only committed when non-empty,
    //         with `;` (not `&&`) between top-level steps. Chained with `&&`, ONE
    //         field that doesn't match aborts every field after it: `context_window`
    //         holds the string "unknown" whenever the window is unresolved, the
    //         numeric grep then emits nothing, and under GNU grep that non-zero exit
    //         silently dropped provider_name and model_name too. (macOS BSD grep
    //         exits 0, which is why it was invisible locally.)
    //      2. Only newlines are stripped, never spaces. `tr -d ' '` mangled every
    //         value containing one — "Qwen Plan" rendered as "QwenPlan". The patterns
    //         instead tolerate optional whitespace after each colon, so a
    //         pretty-printed token file still parses.
    //      3. The "unknown" sentinel keeps working: an unmatched numeric field leaves
    //         CTX_WIN at its 0 default, eff_win 0 returns 0, and the first display
    //         branch renders a bare token count (or N/A), never a bogus percentage.
    const effWinBash = `eff_win() { local w=\${1:-0}; local m=\${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-}; local a=\${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}; case "$m" in ''|*[!0-9]*) m=${CLAUDE_CODE_DEFAULT_MAX_CONTEXT};; esac; case "$a" in ''|*[!0-9]*) a=0;; esac; case "$w" in ''|*[!0-9]*) w=0;; esac; if [ "$w" -gt 0 ]; then if [ "$m" -gt 0 ] && [ "$m" -lt "$w" ]; then w=$m; fi; if [ "$a" -gt 0 ] && [ "$a" -lt "$w" ]; then w=$a; fi; fi; echo "$w"; }`;
    statusCommand = `JSON=$(cat); DIR=$(basename "$(pwd)"); [ \${#DIR} -gt 15 ] && DIR="\${DIR:0:12}..." || true; CTX=-1; COST="0"; IS_FREE="false"; IS_EST="false"; PROVIDER=""; TOKEN_MODEL=""; IN_TOK=0; CTX_WIN=0; ${formatTokensBash}; ${effWinBash}; if [ -f "${tokenFilePath}" ]; then TOKENS=$(cat "${tokenFilePath}" 2>/dev/null | tr -d '\\n\\r'); V=$(echo "$TOKENS" | grep -o '"context_left_percent": *-\\?[0-9]*' | grep -o '\\-\\?[0-9]*'); [ -n "$V" ] && CTX="$V"; V=$(echo "$TOKENS" | grep -o '"total_cost": *[0-9.]*' | cut -d: -f2 | tr -d ' '); [ -n "$V" ] && COST="$V"; V=$(echo "$TOKENS" | grep -o '"input_tokens": *[0-9]*' | grep -o '[0-9]*'); [ -n "$V" ] && IN_TOK="$V"; V=$(echo "$TOKENS" | grep -o '"context_window": *[0-9]*' | grep -o '[0-9]*'); [ -n "$V" ] && CTX_WIN="$V"; V=$(echo "$TOKENS" | grep -o '"is_free": *[a-z]*' | cut -d: -f2 | tr -d ' '); [ -n "$V" ] && IS_FREE="$V"; V=$(echo "$TOKENS" | grep -o '"is_estimated": *[a-z]*' | cut -d: -f2 | tr -d ' '); [ -n "$V" ] && IS_EST="$V"; V=$(echo "$TOKENS" | grep -o '"provider_name": *"[^"]*"' | cut -d'"' -f4); [ -n "$V" ] && PROVIDER="$V"; V=$(echo "$TOKENS" | grep -o '"model_name": *"[^"]*"' | cut -d'"' -f4); [ -n "$V" ] && TOKEN_MODEL="$V"; fi; if [ "$CLAUDISH_IS_LOCAL" = "true" ]; then COST_DISPLAY="LOCAL"; elif [ "$IS_FREE" = "true" ]; then COST_DISPLAY="FREE"; elif [ "$IS_EST" = "true" ]; then COST_DISPLAY=$(printf "~\\$%.3f" "$COST"); else COST_DISPLAY=$(printf "\\$%.3f" "$COST"); fi; MODEL_DISPLAY="\${TOKEN_MODEL:-$CLAUDISH_ACTIVE_MODEL_NAME}"; if [ -n "$PROVIDER" ]; then MODEL_DISPLAY="$PROVIDER $MODEL_DISPLAY"; fi; EFF_WIN=$(eff_win $CTX_WIN); if [ "$EFF_WIN" -gt 0 ] 2>/dev/null && [ "$IN_TOK" -gt 0 ] 2>/dev/null; then CTX=$(( ((EFF_WIN - IN_TOK) * 200 / EFF_WIN + 1) / 2 )); if [ "$CTX" -lt 0 ]; then CTX=0; fi; fi; if [ "$CTX" -lt 0 ] 2>/dev/null || [ "$EFF_WIN" -le 0 ] 2>/dev/null; then if [ "$IN_TOK" -gt 0 ] 2>/dev/null; then CTX_DISPLAY="$(fmt_tok $IN_TOK) tokens"; else CTX_DISPLAY="N/A"; fi; elif [ "$IN_TOK" -gt 0 ] 2>/dev/null; then if [ "$EFF_WIN" -lt "$CTX_WIN" ] 2>/dev/null; then CTX_DISPLAY="$CTX% ($(fmt_tok $IN_TOK)/$(fmt_tok $EFF_WIN) of $(fmt_tok $CTX_WIN))"; else CTX_DISPLAY="$CTX% ($(fmt_tok $IN_TOK)/$(fmt_tok $EFF_WIN))"; fi; else CTX_DISPLAY="$CTX%"; fi; printf "${CYAN}${BOLD}%s${RESET} ${DIM}•${RESET} ${YELLOW}%s${RESET} ${DIM}•${RESET} ${GREEN}%s${RESET} ${DIM}•${RESET} ${MAGENTA}%s${RESET}\\n" "$DIR" "$MODEL_DISPLAY" "$COST_DISPLAY" "$CTX_DISPLAY"`;
  }

  const statusLine = {
    type: "command",
    command: statusCommand,
    padding: 0,
  };

  // claudish points Claude Code at its local proxy via ANTHROPIC_BASE_URL and
  // injects a placeholder ANTHROPIC_API_KEY so Claude Code authenticates against
  // the proxy instead of prompting for a claude.ai login. Claude Code then warns
  // "claude.ai connectors are disabled because ANTHROPIC_API_KEY ... is set" on
  // every session — harmless noise that reads like an error to users. claude.ai
  // org connectors are irrelevant when routing through the proxy, so disable them
  // outright, which removes the warning. (Verified: setting this suppresses the
  // message; users can still override via their own --settings, which is merged
  // on top of this temp file.)
  const settings = buildClaudishSettingsOverlay(statusLine, proxyAuthMode);

  writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf-8");
  return { path: tempPath, statusLine };
}

/**
 * Build the claudish `--settings` overlay object. This loads at the CLI-args precedence
 * tier, above the user/project/local settings files, so keys here override those three.
 *
 * - `disableClaudeAiConnectors` suppresses the proxy-mode connector warning.
 * - `forceLoginMethod: "console"` is added ONLY in proxy mode: the session authenticates
 *   via the placeholder ANTHROPIC_API_KEY, and a user/project/local
 *   `forceLoginMethod: "claudeai"` would block that at startup. In native-Anthropic /
 *   --monitor mode we leave it out so the user's real claude.ai subscription keeps working.
 *
 * (The OS *managed* tier can't be overridden — that case aborts before we get here.)
 */
export function buildClaudishSettingsOverlay(
  statusLine: { type: string; command: string; padding: number },
  proxyAuthMode: boolean
): Record<string, unknown> {
  const settings: Record<string, unknown> = { statusLine, disableClaudeAiConnectors: true };
  if (proxyAuthMode) {
    settings.forceLoginMethod = "console";
  }
  return settings;
}

/**
 * If the user passed --settings in claudeArgs, read their settings file,
 * inject the claudish statusLine into it, write a merged file, and remove
 * --settings from claudeArgs so Claude Code does not receive it twice.
 *
 * The tempSettingsPath is always written by createTempSettingsFile() first.
 * This function REPLACES its content with the merged result when a user
 * settings file exists.
 *
 * Mutates: config.claudeArgs (removes --settings and path if found)
 * Mutates: tempSettingsPath file content (replaces with merged JSON)
 */
function mergeUserSettingsIfPresent(
  config: ClaudishConfig,
  tempSettingsPath: string,
  statusLine: { type: string; command: string; padding: number },
  proxyAuthMode: boolean
): void {
  const idx = config.claudeArgs.indexOf("--settings");
  if (idx === -1 || !config.claudeArgs[idx + 1]) {
    // No --settings in passthrough args; nothing to merge.
    return;
  }

  const userSettingsValue = config.claudeArgs[idx + 1];

  try {
    // Claude Code accepts --settings as either a file path or an inline JSON string.
    // Detect inline JSON (starts with '{') vs file path.
    let userSettings: Record<string, unknown>;
    if (userSettingsValue.trimStart().startsWith("{")) {
      userSettings = JSON.parse(userSettingsValue);
    } else {
      const rawUserSettings = readFileSync(userSettingsValue, "utf-8");
      userSettings = JSON.parse(rawUserSettings);
    }

    // Inject claudish statusLine into user settings (overrides any existing statusLine)
    userSettings.statusLine = statusLine;

    // Default claude.ai connectors off (suppresses the proxy-mode warning) —
    // but let the user override it if they explicitly set the field.
    if (!("disableClaudeAiConnectors" in userSettings)) {
      userSettings.disableClaudeAiConnectors = true;
    }

    // In proxy mode, force the console login method so the placeholder-API-key session
    // isn't blocked by a claude.ai-forcing user/project/local setting — unless the user's
    // own --settings explicitly sets forceLoginMethod, in which case respect their choice.
    if (proxyAuthMode && !("forceLoginMethod" in userSettings)) {
      userSettings.forceLoginMethod = "console";
    }

    // Overwrite the temp settings file with the merged result
    writeFileSync(tempSettingsPath, JSON.stringify(userSettings, null, 2), "utf-8");
  } catch {
    // User settings unreadable or invalid JSON — claudish temp file keeps its own statusLine.
    if (!config.quiet) {
      console.warn(`[claudish] Warning: could not merge user settings: ${userSettingsValue}`);
    }
  }

  // Always remove --settings from claudeArgs: either we merged successfully (our temp file
  // contains the merged result), or the user's settings were invalid (let the temp file win
  // rather than passing an unreadable path to Claude Code for a second error).
  config.claudeArgs.splice(idx, 2);
}

/**
 * Run Claude Code CLI with the proxy server
 */
/**
 * Real context window (tokens) for the model serving Claude Code's MAIN
 * conversation thread — the value for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
 *
 * Auto-compaction guards the main thread, which runs on ONE model: the `--model`
 * default, or an explicit `--opus`/`--sonnet` role mapping. We take the MIN real
 * per-provider window across those main-thread-eligible models so the thread
 * never overflows whichever backend serves it. The `haiku` (small/fast) and
 * `subagent` slots are EXCLUDED — they carry short, isolated contexts, so a tiny
 * window there must not drag the main thread's compaction point down.
 *
 * The window comes from the cloud catalog (never hardcoded), resolved against the
 * SAME provider the proxy routes to (`route().primary.provider`) — so bare
 * `gpt-*` resolves to `openai-codex`'s reduced window, not `openai`'s full one.
 * Explicit `provider@model` specs skip `route()` (parseModelSpec already has the
 * provider) — that path touches no credentials / 1Password. Returns 0 when no
 * window is known (not in the catalog cache) → caller leaves the env unset.
 */
/**
 * Below this, setting `CLAUDE_CODE_AUTO_COMPACT_WINDOW` DISABLES auto-compaction
 * instead of tightening it.
 *
 * Claude Code's arm predicate takes an extra branch once the window comes from a
 * non-default source (env/settings), and that branch bails outright on a small
 * window:
 *
 *   if (!hasConfiguredWindow(model, opt)) return tokens >= threshold(...)
 *   const { window } = resolveWindow(model, opt)
 *   if (window < 200_000) return false          // ← auto-compact silently OFF
 *   return tokens >= threshold(...)
 *
 * With the var unset the window's source stays "auto", that branch never runs,
 * and native auto-compaction behaves normally. So for any backend whose real
 * window is under 200K, staying silent is strictly safer than being precise.
 * (Claude Code also floors the configured value at 100K, so anything we set
 * below that is ignored regardless.)
 *
 * Verified against Claude Code 2.1.220.
 */
export const MIN_AUTO_COMPACT_WINDOW = 200_000;

export async function computeMainThreadContextWindow(
  config: ClaudishConfig,
  cachePath?: string
): Promise<number> {
  const specs = [config.model, config.modelOpus, config.modelSonnet].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (specs.length === 0) return 0;

  let min = Number.POSITIVE_INFINITY;
  for (const spec of specs) {
    try {
      const parsed = parseModelSpec(spec);
      let provider = parsed.provider;
      if (!parsed.isExplicitProvider) {
        // Bare name: resolve the backend the proxy will actually pick — the same
        // (memoized, process-shared) routing the proxy runs on the first request.
        const plan = await route(spec);
        if (plan.kind !== "ok") continue;
        provider = plan.primary.provider;
      }
      // Live discovery wins over the catalog: for subscription endpoints the
      // real window depends on the caller's tier (Kimi's k3 is 1M only on
      // Allegretto+), and the authenticated /models call answers for THIS user.
      // Providers without a modelDiscovery descriptor short-circuit to
      // undefined without a network call, so this stays free for everyone else.
      const win =
        (await discoverContextWindow(provider, parsed.model)) ??
        lookupModelForProvider(parsed.model, provider, cachePath);
      if (typeof win === "number" && win > 0) {
        min = Math.min(min, win);
      }
    } catch {
      // A routing/catalog hiccup for one slot must never block launch.
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** The env claudish hands Claude Code to describe the main thread's context. */
export interface ContextWindowEnv {
  /** Variables to merge into the child environment. */
  vars: Record<string, string>;
  /** Message for the user, or undefined when there is nothing worth saying. */
  notice?: string;
}

/**
 * Decide what to tell Claude Code about the main-thread model's context window.
 *
 * Two DIFFERENT levers, and the well-known one is useless without the other:
 * Claude Code resolves the compaction point as
 * `min(CLAUDE_CODE_AUTO_COMPACT_WINDOW, maxContextTokens(model))`, and for a
 * model name it has never heard of — every model claudish proxies —
 * `maxContextTokens` falls back to a hardcoded 200K. So passing only the window
 * override is silently clamped: a 1M-window Kimi subscription compacted at 200K
 * no matter what we sent, while the status line counted "% until auto-compact"
 * down against the clamped 180K. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` moves the cap.
 * Verified against Claude Code 2.1.220 (`SZc` resolves the max, `aY` applies the
 * `Math.min`).
 *
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set whenever the window is KNOWN, including
 * below `MIN_AUTO_COMPACT_WINDOW`: an accurate small window makes Claude Code
 * compact before a 128K backend overflows, where its 200K default overshoots.
 * That path leaves the window "unconfigured" from Claude Code's perspective
 * (its window source stays `"auto"`), so it does NOT trip the small-window bail
 * documented on `MIN_AUTO_COMPACT_WINDOW`. Claude Code also ignores the var
 * entirely for model names starting with `claude-`, so it can never disturb a
 * native Anthropic session.
 *
 * A user-set value for either var always wins — this only fills gaps.
 */
export function resolveContextWindowEnv(
  realWindow: number,
  processEnv: NodeJS.ProcessEnv = process.env
): ContextWindowEnv {
  const vars: Record<string, string> = {};
  if (!(realWindow > 0)) return { vars };

  if (!processEnv[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS]) {
    vars[ENV.CLAUDE_CODE_MAX_CONTEXT_TOKENS] = String(realWindow);
  }

  if (processEnv[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW]) return { vars };

  if (realWindow >= MIN_AUTO_COMPACT_WINDOW) {
    vars[ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW] = String(realWindow);
    return {
      vars,
      notice:
        `[claudish] Auto-compact window: ${realWindow.toLocaleString()} tokens ` +
        "(Claude Code compacts before the backend's real limit)",
    };
  }

  // Setting the window var here would be WORSE than leaving it unset — see
  // MIN_AUTO_COMPACT_WINDOW. CLAUDE_CODE_MAX_CONTEXT_TOKENS still carries the
  // real window, so native auto-compaction now fires against the true limit
  // instead of Claude Code's 200K default.
  return {
    vars,
    notice:
      `[claudish] Model's real context window (${realWindow.toLocaleString()}) is below ` +
      `Claude Code's ${MIN_AUTO_COMPACT_WINDOW.toLocaleString()}-token auto-compact floor — ` +
      "leaving CLAUDE_CODE_AUTO_COMPACT_WINDOW unset so native auto-compaction stays on.",
  };
}

export async function runClaudeWithProxy(
  config: ClaudishConfig,
  proxyUrl: string,
  onCleanup?: () => void
): Promise<number> {
  // Use actual OpenRouter model ID (no translation)
  // This ensures ANY model works, not just our shortlist
  // In profile/multi-model mode, don't set a single model - let Claude Code use its defaults
  // so the proxy can match tier names (opus/sonnet/haiku) and apply profile mappings
  const hasProfileMappings =
    config.modelOpus || config.modelSonnet || config.modelHaiku || config.modelSubagent;
  const modelId = config.model || (hasProfileMappings || config.monitor ? undefined : "unknown");

  // Extract port from proxy URL for token file path
  const portMatch = proxyUrl.match(/:(\d+)/);
  const port = portMatch ? portMatch[1] : "unknown";

  // Proxy mode authenticates via the placeholder API key, so a claude.ai-forcing
  // login policy would block the session. Compute it once, then neutralize it.
  const proxyAuthMode = isProxyAuthMode(config);

  // The OS *managed* settings tier cannot be overridden by our --settings overlay.
  // If it forces claude.ai login while we're in proxy mode, Claude Code will refuse
  // to start with an API key — fail fast with a clear reason instead of a confusing
  // downstream error. (Native-Anthropic/--monitor sessions use the real subscription,
  // so a claude.ai policy is fine there and we don't check.)
  if (proxyAuthMode && managedSettingsForcesClaudeAi()) {
    console.error(
      "[claudish] Error: your organization's managed Claude Code settings force the " +
        'claude.ai login method (forceLoginMethod: "claudeai").\n' +
        "  claudish routes Claude Code through its local proxy using API-key auth, which " +
        "that policy blocks at startup, and managed settings cannot be overridden.\n" +
        "  Ask your Claude Code administrator to relax this policy, or run a native " +
        "Anthropic model (which uses your real claude.ai subscription)."
    );
    onCleanup?.();
    return 1;
  }

  // Create temporary settings file with custom status line for this instance
  const { path: tempSettingsPath, statusLine } = createTempSettingsFile(
    modelId ?? "default",
    port,
    proxyAuthMode
  );

  // Merge user's --settings into our temp settings file if user provided one
  mergeUserSettingsIfPresent(config, tempSettingsPath, statusLine, proxyAuthMode);

  // Build claude arguments
  const claudeArgs: string[] = [];

  // Add settings file flag (our merged temp file, applies to this instance only)
  claudeArgs.push("--settings", tempSettingsPath);

  // Interactive mode - no automatic arguments
  if (config.interactive) {
    // In interactive mode, add permission skip if enabled
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
    // Forward user-provided passthrough args (e.g. --permission-mode, --effort, --add-dir)
    claudeArgs.push(...config.claudeArgs);
  } else {
    // Single-shot mode - add all arguments
    // Add -p flag FIRST to enable headless/print mode (non-interactive, exits after task).
    // Skip if the caller already passed -p/--print through (they are synonyms; adding
    // both is harmless to Claude Code but produces a confusing duplicated arg line).
    if (!config.claudeArgs.includes("-p") && !config.claudeArgs.includes("--print")) {
      claudeArgs.push("-p");
    }
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
    // Add JSON output format if requested
    if (config.jsonOutput) {
      claudeArgs.push("--output-format", "json");
    }
    // Add user-provided args as-is (including prompt and any Claude Code flags)
    claudeArgs.push(...config.claudeArgs);
  }

  // Check if this is a local model (ollama/, lmstudio/, vllm/, mlx/, or http:// URL)
  const isLocalModel = modelId
    ? modelId.startsWith("ollama/") ||
      modelId.startsWith("ollama:") ||
      modelId.startsWith("lmstudio/") ||
      modelId.startsWith("lmstudio:") ||
      modelId.startsWith("vllm/") ||
      modelId.startsWith("vllm:") ||
      modelId.startsWith("mlx/") ||
      modelId.startsWith("mlx:") ||
      modelId.startsWith("http://") ||
      modelId.startsWith("https://")
    : false;

  // Environment variables for Claude Code
  // For display: show profile name before first request; token file model_name takes over after
  const modelDisplayName = modelId || config.profile || "default";
  const env: Record<string, string> = {
    ...process.env,
    // Point Claude Code to our local proxy
    ANTHROPIC_BASE_URL: proxyUrl,
    // Set active model ID for status line (actual OpenRouter model ID)
    [ENV.CLAUDISH_ACTIVE_MODEL_NAME]: modelDisplayName,
    // Indicate if this is a local model (for status line to show "LOCAL" instead of cost)
    CLAUDISH_IS_LOCAL: isLocalModel ? "true" : "false",
  };

  // Set when a real ANTHROPIC_API_KEY was hidden so native Claude models bill the
  // claude.ai subscription instead of the API. Reported via log() further down —
  // the user MUST be able to discover why their key stopped taking effect.
  let hidAnthropicApiKey = false;

  // Remove Claude Code's nested-session guard variable.
  // When claudish is invoked from within Claude Code, CLAUDECODE is inherited
  // and causes the child Claude Code to refuse to start. Since claudish makes
  // independent API calls through a proxy (not nesting sessions), this is safe.
  delete env.CLAUDECODE;

  // Handle API key and model based on mode
  if (config.monitor) {
    // Monitor mode: Don't set ANTHROPIC_API_KEY at all
    // This allows Claude Code to use its native authentication
    // Delete any placeholder keys from environment
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Don't override ANTHROPIC_MODEL - let Claude Code use its default
    // (unless user explicitly specified a model)
    if (modelId) {
      env[ENV.ANTHROPIC_MODEL] = modelId;
      env[ENV.ANTHROPIC_SMALL_FAST_MODEL] = modelId;
    }
  } else {
    // Set Claude Code standard model environment variables
    // When using profile mode (no explicit --model), DON'T override ANTHROPIC_MODEL
    // Let Claude Code use its default model names (e.g., "claude-sonnet-4-5-20250929")
    // so the proxy can match "opus"/"sonnet"/"haiku" in the model name and apply mappings
    if (modelId) {
      env[ENV.ANTHROPIC_MODEL] = modelId;
      env[ENV.ANTHROPIC_SMALL_FAST_MODEL] = modelId;
    }
    if (hasNativeAnthropicMapping(config)) {
      // Native Claude model detected — Claude Code talks to Anthropic directly,
      // so its own claude.ai subscription login should serve the request.
      //
      // A real ANTHROPIC_API_KEY in the environment silently OVERRIDES that
      // subscription and switches the session to metered API billing. That key
      // is usually incidental: a .env / 1Password Environment that bundles
      // ANTHROPIC_API_KEY next to the OPENAI/GEMINI/XAI keys claudish actually
      // needs. Reading its mere presence as "bill me per token" is an expensive
      // misread, and the failure is silent — you find out on the invoice. So
      // hide it by default and SAY so; opt back in explicitly when API billing
      // is what you want. ANTHROPIC_AUTH_TOKEN is left alone — nothing bundles
      // one incidentally, so setting it is always a deliberate act.
      if (process.env.ANTHROPIC_API_KEY && !wantsAnthropicApiBilling(config)) {
        delete env.ANTHROPIC_API_KEY;
        hidAnthropicApiKey = true;
      }
    } else {
      // Pure proxy mode: EVERY model goes through a claudish provider, so the
      // session never makes a real Anthropic call and a real Anthropic key here
      // is dead weight. Forwarding one is actively harmful: Claude Code then
      // reports "API Usage Billing", and pairing it with the placeholder token
      // trips "Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set · auth may
      // not work as expected". So overwrite unconditionally with placeholders —
      // their only job is suppressing the login dialog (#13: a placeholder API
      // key alone still redirected to the payment page, hence the token too).
      env.ANTHROPIC_API_KEY =
        "sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx";
      env.ANTHROPIC_AUTH_TOKEN = "placeholder-token-not-used-proxy-handles-auth";

      // Drive Claude Code's NATIVE auto-compaction to fire before a backend whose
      // real context window is smaller than the model's advertised spec rejects
      // the request. The ChatGPT Codex OAuth backend caps gpt-5.6-sol at ~372K vs
      // its 1.05M API spec, so Claude Code (assuming the large window) never
      // compacts and the session hard-sticks at overflow. CLAUDE_CODE_AUTO_COMPACT_WINDOW
      // is Claude Code's documented lever for exactly this ("the gateway enforces
      // a smaller context than the model's native window"); it clamps the value to
      // [100K, its understood window], so this can only make it compact EARLIER —
      // never overflow. Respect a user-set value; otherwise use the real
      // per-provider window from the cloud catalog (never hardcoded).
      const realWindow = await computeMainThreadContextWindow(config);
      const contextEnv = resolveContextWindowEnv(realWindow, process.env);
      Object.assign(env, contextEnv.vars);
      if (contextEnv.notice && !config.quiet) {
        console.error(contextEnv.notice);
      }
    }
  }

  // Helper function to log claudish's own chatter (respects quiet flag).
  // In single-shot/print mode, stdout belongs to Claude Code's machine-readable
  // output (e.g. --output-format stream-json, parsed line-by-line by consumers
  // like madbench), so claudish must never write to it. Route to stderr instead —
  // humans read stderr equally well. Interactive mode keeps stdout.
  const log = (message: string) => {
    if (!config.quiet) {
      if (config.interactive) {
        console.log(message);
      } else {
        console.error(message);
      }
    }
  };

  if (!config.monitor && hasNativeAnthropicMapping(config)) {
    log("[claudish] Native Claude model detected — using Claude Code subscription credentials");
    if (hidAnthropicApiKey) {
      log(
        "[claudish]   ANTHROPIC_API_KEY found but hidden so it can't override that subscription · " +
          "use --anthropic-api-billing (or anthropicApiBilling: true) to bill the API instead"
      );
    }
  }

  if (config.interactive) {
    log(`\n[claudish] Model: ${modelDisplayName}\n`);
  } else {
    log(`\n[claudish] Model: ${modelDisplayName}`);
    log(`[claudish] Arguments: ${claudeArgs.join(" ")}\n`);
  }

  // Find Claude binary (supports CLAUDE_PATH, local installation, and global PATH)
  const claudeBinary = await findClaudeBinary();
  if (!claudeBinary) {
    console.error("Error: Claude Code CLI not found");
    console.error("Install it from: https://claude.com/claude-code");
    console.error("\nOr set CLAUDE_PATH to your custom installation:");
    const home = homedir();
    const localPath = isWindows()
      ? join(home, ".claude", "local", "claude.exe")
      : join(home, ".claude", "local", "claude");
    console.error(`  export CLAUDE_PATH=${localPath}`);
    process.exit(1);
  }

  // Spawn Claude Code with direct stdio: 'inherit' — no terminal multiplexer wrapper.
  const needsShell = isWindows() && claudeBinary.endsWith(".cmd");
  const spawnCommand = needsShell ? `"${claudeBinary}"` : claudeBinary;

  // Signal telemetry that the child now owns the TTY — suppresses the consent
  // prompt readline that would otherwise race the child for stdin (#85/88/99).
  setClaudeCodeRunning(true);

  // stdio selection.
  //
  // Normally we inherit claudish's own fds. But claudish decides interactive
  // mode from ARGS (no positional prompt, no --stdin), independent of TTY
  // state — whereas Claude Code decides interactive-vs-print from whether its
  // STDOUT is a TTY ("non-interactive mode ... when stdout is not a TTY, e.g.
  // piped" — claude --help). When claudish runs under a wrapper that pipes
  // stdout/stderr but leaves stdin a TTY (notably `op run`, which pipes
  // stdout/stderr to mask secrets), a blind `inherit` hands the child a piped
  // fd 1 → the child self-selects --print → with no prompt it dies with
  // "Input must be provided either through stdin or as a prompt argument when
  // using --print". claudish's interactive INTENT and the child's interactive
  // REALITY diverge.
  //
  // Fix: when we intend interactive but our own stdout is NOT a TTY while stdin
  // STILL is (the op-run shape), open a fresh writable handle to the SAME
  // terminal as stdin and hand it to the child as stdout+stderr, so the child
  // sees a TTY on fd 1 and launches its real interactive UI. We cannot reuse
  // fd 0 directly (Bun rejects the stdin fd in a stdout/stderr slot:
  // ERR_INVALID_ARG_TYPE), and /dev/tty is detached (ENXIO) under op run — so
  // we open "/dev/fd/0", which resolves to stdin's underlying tty and yields a
  // distinct fd number. claudish writes nothing to its own stdout during an
  // interactive run (logs go to stderr), so abandoning the piped fd 1 for the
  // child loses nothing. Any failure falls back to plain "inherit".
  let ttyFd: number | undefined;
  const childWantsTty = config.interactive && !process.stdout.isTTY && Boolean(process.stdin.isTTY);
  if (childWantsTty) {
    try {
      const fd = openSync("/dev/fd/0", "r+");
      if (isatty(fd)) {
        ttyFd = fd;
      } else {
        closeSync(fd); // not actually a tty — don't use it
      }
    } catch {
      ttyFd = undefined; // couldn't open a writable tty handle — fall back below
    }
  } else if (config.interactive && !process.stdout.isTTY && !process.stdin.isTTY) {
    // Truly headless: interactive intent but no terminal on any stream. The
    // child would fall into --print and emit a cryptic error; surface an
    // actionable one instead.
    console.error(
      "[claudish] An interactive session was requested but no terminal is attached " +
        "(stdin and stdout are both non-TTY). Pass a prompt argument, or use --stdin / -p " +
        "for non-interactive mode."
    );
  }

  const stdio: Parameters<typeof spawn>[2]["stdio"] =
    ttyFd !== undefined ? [0, ttyFd, ttyFd] : "inherit";

  const proc = spawn(spawnCommand, claudeArgs, {
    env,
    stdio,
    shell: needsShell,
  });

  // From this line until the child exits, Claude Code owns the terminal. Close
  // claudish's write channel to it so a stray console.error — ours, a
  // dependency's, or the Bun runtime's — cannot land inside a frame the child
  // is painting. Interactive only: in --print/--stdin mode there is no TUI to
  // corrupt, and claudish's chatter on stderr is expected to be visible.
  if (config.interactive) {
    restoreTerminal = beginTerminalIsolation((entry) => {
      // "[Suppressed]" prefix is load-bearing: logger's isStructuralLogWorthy
      // matches it, which is what persists this line into the durable session
      // log. logStderr also mirrors it to the diag file for a live `tail`.
      logStderr(`[Suppressed] ${entry.source}: ${entry.text.trimEnd()}`);
    });
  }

  // Close our copy of the tty write fd once the child has inherited it. The
  // child keeps its own dup, so this doesn't disturb the running session.
  if (ttyFd !== undefined) {
    const fdToClose = ttyFd;
    proc.on("spawn", () => {
      try {
        closeSync(fdToClose);
      } catch {
        /* already closed */
      }
    });
  }

  // Handle process termination signals (includes cleanup)
  setupSignalHandlers(proc, tempSettingsPath, config.quiet, onCleanup);

  // Wait for claude to exit
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("exit", (code) => {
      setClaudeCodeRunning(false);
      resolve(code ?? 1);
    });
  });

  // The child has released the terminal — claudish may speak again. Restore
  // BEFORE any shutdown message, or the caller's "Shutting down proxy…" line
  // would be swallowed by our own firewall.
  releaseTerminalIsolation();

  // Clean up temporary settings file
  try {
    unlinkSync(tempSettingsPath);
  } catch {
    // Ignore cleanup errors
  }

  return exitCode;
}

/**
 * Setup signal handlers to gracefully shutdown
 */
function setupSignalHandlers(
  proc: ChildProcess,
  tempSettingsPath: string,
  quiet: boolean,
  onCleanup?: () => void
): void {
  // Windows only supports SIGINT and SIGTERM reliably
  // SIGHUP doesn't exist on Windows
  const signals: NodeJS.Signals[] = isWindows()
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

  for (const signal of signals) {
    process.on(signal, () => {
      // Lift the firewall first — the child is going away, and the shutdown
      // notice below must reach the user rather than the diag log.
      releaseTerminalIsolation();
      if (!quiet) {
        // stderr: this is claudish's own diagnostic chatter and must not land
        // on stdout, which may carry Claude Code's machine-readable output.
        console.error(`\n[claudish] Received ${signal}, shutting down...`);
      }
      proc.kill();
      // Run optional cleanup before exit
      if (onCleanup) {
        try {
          onCleanup();
        } catch {
          // Ignore cleanup errors
        }
      }
      // Clean up temp settings file
      try {
        unlinkSync(tempSettingsPath);
      } catch {
        // Ignore cleanup errors
      }
      process.exit(0);
    });
  }
}

/**
 * Find Claude Code binary in priority order:
 * 1. CLAUDE_PATH env var
 * 2. Local installation (~/.claude/local/claude)
 * 3. Global PATH
 */
async function findClaudeBinary(): Promise<string | null> {
  const isWindows = process.platform === "win32";

  // 1. Check CLAUDE_PATH env var
  if (process.env.CLAUDE_PATH) {
    if (existsSync(process.env.CLAUDE_PATH)) {
      return process.env.CLAUDE_PATH;
    }
  }

  // 2. Check local installation
  const home = homedir();
  const localPath = isWindows
    ? join(home, ".claude", "local", "claude.exe")
    : join(home, ".claude", "local", "claude");

  if (existsSync(localPath)) {
    return localPath;
  }

  // 3. Check common global installation paths
  if (isWindows) {
    // Windows: Check npm global paths for .cmd files
    const windowsPaths = [
      join(home, "AppData", "Roaming", "npm", "claude.cmd"), // npm global (default)
      join(home, ".npm-global", "claude.cmd"), // Custom npm prefix
      join(home, "node_modules", ".bin", "claude.cmd"), // Local node_modules
    ];

    for (const path of windowsPaths) {
      if (existsSync(path)) {
        return path;
      }
    }
  } else {
    // Mac/Linux/Android paths
    const commonPaths = [
      "/usr/local/bin/claude", // Homebrew (Intel), npm global
      "/opt/homebrew/bin/claude", // Homebrew (Apple Silicon)
      join(home, ".npm-global/bin/claude"), // Custom npm global prefix
      join(home, ".local/bin/claude"), // User-local installations
      join(home, "node_modules/.bin/claude"), // Local node_modules
      // Termux (Android) paths
      "/data/data/com.termux/files/usr/bin/claude",
      join(home, "../usr/bin/claude"), // Termux relative path
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check global PATH using command -v (portable) / where (Windows)
  // Use shell: true to inherit user's PATH from .zshrc/.bashrc (fixes Mac detection)
  // Note: "command -v" is a shell builtin, more portable than "which" (works on Termux without extra packages)
  try {
    // On Windows use "where claude", on Unix use "command -v claude" (shell builtin, no external dependency)
    const shellCommand = isWindows ? "where claude" : "command -v claude";

    const proc = spawn(shellCommand, [], {
      stdio: "pipe",
      shell: true, // Always use shell to inherit user's PATH and run builtins
    });

    let output = "";
    proc.stdout?.on("data", (data) => {
      output += data.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });

    if (exitCode === 0 && output.trim()) {
      const lines = output.trim().split(/\r?\n/);

      if (isWindows) {
        // On Windows, prefer .cmd file over shell script
        const cmdPath = lines.find((line) => line.endsWith(".cmd"));
        if (cmdPath) {
          return cmdPath;
        }
      }

      // Return first line (primary match)
      return lines[0];
    }
  } catch {
    // Command failed
  }

  return null;
}

/**
 * Check if Claude Code CLI is installed
 */
export async function checkClaudeInstalled(): Promise<boolean> {
  const binary = await findClaudeBinary();
  return binary !== null;
}
