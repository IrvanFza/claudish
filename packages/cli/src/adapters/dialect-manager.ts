/**
 * DialectManager — selects the appropriate Layer 2 ModelDialect for a given model.
 *
 * This allows ComposedHandler to apply model-specific quirks independent of
 * which Layer 1 APIFormat or Layer 3 ProviderTransport are used:
 * - Grok: XML function calls
 * - Gemini: Thought signatures in reasoning_details
 * - DeepSeek, GLM, etc.: thinking param stripping / mapping
 */

import type { StreamFormat } from "../providers/transport/types.js";
import { type BaseAPIFormat, DefaultAPIFormat } from "./base-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";
import { XiaomiModelDialect } from "./xiaomi-model-dialect.js";

export class DialectManager {
  private adapters: BaseAPIFormat[];
  private defaultAdapter: DefaultAPIFormat;

  /**
   * @param modelId     Bare model name — dialects self-select on it.
   * @param wireFormat  The wire format of the Layer 1 FormatConverter this
   *   dialect will be composed with (ComposedHandler knows it; the dialect
   *   cannot, because selection is by model NAME). BaseAPIFormat — not the
   *   dialect — consumes it, substituting the Anthropic Messages reasoning knob
   *   and enabling unsigned-thinking filtering on `anthropic-sse`. That is why
   *   a multi-vendor Anthropic endpoint (Alibaba's Qwen Plan serves qwen3.x,
   *   glm-5.2 and deepseek-v4-* over one URL, i.e. three different dialects)
   *   works without each dialect opting in. Omit for "unknown" → the OpenAI
   *   default, which keeps every pre-existing call site byte-identical.
   */
  constructor(modelId: string, wireFormat?: StreamFormat) {
    // Register all available dialects/formats
    this.adapters = [
      new GrokModelDialect(modelId, wireFormat),
      new GeminiAPIFormat(modelId, wireFormat),
      new CodexAPIFormat(modelId, wireFormat), // Must be before OpenAIAPIFormat (codex matches first)
      new OpenAIAPIFormat(modelId, wireFormat),
      new QwenModelDialect(modelId, wireFormat),
      new MiniMaxModelDialect(modelId, wireFormat),
      new DeepSeekModelDialect(modelId, wireFormat),
      new GLMModelDialect(modelId, wireFormat),
      new XiaomiModelDialect(modelId, wireFormat),
    ];
    this.defaultAdapter = new DefaultAPIFormat(modelId, wireFormat);
  }

  /**
   * Get the appropriate dialect/format for the current model
   */
  getAdapter(): BaseAPIFormat {
    for (const adapter of this.adapters) {
      if (adapter.shouldHandle(this.defaultAdapter.getModelId())) {
        return adapter;
      }
    }
    return this.defaultAdapter;
  }

  /**
   * Check if current model needs special handling
   */
  needsTransformation(): boolean {
    return this.getAdapter() !== this.defaultAdapter;
  }
}

// Backward-compatible alias
/** @deprecated Use DialectManager */
export { DialectManager as AdapterManager };
