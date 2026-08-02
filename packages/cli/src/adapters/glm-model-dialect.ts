/**
 * GLMModelDialect — Layer 2 dialect for Zhipu AI GLM models.
 *
 * Handles GLM-specific quirks:
 * - Context window sizes per model variant (sourced from model-catalog.ts)
 * - Hybrid models (GLM-4.5 family + GLM-4.6) take a `thinking:{type}` toggle;
 *   older non-hybrid models (glm-4, glm-4-plus) reject thinking → strip.
 * - Vision support detection (sourced from model-catalog.ts)
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";
import { lookupModel } from "./model-catalog.js";

export class GLMModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * GLM's OWN (Zhipu OpenAI-compatible) reasoning knob. This IS the path taken
   * by `glm@` AND by `gc@` (GLM Coding Plan): both map to glmProfile, i.e.
   * OpenAIProviderTransport + OpenAIAPIFormat — `gc@` just points at
   * /api/coding/paas/v4/chat/completions. Easy to get wrong, because `gc@` and
   * `zai@` both serve Z.AI GLM models; they differ in the WIRE, not the vendor.
   *
   * Not called on the Anthropic wire, which is `zai@` (z-ai →
   * anthropicCompatProfile, /api/anthropic/v1/messages) and `qc@glm-5.2` (Qwen
   * Plan, also anthropicCompatProfile, serves GLM alongside Qwen). There
   * BaseAPIFormat.applyAnthropicWireReasoning() takes over and drives the knob
   * from catalog metadata instead of this 4.5/4.6 name test.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    // GLM-4.5 family + GLM-4.6 are HYBRID: they accept a boolean-style
    // `thinking:{type:"enabled"|"disabled"}` toggle (no gradation). Older
    // non-hybrid models (glm-4, glm-4-plus) reject `thinking` entirely.
    if (effort && this.isHybridThinkingModel()) {
      const type = effort === "none" || effort === "minimal" ? "disabled" : "enabled";
      request.thinking = { type };
      log(`[GLMModelDialect] effort ${effort} -> thinking.type: ${type} for ${this.modelId}`);
      return request;
    }

    // Non-hybrid GLM (or no effort signal): strip any raw thinking object —
    // these models reject it.
    if (request.thinking) {
      log(`[GLMModelDialect] Stripping thinking object (not supported by ${this.modelId})`);
      delete request.thinking;
    }

    return request;
  }

  /**
   * GLM-4.5 family (glm-4.5/-air/-x/-airx/-flash) and GLM-4.6 are hybrid
   * reasoning models that accept the `thinking` toggle. glm-4 / glm-4-plus and
   * other pre-4.5 SKUs are non-hybrid and reject it.
   */
  private isHybridThinkingModel(): boolean {
    const model = this.modelId.toLowerCase();
    return /glm-4\.[56]/.test(model);
  }

  shouldHandle(modelId: string): boolean {
    return (
      matchesModelFamily(modelId, "glm-") ||
      matchesModelFamily(modelId, "chatglm-") ||
      modelId.toLowerCase().includes("zhipu/")
    );
  }

  getName(): string {
    return "GLMModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }
}

// Backward-compatible alias
/** @deprecated Use GLMModelDialect */
export { GLMModelDialect as GLMAdapter };
