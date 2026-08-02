/**
 * MiniMaxModelDialect — Layer 2 dialect for MiniMax models.
 *
 * Handles MiniMax-specific quirks:
 * - Context window: all models are 204,800 tokens
 * - Temperature: must be in (0.0, 1.0] — clamps 0 → 0.01, >1 → 1.0
 * - Thinking: native support via standard `thinking` param (no conversion needed)
 * - Vision: not supported — supportsVision() returns false so ComposedHandler strips images
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";
import { lookupModel } from "./model-catalog.js";

/** MiniMax API requires temperature in (0.0, 1.0]. Sourced from MiniMax's published API docs, not per-model. */
const TEMPERATURE_RANGE = { min: 0.01, max: 1.0 } as const;

export class MiniMaxModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Clamp temperature to MiniMax's accepted range. Wire-agnostic.
   */
  protected override prepareRequestCommon(request: any, _originalRequest: any): any {
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
   * MiniMax's `thinking` toggle. Every DIRECT MiniMax provider is
   * Anthropic-compatible (`mm@`, `mmc@`, and the minimax branch of
   * `zen@`/`zgo@`), so this is wired into BOTH reasoning hooks — the
   * Anthropic-wire one, which it OVERRIDES, and the native one, which still
   * runs for a composition that supplied no wire hint and for aggregator
   * routes (`or@minimax/…`, `ll@`) that reach MiniMax over the OpenAI wire.
   *
   * The override exists because MiniMax's enable value is `adaptive`, NOT the
   * Anthropic `enabled` the catalog-driven base rule emits, and because MiniMax
   * disables at `none` only — `minimal` still reasons. Neither fact is
   * expressible in the catalog's `reasoning` vocabulary (MiniMax is recorded as
   * `control: "toggle"`), so the generic rule would send it a value its API does
   * not define. The raw <think> round-trip in history is NOT touched here —
   * only the request knob.
   */
  private applyMiniMaxThinking(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);
    if (effort) {
      const type = effort === "none" ? "disabled" : "adaptive";
      request.thinking = { type };
      log(`[MiniMaxModelDialect] effort ${effort} -> thinking.type: ${type} for ${this.modelId}`);
    }

    return request;
  }

  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    return this.applyMiniMaxThinking(request, originalRequest);
  }

  protected override applyAnthropicWireReasoning(request: any, originalRequest: any): any {
    return this.applyMiniMaxThinking(request, originalRequest);
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
   *
   * Unconditional, unlike the base rule (which keys on the composed
   * `wireFormat`): every direct MiniMax provider (`mm@`, `mmc@`, `zen@`/`zgo@`)
   * is Anthropic-compatible, so the answer is true whether or not a caller
   * supplied the composition hint. Harmless on an aggregator route
   * (`or@minimax/…`, `ll@`), which is OpenAI-wire — this is only ever read by
   * createAnthropicPassthroughStream.
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
