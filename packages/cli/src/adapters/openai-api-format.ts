/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3, codex)
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native models (o1/o3 reasoning params).
 */

import { BaseAPIFormat, type AdapterResult } from "./base-api-format.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
  constructor(modelId: string) {
    super(modelId);
  }

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * OpenAI's Chat Completions API hard-caps the tools array at 128. Exceeding
   * it fails the whole request with HTTP 400 "Invalid 'tools': array too long".
   * (Note: CodexAPIFormat is a separate class and is intentionally NOT capped
   * here — the Responses API path keeps its own behavior.)
   */
  override getMaxToolCount(): number | null {
    return 128;
  }

  /**
   * Handle request preparation — reasoning parameters and tool name truncation
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models. Only set it if buildPayload hasn't already (it builds the payload
    // first; this covers paths that call prepareRequest on a payload built
    // elsewhere). Always strip a leftover `thinking` block — OpenAI rejects it.
    if (this.supportsReasoningEffort() && request.reasoning_effort === undefined) {
      const effort = this.resolveReasoningEffort(originalRequest);
      if (effort) {
        request.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }
    if (request.thinking) delete request.thinking;

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.startsWith("oai/") || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Whether this model accepts OpenAI's `reasoning_effort` parameter. Covers the
   * o-series (o1/o3/o4) AND the gpt-5 family — gpt-5/gpt-5.x take reasoning_effort
   * too, which the older o1/o3-only gate missed (so effort was silently dropped
   * for gpt-5.5).
   */
  private supportsReasoningEffort(): boolean {
    const model = this.modelId.toLowerCase();
    return (
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4") ||
      model.includes("gpt-5")
    );
  }

  /**
   * Map Claude Code's effort signal to a valid OpenAI `reasoning_effort` value.
   *
   * Modern Claude Code (Opus 4.7/4.8) sends `output_config.effort` as a string
   * level (none/low/medium/high/xhigh/max). Older clients sent
   * `thinking.budget_tokens` (a number) — kept as a fallback.
   *
   * OpenAI's gpt-5.x Chat Completions accepts exactly: none | low | medium |
   * high | xhigh (verified against the live API — it REJECTS `minimal` and
   * `max`). So `minimal`→`low` and `max`→`xhigh`; the rest pass through.
   * Returns undefined when there's no effort signal.
   */
  private resolveReasoningEffort(claudeRequest: any): string | undefined {
    const level = claudeRequest.output_config?.effort;
    if (typeof level === "string") {
      switch (level.toLowerCase()) {
        case "minimal":
          return "low"; // gpt-5.x rejects "minimal"
        case "low":
        case "medium":
        case "high":
        case "xhigh":
        case "none":
          return level.toLowerCase();
        case "max":
          return "xhigh"; // gpt-5.x rejects "max"; xhigh is its ceiling
        default:
          return undefined; // unknown level — let OpenAI use its default
      }
    }

    // Legacy fallback: thinking.budget_tokens → bucketed effort.
    const budget = claudeRequest.thinking?.budget_tokens;
    if (typeof budget === "number") {
      if (budget < 16000) return "low";
      if (budget >= 32000) return "high";
      return "medium";
    }

    return undefined;
  }

  private usesMaxCompletionTokens(): boolean {
    const model = this.modelId.toLowerCase();
    return (
      model.includes("gpt-5") ||
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4")
    );
  }

  private buildChatCompletionsPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (this.usesMaxCompletionTokens()) {
      payload.max_completion_tokens = claudeRequest.max_tokens;
    } else {
      payload.max_tokens = claudeRequest.max_tokens;
    }

    if (tools.length > 0) {
      payload.tools = tools;
    }

    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models (o-series + gpt-5 family).
    if (this.supportsReasoningEffort()) {
      const effort = this.resolveReasoningEffort(claudeRequest);
      if (effort) {
        payload.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
