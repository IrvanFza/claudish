/**
 * QwenModelDialect — Layer 2 dialect for Qwen (Alibaba) models.
 *
 * Handles Qwen-specific quirks:
 * - Strips special tokens from output
 * - Maps Claude Code's effort onto DashScope's OpenAI-compatible reasoning
 *   knob (`enable_thinking` + `thinking_budget`).
 *
 * Qwen is reachable over TWO wires — DashScope's OpenAI-compatible API and Qwen
 * Plan's Anthropic-compatible endpoint (/apps/anthropic/v1/messages) — and they
 * do not share a reasoning knob. Only the DashScope half lives here: the
 * Anthropic half is a property of the WIRE, not of the Qwen family, so it lives
 * in BaseAPIFormat.applyAnthropicWireReasoning() where every dialect inherits
 * it. (Qwen Plan serves glm-5.2 and deepseek-v4-* over the same endpoint, so a
 * Qwen-only implementation left those two emitting knobs that endpoint ignores.)
 *
 * `applyNativeReasoning` is not called at all on the Anthropic wire, so nothing
 * here needs to branch on `wireFormat`.
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";

// Qwen special tokens that should be stripped from output
const QWEN_SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end|>",
  "assistant\n", // Role marker that sometimes leaks
];

export class QwenModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // Strip Qwen special tokens that may leak through
    // This can happen when the model gets confused and outputs its chat template
    let cleanedText = textContent;
    for (const token of QWEN_SPECIAL_TOKENS) {
      cleanedText = cleanedText.replaceAll(token, "");
    }

    // Also handle partial tokens at chunk boundaries
    // e.g., "<|im_" at the end of one chunk and "start|>" at the beginning of next
    cleanedText = cleanedText.replace(/<\|[a-z_]*$/i, ""); // Partial at end
    cleanedText = cleanedText.replace(/^[a-z_]*\|>/i, ""); // Partial at start

    const wasTransformed = cleanedText !== textContent;
    if (wasTransformed && cleanedText.length === 0) {
      // Entire chunk was special tokens, skip it
      return {
        cleanedText: "",
        extractedToolCalls: [],
        wasTransformed: true,
      };
    }

    return {
      cleanedText,
      extractedToolCalls: [],
      wasTransformed,
    };
  }

  /**
   * DashScope OpenAI-compatible wire: `enable_thinking` + `thinking_budget`.
   *
   * This is the long-standing path and is deliberately left byte-identical,
   * including the `delete request.thinking` cleanup — on this wire a raw
   * Anthropic `thinking` object is meaningless and would double-send. It is
   * also deliberately NOT catalog-driven: DashScope accepts this pair for the
   * whole Qwen family, it is in production use today, and re-deriving it from
   * catalog metadata would be a behaviour change with no defect behind it.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);
    if (!effort) return request;

    if (effort === "none" || effort === "minimal") {
      request.enable_thinking = false;
      log(`[QwenModelDialect] effort ${effort} -> enable_thinking: false for ${this.modelId}`);
    } else {
      request.enable_thinking = true;
      const budget = this.effortToThinkingTokenBudget(effort);
      if (budget !== undefined) {
        request.thinking_budget = budget;
      }
      log(
        `[QwenModelDialect] effort ${effort} -> enable_thinking: true, thinking_budget: ${budget ?? "(model max)"} for ${this.modelId}`
      );
    }

    // Cleanup: remove raw thinking object so it doesn't double-send.
    if (originalRequest.thinking) delete request.thinking;

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "qwen") || matchesModelFamily(modelId, "alibaba");
  }

  getName(): string {
    return "QwenModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use QwenModelDialect */
export { QwenModelDialect as QwenAdapter };
