/**
 * MiniMaxModelDialect — Layer 2 dialect for MiniMax models.
 *
 * Handles MiniMax-specific quirks:
 * - Context window: all models are 204,800 tokens
 * - Temperature: must be in (0.0, 1.0] — clamps 0 → 0.01, >1 → 1.0
 * - Thinking: native support via standard `thinking` param (no conversion needed)
 * - Vision: not supported — supportsVision() returns false so ComposedHandler strips images
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

/** MiniMax API requires temperature in (0.0, 1.0]. Sourced from MiniMax's published API docs, not per-model. */
const TEMPERATURE_RANGE = { min: 0.01, max: 1.0 } as const;

export class MiniMaxModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation — clamp temperature to MiniMax's accepted range.
   * The valid range is the TEMPERATURE_RANGE constant sourced from MiniMax's published API docs.
   * The standard `thinking` parameter is supported natively by MiniMax's Anthropic-compatible
   * endpoint, so no conversion is needed here.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (request.temperature !== undefined) {
      if (request.temperature < TEMPERATURE_RANGE.min) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.min} (MiniMax requires >= ${TEMPERATURE_RANGE.min})`
        );
        request.temperature = TEMPERATURE_RANGE.min;
      } else if (request.temperature > TEMPERATURE_RANGE.max) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.max} (MiniMax requires <= ${TEMPERATURE_RANGE.max})`
        );
        request.temperature = TEMPERATURE_RANGE.max;
      }
    }

    return request;
  }

  /**
   * Context window sourced from the model catalog.
   * Defaults to 204,800 (MiniMax standard context) if not in catalog.
   */
  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * MiniMax's Anthropic API does not support image or document content blocks.
   * Returning false causes ComposedHandler to strip/proxy image content.
   * Sourced from model catalog; defaults to false for unrecognized MiniMax models.
   */
  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }

  /**
   * MiniMax's Anthropic-compatible endpoint returns thinking blocks that leak
   * to the user when passed through. Filter them from the SSE stream.
   */
  override shouldFilterThinking(): boolean {
    return true;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "minimax");
  }

  getName(): string {
    return "MiniMaxModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use MiniMaxModelDialect */
export { MiniMaxModelDialect as MiniMaxAdapter };
