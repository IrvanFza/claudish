/**
 * Advisor-tool transformer for NativeHandler (monitor mode).
 *
 * PURPOSE — experimental
 * ======================
 * When the client sends `{type: "advisor_20260301", name: "advisor", model: ...}`
 * in `tools[]`, optionally replace it with a regular tool definition named
 * "advisor" so we can observe whether Sonnet still calls it as a normal tool.
 *
 * This is Stage 1 of the advisor-replacement experiment: detection only.
 * No tool loop, no third-party model routing. We just want to see whether
 * the executor still emits `tool_use` for `advisor` when the server-tool
 * version is gone.
 *
 * ENABLING
 * ========
 * Opt-in via env var:
 *
 *   export CLAUDISH_SWAP_ADVISOR=1         # swap tool + strip beta header
 *   export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.log  # optional log path
 *
 * When unset, this module is a no-op and the proxy behaves as before.
 */

import { appendFileSync } from "node:fs";

const ADVISOR_SERVER_TOOL_TYPE = "advisor_20260301";
const ADVISOR_BETA_FLAG = "advisor-tool-2026-03-01";

export interface AdvisorSwapConfig {
  enabled: boolean;
  logPath?: string;
  /** When true, include entire request bodies in the log — large but useful for debugging the tool_result round-trip. */
  dumpBodies?: boolean;
}

export function loadAdvisorSwapConfig(): AdvisorSwapConfig {
  return {
    enabled: process.env.CLAUDISH_SWAP_ADVISOR === "1",
    logPath: process.env.CLAUDISH_SWAP_ADVISOR_LOG,
    dumpBodies: process.env.CLAUDISH_SWAP_ADVISOR_DUMP === "1",
  };
}

interface AdvisorInfo {
  /** The original server-tool definition we removed. */
  originalTool: Record<string, unknown>;
  /** The regular-tool definition we replaced it with. */
  regularTool: Record<string, unknown>;
  /** Original value of the anthropic-beta header (for possible restoration). */
  originalBetaHeader?: string;
  /** Beta header after stripping advisor-tool-2026-03-01. */
  strippedBetaHeader?: string;
}

/**
 * Mutates `payload.tools` in place: finds `advisor_20260301` and replaces it
 * with a regular tool of the same name. Also returns metadata describing
 * what we changed (for logging).
 *
 * Returns `null` if the payload had no advisor server tool (nothing to do).
 */
export function swapAdvisorToolInBody(
  payload: Record<string, unknown>,
): AdvisorInfo | null {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return null;

  const idx = tools.findIndex(
    (t) => t && typeof t === "object" && (t as any).type === ADVISOR_SERVER_TOOL_TYPE,
  );
  if (idx < 0) return null;

  const originalTool = tools[idx] as Record<string, unknown>;
  const originalName = (originalTool.name as string) || "advisor";
  const originalAdvisorModel = (originalTool.model as string) || "unknown";

  // Regular tool definition. We deliberately keep the same name ("advisor")
  // so we can compare behavior before/after the swap.
  //
  // The description is longer than strictly necessary because the native
  // server-tool has trained behavior baked into the model — a regular tool
  // with the same name does NOT inherit that training, so we compensate
  // with more explicit prompting.
  const regularTool: Record<string, unknown> = {
    name: originalName,
    description:
      "Consult a stronger advisor model for strategic guidance on complex decisions. " +
      "Call this tool when: (a) facing an architectural or design decision with " +
      "multiple valid approaches, (b) stuck after 2+ failed attempts, (c) about to " +
      "make an irreversible change, or (d) when you believe the task is complete " +
      "and want verification. Takes no arguments; the advisor will read the full " +
      "conversation history.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };

  tools[idx] = regularTool;

  return {
    originalTool,
    regularTool,
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    ...{ _note: `replaced advisor_20260301 (advisor model: ${originalAdvisorModel})` },
  } as AdvisorInfo;
}

/**
 * Removes `advisor-tool-2026-03-01` from a comma-separated anthropic-beta
 * header value. Returns `undefined` if the header had no advisor beta flag.
 */
export function stripAdvisorBeta(
  betaHeader: string | undefined,
): { stripped: string | undefined; changed: boolean } {
  if (!betaHeader) return { stripped: betaHeader, changed: false };
  const parts = betaHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const filtered = parts.filter((p) => p !== ADVISOR_BETA_FLAG);
  if (filtered.length === parts.length) {
    return { stripped: betaHeader, changed: false };
  }
  return {
    stripped: filtered.length > 0 ? filtered.join(",") : undefined,
    changed: true,
  };
}

/**
 * Appends a structured log entry to the configured advisor-swap log file.
 * Safe to call even if no log path is set (no-op in that case).
 */
export function logAdvisorEvent(
  cfg: AdvisorSwapConfig,
  event: Record<string, unknown>,
): void {
  if (!cfg.logPath) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  try {
    appendFileSync(cfg.logPath, line);
  } catch {
    // silent — don't break the proxy if the log file is unwritable
  }
}

/**
 * Scans a chunk of raw SSE bytes for advisor-related activity and records
 * any hits to the log file. Call this once per streamed chunk. Stateless
 * on purpose: we just grep the chunk.
 */
export function recordAdvisorEventsFromChunk(
  cfg: AdvisorSwapConfig,
  chunkText: string,
): void {
  if (!cfg.logPath) return;
  // Markers worth flagging. Stage 1 cares about whether Sonnet emits a
  // regular tool_use for "advisor" (which proves the model still reaches
  // for the advisor when the tool_type is regular).
  const markers: Array<[string, string]> = [
    ['"name":"advisor"', "tool_use_for_advisor"],
    ['"type":"tool_use"', "any_tool_use"],
    ['"type":"server_tool_use"', "server_tool_use_unexpected"],
    ['"type":"advisor_tool_result"', "advisor_tool_result_unexpected"],
    ['"stop_reason":"tool_use"', "stop_reason_tool_use"],
    ['"stop_reason":"end_turn"', "stop_reason_end_turn"],
  ];
  for (const [needle, kind] of markers) {
    let i = 0;
    while (true) {
      i = chunkText.indexOf(needle, i);
      if (i < 0) break;
      const ctx = chunkText.slice(Math.max(0, i - 40), i + 160);
      logAdvisorEvent(cfg, { kind, needle, ctx });
      i += needle.length;
    }
  }
}
