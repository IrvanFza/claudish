/**
 * Periodic `notifications/progress` keepalive for long-blocking MCP tools.
 *
 * Claude Code aborts a tool call that emits nothing for the MCP idle window
 * ("sent no response or progress for 1800s; aborting"). A progress notification
 * resets that timer; a `notifications/claude/channel` frame does not — measured
 * 2026-08-14 on 2.1.231, see
 * ai-docs/sessions/mcp-progress-idle-timeout-20260814-000000-b7e21f4a/findings.md.
 *
 * The emitter is TIME-driven on purpose. `team` already emitted channel frames on
 * every state change and still died at exactly 1800s, because a model that thinks
 * for 30 minutes produces no state changes — an event-driven emitter is silent
 * exactly when the idle timer is counting.
 *
 * The FIRST frame fires at t+intervalMs, never at t=0: `setInterval` semantics are
 * the intended ones here. The smallest idle window a host can actually configure is
 * ~30s (values below that were silently ignored), so a first frame at 10s still
 * leaves 20s of margin, while a tool call that finishes in 200ms — `team status`,
 * `create_session` — stays completely silent and puts nothing extra on the wire.
 */

/** MCP `ProgressToken` — the spec allows a string or a number. */
export type ProgressToken = string | number;

export interface ProgressFrame {
  progressToken: ProgressToken;
  /** Strictly increasing, per the spec. Starts at 1. */
  progress: number;
  message?: string;
}

/** Emits one frame. Sync-throwing or promise-rejecting are both tolerated. */
export type ProgressSender = (frame: ProgressFrame) => unknown;

export interface HeartbeatHandle {
  /** Emit one frame immediately, sharing the monotonic counter. Never throws. */
  tick(message?: string): void;
  /** Idempotent. Clears the timer AND latches the emitter off. */
  stop(): void;
  /** False when disarmed (no valid token) or stopped. */
  readonly active: boolean;
  /** Frames handed to the sender. Test observability only. */
  readonly emitted: number;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;
export const MIN_PROGRESS_INTERVAL_MS = 1_000;
export const MAX_PROGRESS_INTERVAL_MS = 60_000;

/** Env var read by {@link resolveProgressIntervalMs}. Its real consumer is the test suite. */
export const PROGRESS_INTERVAL_ENV_VAR = "CLAUDISH_MCP_PROGRESS_INTERVAL_MS";

export function isProgressToken(v: unknown): v is ProgressToken {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

function clampInterval(ms: number): number {
  if (ms < MIN_PROGRESS_INTERVAL_MS) return MIN_PROGRESS_INTERVAL_MS;
  if (ms > MAX_PROGRESS_INTERVAL_MS) return MAX_PROGRESS_INTERVAL_MS;
  return ms;
}

/**
 * Reads `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to [MIN, MAX]; anything
 * unparseable falls back to the default. Takes an injectable env so tests never
 * touch `process.env`.
 */
export function resolveProgressIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROGRESS_INTERVAL_ENV_VAR];
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_PROGRESS_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROGRESS_INTERVAL_MS;
  return clampInterval(parsed);
}

/** See {@link HeartbeatOptions.intervalMs} for why this does not apply the MIN floor. */
function resolveExplicitIntervalMs(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_PROGRESS_INTERVAL_MS;
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_PROGRESS_INTERVAL_MS;
  return Math.min(ms, MAX_PROGRESS_INTERVAL_MS);
}

export interface HeartbeatOptions {
  /** RAW `_meta.progressToken`. Validated here — callers never pre-check. */
  token: unknown;
  send: ProgressSender;
  /** Tool name, used to build the default message. */
  label: string;
  /**
   * Defaults to {@link DEFAULT_PROGRESS_INTERVAL_MS}.
   *
   * Deliberately NOT floored at {@link MIN_PROGRESS_INTERVAL_MS}: this is a
   * trusted in-process seam whose real consumer is the test suite, which needs
   * 20ms ticks so a unit test finishes in well under a second. The floor exists
   * to defend against a MISCONFIGURED ENV VALUE, and it is applied where that
   * value is read ({@link resolveProgressIntervalMs}) — which is also the only
   * thing the production caller ever passes here, so the clamp is never bypassed
   * in a real server. Non-finite or non-positive falls back to the default; the
   * MAX cap still applies.
   */
  intervalMs?: number;
}

/**
 * Shared, frozen, permanently inert handle. Used for tools without `heartbeat: true`
 * and whenever the client sent no usable `progressToken`. No timer, no allocation
 * beyond this one reference, and nothing here can ever throw.
 */
export const NOOP_HEARTBEAT: HeartbeatHandle = Object.freeze({
  tick(_message?: string): void {
    // Deliberately inert.
  },
  stop(): void {
    // Deliberately inert.
  },
  active: false,
  emitted: 0,
});

/**
 * Arm a periodic keepalive for one in-flight tool call.
 *
 * Returns {@link NOOP_HEARTBEAT} — no timer, no throw — when `token` is not a valid
 * `ProgressToken`. A host that sends no token has not misbehaved (the token is
 * optional in the spec), and a tool call must never fail because its keepalive
 * could not arm.
 */
export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const { token, send, label } = opts;
  if (!isProgressToken(token)) return NOOP_HEARTBEAT;

  const intervalMs = resolveExplicitIntervalMs(opts.intervalMs);
  const startedAt = Date.now();
  let progress = 0;
  let stopped = false;

  const emit = (message?: string): void => {
    // The latch, not just `clearInterval`: a tick already queued on the macrotask
    // queue when `stop()` ran must be dropped, or a frame could reach the wire
    // after the response it belongs to (GLips/Figma-Context-MCP#362).
    if (stopped) return;
    progress += 1; // strictly increasing, shared by periodic ticks and tick()
    try {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const result = send({
        progressToken: token,
        progress,
        // Structural only — tool name, elapsed seconds, counts. NEVER prompt
        // text, model output, or filesystem paths: this goes to the host and,
        // unlike channel content, was not composed for display.
        message: message ?? `${label}: working (${elapsedSeconds}s)`,
      });
      // `sendNotification` is async; an unhandled rejection would take the whole
      // MCP server down, so the attachment is explicit rather than incidental.
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // A keepalive must never fail the call it is keeping alive.
    }
  };

  const timer = setInterval(() => emit(), intervalMs);
  // A pending keepalive must not hold the process open at shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    tick: (message?: string) => emit(message),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    get active() {
      return !stopped;
    },
    get emitted() {
      return progress;
    },
  };
}
