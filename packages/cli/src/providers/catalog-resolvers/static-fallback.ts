/**
 * Static vendor map: maps native provider name → OpenRouter vendor prefix.
 * Used ONLY when no dynamic catalog is available (first-run cold start).
 * Not meant to grow — the dynamic catalog is the correct long-term answer.
 */
const OPENROUTER_VENDOR_MAP: Record<string, string> = {
  google: "google",
  openai: "openai",
  kimi: "moonshotai",
  "kimi-coding": "moonshotai",
  glm: "z-ai",
  "glm-coding": "z-ai",
  zai: "z-ai",
  minimax: "minimax",
  openrouter: "openrouter",
  ollamacloud: "meta-llama",
  qwen: "qwen",
  // poe intentionally excluded - not available on OpenRouter
};

/**
 * Attempt vendor-prefix resolution using the static map.
 *
 * Input: bare model name (e.g., "llama-3.3-70b")
 * Output: "vendor/model" or null
 *
 * The "native provider" context is not available here; this function only
 * handles names where the vendor prefix can be guessed from the model name
 * itself (e.g., "qwen3-coder-next" → "qwen" vendor because it starts with "qwen").
 */
export function staticOpenRouterFallback(userInput: string): string | null {
  // If already has vendor prefix, return as-is
  if (userInput.includes("/")) return userInput;

  // Check if model name starts with a known vendor keyword
  const lower = userInput.toLowerCase();
  for (const [key, vendor] of Object.entries(OPENROUTER_VENDOR_MAP)) {
    if (lower.startsWith(key)) {
      return `${vendor}/${userInput}`;
    }
  }

  return null; // Cannot guess — passthrough
}
