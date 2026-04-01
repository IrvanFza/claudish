import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * MtmDiagRunner spawns Claude Code inside mtm — a real terminal multiplexer.
 *
 * Layout:
 *   Top pane  (~97%): Claude Code with a REAL PTY — mtm owns the terminal
 *   Bottom pane (~1 line): claudish status bar (model, errors)
 *
 * mtm is launched with:
 *   mtm -e "claude args..." -s 3 -b "status watcher"
 *
 * Diagnostics are written to ~/.claudish/diag-<PID>.log.
 * Status bar is updated via ~/.claudish/status-<PID>.txt.
 */
export class MtmDiagRunner {
  private mtmProc: ChildProcess | null = null;
  private logPath: string;
  private statusPath: string;
  private logStream: WriteStream | null = null;

  constructor() {
    const dir = join(homedir(), ".claudish");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Already exists
    }
    this.logPath = join(dir, `diag-${process.pid}.log`);
    this.statusPath = join(dir, `status-${process.pid}.txt`);
    this.logStream = createWriteStream(this.logPath, { flags: "w" });
    this.logStream.on("error", () => {}); // Best-effort
    // Status file is NOT pre-populated — mtm starts with full terminal.
    // Status bar appears dynamically on first write (mtm reshapes the pane).
  }

  /**
   * Launch mtm with Claude Code in the top pane. Returns the exit code when
   * mtm exits (which happens when Claude Code exits, closing the last pane).
   *
   * @param claudeCommand  Full path to the claude binary
   * @param claudeArgs     Arguments to pass to claude
   * @param env            Environment variables for the claude process
   */
  async run(
    claudeCommand: string,
    claudeArgs: string[],
    env: Record<string, string>
  ): Promise<number> {
    const mtmBin = this.findMtmBinary();

    // Build the claude command — just the binary + args, no env vars inline.
    // Environment is passed via spawn's env option (inherited by mtm's child panes).
    const quotedArgs = claudeArgs.map((a) => shellQuote(a)).join(" ");
    const claudeCmd = `${shellQuote(claudeCommand)} ${quotedArgs}`;

    // Merge claudish env overrides with current process env.
    // mtm inherits this env and passes it to child panes (both top and bottom).
    const mergedEnv = { ...process.env, ...env } as Record<string, string>;

    // Launch mtm:
    // -e claudeCmd  : run claude in the main pane
    // -S statusPath : render status bar on the last row (not a pane, just 1 ncurses line)
    // -L logPath    : diagnostic log file for expanded view (click status bar or Ctrl-G d)
    // stdio: inherit — mtm gets direct terminal access
    this.mtmProc = spawn(
      mtmBin,
      ["-t", "xterm-256color", "-e", claudeCmd, "-S", this.statusPath, "-L", this.logPath],
      {
        stdio: "inherit",
        env: mergedEnv,
      }
    );

    const exitCode = await new Promise<number>((resolve) => {
      this.mtmProc!.on("exit", (code) => {
        resolve(code ?? 1);
      });
      this.mtmProc!.on("error", (err) => {
        if (this.logStream) {
          try {
            this.logStream.write(`[mtm] spawn error: ${err.message}\n`);
          } catch {}
        }
        resolve(1);
      });
    });

    this.cleanup();
    return exitCode;
  }

  /**
   * Write a diagnostic message to the log file AND update the status bar.
   */
  write(msg: string): void {
    if (!this.logStream) return;
    const timestamp = new Date().toISOString();
    try {
      this.logStream.write(`[${timestamp}] ${msg}\n`);
    } catch {
      // Ignore write errors — diag output is best-effort
    }
    // Parse and track metrics from log messages
    const parsed = parseLogMessage(msg);
    if (parsed.isError) {
      this.errorCount++;
      this.lastError = parsed.short;
      if (parsed.provider) this.provider = parsed.provider;
    }
    // Track request count from streaming handler
    if (msg.includes("HANDLER STARTED") || msg.includes("=== Request")) {
      this.requestCount++;
    }
    // Track roundtrip time
    const rtMatch = msg.match(/(\d+)ms\b/);
    if (rtMatch && msg.includes("Response")) {
      const ms = parseInt(rtMatch[1], 10);
      this.roundtripSamples.push(ms);
      if (this.roundtripSamples.length > 20) this.roundtripSamples.shift();
      this.avgRoundtripMs = Math.round(
        this.roundtripSamples.reduce((a, b) => a + b, 0) / this.roundtripSamples.length
      );
    }
    // Track adapter composition from probe output
    if (msg.includes("Format:") || msg.includes("Transport:") || msg.includes("Translator:")) {
      const parts = msg.split(":").slice(1).join(":").trim();
      if (parts) this.adapters = parts;
    }
    // Track provider name from auth refresh messages
    // e.g., "[GeminiCodeAssist] Auth refreshed, project: ..., tier: GeminiCA Pro"
    if (msg.includes("Auth refreshed") && msg.includes("tier:")) {
      const tierMatch = msg.match(/tier:\s*(.+)$/);
      if (tierMatch) this.provider = tierMatch[1].trim();
    }
    // Track fallback provider from FallbackHandler
    // e.g., "[Fallback] Gemini succeeded after 1 failed attempt(s)"
    if (msg.includes("[Fallback]") && msg.includes("succeeded")) {
      const fbMatch = msg.match(/\[Fallback\]\s+(\S+)\s+succeeded/);
      if (fbMatch) this.provider = fbMatch[1];
    }
    // Track quota from logStderr messages
    // e.g., "[GeminiCodeAssist] Rate limited (RATE_LIMIT_EXCEEDED), retrying in 10.0s"
    if (msg.includes("Rate limited") && msg.includes("retrying")) {
      this.lastError = msg.replace(/.*\]\s*/, "").substring(0, 60);
    }
    this.refreshStatusBar();
  }

  /** Current status bar state */
  private modelName = "";
  private provider = "";
  private port = "";
  private quotaRemaining: number | undefined;
  private tokenPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastError = "";
  private errorCount = 0;
  private requestCount = 0;
  private totalCost = 0;
  private avgRoundtripMs = 0;
  private roundtripSamples: number[] = [];
  private adapters = ""; // translation layers: format + model + transport

  /** Set the proxy port (for reading token file) and start polling for updates */
  setPort(port: number | string): void {
    this.port = String(port);
    // Poll token file every 3s to pick up provider name and quota after first request
    this.tokenPollTimer = setInterval(() => {
      const changed = this.readTokenFile();
      if (changed) this.refreshStatusBar();
    }, 3000);
  }

  /**
   * Set the model name shown in the status bar.
   */
  setModel(name: string): void {
    // Strip vendor prefix: "openrouter/hunter-alpha" → "hunter-alpha"
    this.modelName = name.includes("/") ? name.split("/").pop()! : name;
    // Extract provider from prefix if present
    if (name.includes("@")) {
      this.provider = name.split("@")[0];
    } else if (name.includes("/")) {
      this.provider = name.split("/")[0];
    }
    // Don't write to status file yet — mtm starts with full terminal.
    // Status bar appears on first diagnostic event (write() call).
  }

  /**
   * Render and write the ANSI-formatted status bar to the status file.
   */
  /** Read provider/quota from token file. Returns true if anything changed. */
  private readTokenFile(): boolean {
    if (!this.port) return false;
    try {
      const tokPath = join(homedir(), ".claudish", `tokens-${this.port}.json`);
      const tok = JSON.parse(readFileSync(tokPath, "utf-8"));
      let changed = false;
      if (typeof tok.quota_remaining === "number" && tok.quota_remaining !== this.quotaRemaining) {
        this.quotaRemaining = tok.quota_remaining;
        changed = true;
      }
      if (tok.provider_name && tok.provider_name !== this.provider) {
        this.provider = tok.provider_name;
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  }

  private refreshStatusBar(): void {
    this.readTokenFile();

    const bar = renderStatusBar({
      model: this.modelName,
      provider: this.provider,
      errorCount: this.errorCount,
      lastError: this.lastError,
      requestCount: this.requestCount,
      avgRoundtripMs: this.avgRoundtripMs,
      quotaRemaining: this.quotaRemaining,
    });
    try {
      // Append new line — tail -f picks it up and shows the latest
      appendFileSync(this.statusPath, bar + "\n");
    } catch {
      // Best-effort
    }
  }

  /**
   * Get the diag log file path for this session.
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Clean up: close the log stream and remove the ephemeral log file.
   */
  cleanup(): void {
    if (this.tokenPollTimer) {
      clearInterval(this.tokenPollTimer);
      this.tokenPollTimer = null;
    }
    if (this.logStream) {
      try {
        this.logStream.end();
      } catch {
        // Ignore
      }
      this.logStream = null;
    }
    try {
      unlinkSync(this.logPath);
    } catch {}
    try {
      unlinkSync(this.statusPath);
    } catch {}
    if (this.mtmProc) {
      try {
        this.mtmProc.kill();
      } catch {
        // Process may already be gone
      }
      this.mtmProc = null;
    }
  }

  /**
   * Find the mtm binary. Priority:
   * 1. Bundled binary relative to package root (native/mtm/mtm-<platform>-<arch> or mtm)
   * 2. mtm in PATH (only if it supports -e flag — upstream mtm doesn't)
   */
  findMtmBinary(): string {
    // Resolve __dirname equivalent for ESM
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);

    const platform = process.platform;
    const arch = process.arch;

    // Package root is one level up from dist/ or src/
    const pkgRoot = join(thisDir, "..");

    // 1a. Platform-specific bundled binary (distributed with npm package)
    const bundledPlatform = join(pkgRoot, "native", "mtm", `mtm-${platform}-${arch}`);
    if (existsSync(bundledPlatform)) return bundledPlatform;

    // 1b. Generic built binary (dev mode — run `make` in packages/cli/native/mtm/)
    const builtDev = join(pkgRoot, "native", "mtm", "mtm");
    if (existsSync(builtDev)) return builtDev;

    // 2. mtm in PATH — but only our fork that supports -e (execute command).
    // Upstream mtm (e.g. Homebrew) only supports -T/-t/-c and will fail with
    // "illegal option -- e" when we try to launch Claude Code.
    try {
      const result = execSync("which mtm", { encoding: "utf-8" }).trim();
      if (result && this.isMtmFork(result)) return result;
    } catch {
      // Not in PATH
    }

    throw new Error("mtm binary not found. Build it with: cd packages/cli/native/mtm && make");
  }

  /**
   * Check if an mtm binary is our fork (supports -e flag).
   * Upstream mtm's usage line: "usage: mtm [-T NAME] [-t NAME] [-c KEY]"
   * Our fork's usage line includes "-e CMD".
   */
  private isMtmFork(binPath: string): boolean {
    try {
      // mtm prints usage to stderr and exits non-zero for --help / bad args
      const output = execSync(`"${binPath}" --help 2>&1 || true`, {
        encoding: "utf-8",
        timeout: 2000,
      });
      return output.includes("-e ");
    } catch {
      return false;
    }
  }
}

