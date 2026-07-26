/**
 * Terminal isolation — a hard firewall around claudish's stdout/stderr for the
 * window in which Claude Code owns the terminal.
 *
 * WHY THIS EXISTS
 * ---------------
 * claude-runner spawns Claude Code with `stdio: "inherit"`, so the child writes
 * to the SAME file descriptors claudish holds. Claude Code is a full-screen TUI
 * that redraws in place: any byte claudish writes to fd 1/2 during that time
 * lands inside a frame the child is painting and desynchronizes its cursor
 * bookkeeping. The visible result is torn rows — a status line overwritten
 * mid-word, error text bleeding across the prompt box.
 *
 * claudish's own diagnostics already route through logStderr() → DiagOutput, so
 * they are safe. The leaks are the writes claudish does NOT own:
 *
 *   - Hono's default onError is `console.error(err)` (hono-base.js). Under Bun
 *     that pretty-prints a multi-line error dump straight to fd 2.
 *   - Any dependency that decides to warn on console.
 *   - Bun/Node runtime warnings (deprecations, unhandled-rejection notices).
 *
 * Individually patchable call sites can be fixed one at a time; the ones inside
 * dependencies cannot. So this module closes the channel itself: while isolation
 * is active, every console method and every direct process.stdout/stderr write
 * made by THIS process is diverted to a sink instead of the terminal.
 *
 * SCOPE — what this does NOT do
 * -----------------------------
 * The child's writes are real OS-level writes on inherited descriptors; they
 * never pass through this process's JavaScript. Patching here therefore cannot
 * and must not affect Claude Code's own output. That is the point: after
 * isolation, the TTY has exactly one writer.
 */

import { format } from "node:util";

/** A write that was kept off the terminal. */
export interface SuppressedOutput {
  /** Where it came from: "console.error", "stdout", … — useful when triaging. */
  source: string;
  /** The text, already formatted. Not newline-normalized; the sink decides. */
  text: string;
}

const CONSOLE_METHODS = ["log", "error", "warn", "info", "debug", "trace", "dir"] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

let active = false;

/**
 * Re-entrancy guard. The sink writes to a log file, and a log-file write error
 * handler may itself console.error — which we have just patched to call the
 * sink. Without this flag that pair loops forever.
 */
let routing = false;

/**
 * Divert this process's console and stdout/stderr writes away from the terminal
 * until the returned function is called.
 *
 * Idempotent: calling it while already active returns a no-op restore, so a
 * double-install can't leave a half-restored console behind.
 *
 * @param onSuppressed - Sink for diverted output. Must not write to the
 *                       terminal. Exceptions thrown here are swallowed —
 *                       isolation must never be what breaks a session.
 * @returns restore() — puts the original console and stream writers back.
 */
export function beginTerminalIsolation(
  onSuppressed: (entry: SuppressedOutput) => void
): () => void {
  if (active) return () => {};
  active = true;

  const emit = (source: string, text: string): void => {
    if (routing) return; // sink re-entered us — drop rather than recurse
    routing = true;
    try {
      onSuppressed({ source, text });
    } catch {
      // A failing sink must not surface as a crash mid-session.
    } finally {
      routing = false;
    }
  };

  // --- console.* -----------------------------------------------------------
  const originalConsole = {} as Record<ConsoleMethod, unknown>;
  for (const method of CONSOLE_METHODS) {
    originalConsole[method] = (console as unknown as Record<string, unknown>)[method];
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      emit(`console.${method}`, format(...args));
    };
  }

  // --- process.stdout / process.stderr -------------------------------------
  // Patched as well as console because console is not the only door: the Bun
  // runtime, and code that formats its own output, write to the streams
  // directly. The replacement keeps write()'s contract — it must return a
  // boolean and invoke the callback — or a caller awaiting drain will hang.
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const makeWrite =
    (source: string) =>
    (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
      const done = typeof encoding === "function" ? encoding : callback;
      emit(source, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (typeof done === "function") (done as (e?: Error | null) => void)(null);
      return true;
    };

  process.stdout.write = makeWrite("stdout") as typeof process.stdout.write;
  process.stderr.write = makeWrite("stderr") as typeof process.stderr.write;

  return function restore(): void {
    if (!active) return;
    for (const method of CONSOLE_METHODS) {
      (console as unknown as Record<string, unknown>)[method] = originalConsole[method];
    }
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    active = false;
  };
}

/** Whether the terminal is currently firewalled. Exported for tests. */
export function isTerminalIsolated(): boolean {
  return active;
}
