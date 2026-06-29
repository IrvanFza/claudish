// ─── SignalWatcher ────────────────────────────────────────────────────────────
//
// Per-session state machine that detects events from stdout output patterns
// and dispatches notifications via a callback.

import type { SignalCallback, SignalData, SignalState } from "./types.js";

/** How long to wait after last output before declaring "waiting_for_input". */
const QUIET_PERIOD_MS = 2000;

/** Debounce window for batching rapid tool_executing events. */
const TOOL_BATCH_MS = 500;

/** Patterns that indicate Claude Code is executing a tool. */
const TOOL_PATTERNS = [
  /^\s*⏺\s+(Read|Write|Edit|Bash|Glob|Grep|Agent|Skill|WebSearch|WebFetch)\b/m,
  /^\s*Tool:\s+\w+/m,
  /^\s*Running\s+\w+\.\.\./m,
];

/** Patterns that suggest the model is asking a question. */
const QUESTION_PATTERNS = [/\?\s*$/m, /\bchoose\b.*:/im, /\bselect\b.*:/im, /\benter\b.*:/im];

export class SignalWatcher {
  private _state: SignalState = "starting";
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private toolBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private toolBatchCount = 0;
  private toolBatchName: string | null = null;
  private lastChunkHadQuestion = false;
  private disposed = false;

  constructor(
    private sessionId: string,
    private callback: SignalCallback,
    private quietPeriodMs = QUIET_PERIOD_MS
  ) {}

  /** Current state. */
  get state(): SignalState {
    return this._state;
  }

  /** Feed raw stdout text. Called by SessionManager on each chunk. */
  feed(text: string): void {
    if (this.disposed) return;

    // Reset quiet timer on every chunk
    this.clearQuietTimer();

    const lines = text.split("\n").filter((l) => l.trim());

    // Transition starting → running on first output
    if (this._state === "starting" && lines.length > 0) {
      this.transition("running", { content: lines[0] });
    }

    // Detect tool execution patterns
    const toolMatch = this.detectToolUse(text);
    if (toolMatch) {
      this.handleToolDetection(toolMatch);
    } else if (this._state === "tool_executing" && lines.length > 0) {
      // Tool finished producing output, back to running
      this.transition("running");
    }

    // Check for question patterns
    this.lastChunkHadQuestion = QUESTION_PATTERNS.some((p) => p.test(text));

    // Start quiet timer for input_required detection
    this.quietTimer = setTimeout(() => {
      if (this.lastChunkHadQuestion && this._state === "running") {
        const lastLine = lines[lines.length - 1] || text.trim();
        this.transition("waiting_for_input", { content: lastLine });
      }
    }, this.quietPeriodMs);
  }

  /** Notify that the process exited. */
  processExited(exitCode: number | null): void {
    if (this.disposed) return;
    this.clearTimers();

    if (this._state === "cancelled") return; // already forced

    if (exitCode === 0) {
      this.transition("completed");
    } else {
      this.transition("failed", {
        content: `Process exited with code ${exitCode ?? "unknown"}`,
      });
    }
  }

  /** Manually set state (e.g., for cancel). */
  forceState(state: SignalState, content?: string): void {
    if (this.disposed) return;
    this.clearTimers();
    this.transition(state, content ? { content } : undefined);
  }

  /** Clean up timers. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private transition(newState: SignalState, extra?: Partial<SignalData>): void {
    const prev = this._state;
    if (prev === newState && !extra?.toolCount) return; // no-op unless batched tool event
    this._state = newState;

    this.callback(this.sessionId, {
      previousState: prev,
      newState,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  private detectToolUse(text: string): string | null {
    for (const pattern of TOOL_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Extract tool name from match
        const nameMatch = match[0].match(
          /\b(Read|Write|Edit|Bash|Glob|Grep|Agent|Skill|WebSearch|WebFetch|Tool:\s*\w+)\b/
        );
        return nameMatch ? nameMatch[1].replace("Tool: ", "") : "unknown";
      }
    }
    return null;
  }

  private handleToolDetection(toolName: string): void {
    this.toolBatchCount++;
    this.toolBatchName = toolName;

    if (this._state !== "tool_executing") {
      // First tool in batch — transition immediately
      this.transition("tool_executing", { toolName, toolCount: 1 });
    }

    // Reset batch timer (debounce)
    if (this.toolBatchTimer) clearTimeout(this.toolBatchTimer);
    this.toolBatchTimer = setTimeout(() => {
      // Batch complete — emit aggregated notification if multiple
      if (this.toolBatchCount > 1) {
        this.transition("tool_executing", {
          toolName: this.toolBatchName ?? undefined,
          toolCount: this.toolBatchCount,
        });
      }
      this.toolBatchCount = 0;
      this.toolBatchName = null;
    }, TOOL_BATCH_MS);
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearQuietTimer();
    if (this.toolBatchTimer) {
      clearTimeout(this.toolBatchTimer);
      this.toolBatchTimer = null;
    }
  }
}