/**
 * Shell-quote a string so it can be safely embedded in a shell command.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

interface StatusBarState {
  model: string;
  provider: string;
  errorCount: number;
  lastError: string;
  requestCount: number;
  avgRoundtripMs: number;
  quotaRemaining?: number;
}

/**
 * Render the status bar in mtm's tab-separated format.
 * Each segment: "COLOR:text" separated by tabs.
 * Colors: M=magenta, C=cyan, G=green, R=red, D=dim, W=white
 * mtm renders each segment as a colored pill using ncurses.
 */
function renderStatusBar(state: StatusBarState): string {
  const { model, provider, errorCount, lastError, requestCount, avgRoundtripMs, quotaRemaining } = state;

  const parts: string[] = [];

  parts.push("M: claudish ");
  if (provider) parts.push(`D: ${provider} `);
  if (model) parts.push(`C: ${model} `);

  // Status: ok or error
  if (errorCount > 0) {
    const errLabel = errorCount === 1 ? " ⚠ 1 error " : ` ⚠ ${errorCount} errors `;
    parts.push(`R:${errLabel}`);
    if (lastError) parts.push(`D: ${lastError} `);
  } else {
    parts.push("G: ● ok ");
  }

  // Quota remaining (for Code Assist models) — after status
  if (typeof quotaRemaining === "number") {
    const pct = Math.round(quotaRemaining * 100);
    const color = pct > 50 ? "G" : pct > 20 ? "Y" : "R";
    parts.push(`${color}: ${pct}% quota `);
  }

  return parts.join("\t");
}

