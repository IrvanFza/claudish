/**
 * DialectManager — selects the appropriate Layer 2 ModelDialect for a given model.
 *
 * This allows ComposedHandler to apply model-specific quirks independent of
 * which Layer 1 APIFormat or Layer 3 ProviderTransport are used:
 * - Grok: XML function calls
 * - Gemini: Thought signatures in reasoning_details
 * - DeepSeek, GLM, etc.: thinking param stripping / mapping
 */

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

  constructor(modelId: string) {
    // Register all available dialects/formats
    this.adapters = [
      new GrokModelDialect(modelId),
      new GeminiAPIFormat(modelId),
      new CodexAPIFormat(modelId), // Must be before OpenAIAPIFormat (codex matches first)
      new OpenAIAPIFormat(modelId),
      new QwenModelDialect(modelId),
      new MiniMaxModelDialect(modelId),
      new DeepSeekModelDialect(modelId),
      new GLMModelDialect(modelId),
      new XiaomiModelDialect(modelId),
    ];
    this.defaultAdapter = new DefaultAPIFormat(modelId);
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
