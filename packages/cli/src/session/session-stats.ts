/**
 * session-stats — what a finished claudish session cost, did, and took.
 *
 * The proxy is gone by the time the summary prints, so this reads the one durable
 * artefact it leaves behind: `~/.claudish/tokens-<port>.json`, written by `TokenTracker`
 * on every update and deliberately NOT deleted on exit. That file is also what the
 * status line reads, so the summary can never disagree with the number the user watched
 * all session.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Baseline, baselineCost, getBaselines } from "./baseline-pricing.js";

/** One tool's share of the session. */
export interface ToolCall {
  name: string;
  count: number;
}

/** A comparison against one Anthropic tier. */
export interface Saving {
  label: string;
  modelId: string;
  /** What the same tokens would have cost at the baseline's first-party rates. */
  baselineUsd: number;
  /**
   * `baselineUsd - actual`. NEGATIVE when the routed model cost MORE than the
   * baseline, which is a real outcome (a premium aggregator, a reasoning-heavy run)
   * and is reported as such rather than clamped — see `session-summary.ts`, which
   * relabels the row instead of hiding the sign.
   */
  savedUsd: number;
}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** True when the provider bills nothing (local model, free tier). */
  isFree: boolean;
  /** True when `costUsd` came from a rate estimate rather than a billed figure. */
  isEstimated: boolean;
  providerName: string;
  modelName: string;
  contextWindow: number | null;
  /** Fraction of the context window occupied by the final request, 0..1. Null if unknown. */
  contextUsed: number | null;
  toolCalls: ToolCall[];
  toolCallTotal: number;
  durationMs: number;
  savings: Saving[];
  /**
   * How `costUsd` divides between reading and writing tokens.
   *
   * Derived from the published per-million rates and then RESCALED so the two parts sum
   * to `costUsd` exactly. The rescale is what keeps this honest on the actual-cost path,
   * where the provider's billed total is authoritative and our rate arithmetic is only a
   * proportion. Both zero when rates are unknown or the session was free.
   */
  inputCostUsd: number;
  outputCostUsd: number;
}

/** The path `TokenTracker.writeFile` wrote to, resolved the same way it resolves it. */
export function tokenFilePath(port: number): string {
  return process.env.CLAUDISH_TOKEN_FILE || join(homedir(), ".claudish", `tokens-${port}.json`);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Read and interpret the token file. Returns `null` when there is nothing to report —
 * the file is missing (the session died before its first response), unparseable, or
 * records no tokens at all. The caller prints no panel in that case, which is correct:
 * a summary of a session that never ran is noise, not information.
 */
export function readSessionStats(port: number): SessionStats | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(tokenFilePath(port), "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;

  const inputTokens = num(d.input_tokens);
  const outputTokens = num(d.output_tokens);
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  const costUsd = num(d.total_cost);
  const isFree = d.is_free === true;

  // `context_window` is the string "unknown" when the catalog had no entry, so a
  // typeof check is load-bearing here rather than defensive.
  const contextWindow = typeof d.context_window === "number" ? d.context_window : null;
  const contextUsed =
    contextWindow && contextWindow > 0
      ? Math.min(1, Math.max(0, inputTokens / contextWindow))
      : null;

  const toolCalls: ToolCall[] = Array.isArray(d.tool_calls)
    ? (d.tool_calls as unknown[])
        .map((t) => t as Record<string, unknown>)
        .filter((t) => typeof t?.name === "string" && num(t.count) > 0)
        .map((t) => ({ name: String(t.name), count: num(t.count) }))
    : [];

  // A clock that runs backwards (an NTP step mid-session) would otherwise render a
  // negative duration; clamping to 0 shows "0s", which reads as "not measured".
  const startedAt = num(d.started_at);
  const updatedAt = num(d.updated_at);
  const durationMs = startedAt > 0 && updatedAt > startedAt ? updatedAt - startedAt : 0;

  const rawIn = (inputTokens / 1_000_000) * num(d.input_per_m);
  const rawOut = (outputTokens / 1_000_000) * num(d.output_per_m);
  const rawTotal = rawIn + rawOut;
  // Rescale onto the authoritative total so the two parts always sum to what the user
  // is told they paid. Without this, an OpenRouter session (whose `total_cost` is the
  // provider's own billed figure) would show a split that visibly disagreed with it.
  const scale = rawTotal > 0 && costUsd > 0 ? costUsd / rawTotal : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: num(d.total_tokens) || inputTokens + outputTokens,
    costUsd,
    isFree,
    isEstimated: d.is_estimated === true,
    providerName: typeof d.provider_name === "string" ? d.provider_name : "",
    modelName: typeof d.model_name === "string" ? d.model_name : "",
    contextWindow,
    contextUsed,
    toolCalls,
    toolCallTotal: toolCalls.reduce((a, t) => a + t.count, 0),
    durationMs,
    savings: computeSavings(inputTokens, outputTokens, costUsd),
    inputCostUsd: rawIn * scale,
    outputCostUsd: rawOut * scale,
  };
}

/**
 * Compare the session's real cost against each resolvable Anthropic tier.
 *
 * Empty when the catalog cannot supply a first-party rate — see `baseline-pricing.ts`.
 * The comparison uses the SESSION's own token counts, so it answers the only question
 * worth asking: what this exact work would have cost on Claude.
 */
export function computeSavings(
  inputTokens: number,
  outputTokens: number,
  actualUsd: number
): Saving[] {
  return getBaselines().map((b: Baseline) => {
    const baselineUsd = baselineCost(b, inputTokens, outputTokens);
    return {
      label: b.label,
      modelId: b.modelId,
      baselineUsd,
      savedUsd: baselineUsd - actualUsd,
    };
  });
}