/**
 * Parse a logStderr message into a short, human-readable form.
 */
function parseLogMessage(msg: string): { isError: boolean; short: string; provider?: string } {
  // Extract provider name: "Error [OpenRouter]: ..." or "Error [Gemini Free]: ..."
  // Use [^\]]+ to handle spaces/hyphens. Exclude [Fallback] and [Streaming] as providers.
  const providerMatch = msg.match(/\[(?!Fallback|Streaming|Auto-route|SSE)([^\]]+)\]/);
  const provider = providerMatch?.[1];

  // "All providers failed" — this IS an error, not just a fallback info message
  if (msg.includes("All") && msg.includes("failed")) {
    const countMatch = msg.match(/All (\d+)/);
    return { isError: true, short: `all ${countMatch?.[1] || ""} providers failed`, provider };
  }

  // Fallback chain messages (check BEFORE HTTP — fallback msgs contain "HTTP NNN" too)
  if (msg.includes("[Fallback]")) {
    if (msg.includes("succeeded")) {
      const n = msg.match(/after (\d+)/)?.[1] || "?";
      return { isError: false, short: `succeeded after ${n} retries`, provider };
    }
    // "Gemini Code Assist failed (HTTP 401), trying next provider..."
    const failMatch = msg.match(/\]\s*(.+?)\s+failed/);
    return {
      isError: false,
      short: failMatch ? `${failMatch[1]} failed, retrying` : "fallback",
      provider,
    };
  }

  // HTTP status errors — extract the human-readable part
  const httpMatch = msg.match(/HTTP (\d{3})/);
  if (httpMatch) {
    const jsonMatch = msg.match(/"message"\s*:\s*"([^"]+)"/);
    if (jsonMatch?.[1]) {
      const detail = jsonMatch[1]
        .replace(/is not a valid model ID/, "invalid model")
        .replace(/Provider returned error/, "provider error");
      return { isError: true, short: detail, provider };
    }
    const hintMatch = msg.match(/HTTP \d{3}\.\s*(.+?)\.?\s*$/);
    if (hintMatch?.[1]) {
      return { isError: true, short: hintMatch[1], provider };
    }
    return { isError: true, short: `HTTP ${httpMatch[1]}`, provider };
  }

  // Generic error — strip provider prefix
  if (msg.toLowerCase().includes("error")) {
    const short = msg.replace(/^Error\s*\[[^\]]+\]:\s*/, "").replace(/\.\s*$/, "");
    return { isError: true, short: short.length > 80 ? short.slice(0, 79) + "…" : short, provider };
  }

  return { isError: false, short: msg.length > 80 ? msg.slice(0, 79) + "…" : msg };
}

/**
 * Try to create an MtmDiagRunner. Returns null if mtm binary is not available.
 */
export async function tryCreateMtmRunner(): Promise<MtmDiagRunner | null> {
  // Don't nest mtm inside mtm (e.g., grid mode panes)
  if (process.env.MTM) return null;

  try {
    const runner = new MtmDiagRunner();
    // Verify we can find the mtm binary before committing
    runner.findMtmBinary();
    return runner;
  } catch {
    return null;
  }
}

// Re-export DiagMessage interface for use by other modules
export interface DiagMessage {
  text: string;
  level: "error" | "warn" | "info";
}

/**
 * PtyDiagRunner is kept as a type alias for backward compatibility.
 * New code should use MtmDiagRunner directly.
 * @deprecated Use MtmDiagRunner
 */
export { MtmDiagRunner as PtyDiagRunner };

/**
 * tryCreatePtyRunner is kept for backward compatibility with index.ts.
 * @deprecated Use tryCreateMtmRunner
 */
export const tryCreatePtyRunner = tryCreateMtmRunner;
