/**
 * Decide whether a finished child run actually produced a usable answer.
 * Returns null when the output looks fine.
 *
 * Reduced from claudish's team-orchestrator for review purposes.
 */

export type FailureReason = "api_error" | "background_task_ceiling" | "empty_output";

/** How many trailing stdout bytes are retained per child. */
export const STDOUT_TAIL_LIMIT = 4000;

const API_ERROR_RE = /\[API Error:\s*([^\]]{0,300})\]/i;
const BG_CEILING_RE = /Background tasks still running after (\d+)s; terminating/i;

export function classifyRunOutput(opts: {
  outputSize: number;
  stdoutTail: string;
  stderr: string;
  minOutputBytes: number;
}): { reason: FailureReason; detail: string } | null {
  const { outputSize, stdoutTail, stderr, minOutputBytes } = opts;

  const apiError = API_ERROR_RE.exec(stdoutTail);
  if (apiError) {
    return { reason: "api_error", detail: `stdout carries an API error: ${apiError[1]}` };
  }

  const bgCeiling = BG_CEILING_RE.exec(stderr);
  if (bgCeiling) {
    return {
      reason: "background_task_ceiling",
      detail: `turn terminated after ${bgCeiling[1]}s waiting on background tasks`,
    };
  }

  const tailIsWholeOutput = outputSize <= STDOUT_TAIL_LIMIT;
  if (outputSize === 0 || (tailIsWholeOutput && stdoutTail.trim().length === 0)) {
    return { reason: "empty_output", detail: `no non-whitespace output (${outputSize} B)` };
  }

  if (minOutputBytes > 0 && outputSize < minOutputBytes) {
    return {
      reason: "empty_output",
      detail: `only ${outputSize} B (caller required ${minOutputBytes} B)`,
    };
  }

  return null;
}
