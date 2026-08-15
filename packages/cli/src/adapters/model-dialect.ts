/**
 * ModelDialect — translates model-specific dialect differences.
 *
 * Each model family has its own dialect: context window sizes, parameter mappings
 * (thinking → reasoning_effort), vision support rules, tool name limits.
 * These are NOT format differences (those are APIFormat's job) but
 * per-model behavioral translations.
 */

export interface ModelDialect {
  /** Context window size for this model (tokens) */
  getContextWindow(): number;

  /** Whether this model supports vision/image input */
  supportsVision(): boolean;

  /**
   * Translate model-specific request parameters.
   * E.g., thinking.budget_tokens → reasoning_effort for OpenAI,
   * thinking → reasoning_split for MiniMax, strip thinking for GLM.
   */
  prepareRequest(request: any, originalRequest: any): any;

  /** Maximum tool name length, or null if unlimited */
  getToolNameLimit(): number | null;

  /** Check if this dialect handles the given model ID */
  shouldHandle(modelId: string): boolean;

  /** Dialect name for logging */
  getName(): string;

  /**
   * Optional: recover from an upstream 4xx caused by an OPTIONAL request
   * parameter this dialect added speculatively.
   *
   * Returning a payload means "retry this request exactly once with these
   * fields instead"; returning null means "not something I can fix — surface the
   * error as-is". A dialect implementing this is responsible for remembering the
   * verdict so the retry is paid at most once per model.
   *
   * This exists so a dialect can prefer sending a capability parameter
   * optimistically over withholding it. Withholding fails SILENTLY — the user's
   * setting is dropped and the only symptom is different model behaviour — while
   * sending it fails LOUDLY and recoverably. `GrokModelDialect` is the motivating
   * case: an allowlist of models known to accept `reasoning_effort` went stale
   * the moment xAI shipped grok-4.5/4.6, which silently lost effort control.
   */
  recoverFromRejection?(payload: any, errorText: string): { payload: any; note: string } | null;
}
