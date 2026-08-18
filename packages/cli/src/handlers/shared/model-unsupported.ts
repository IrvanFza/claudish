/**
 * Detecting "this provider does not carry that model" from an error response.
 *
 * ## Why this needs its own module
 *
 * Providers do not agree on how to report an unknown model, and some report it
 * under a status reserved for something else entirely. OpenCode Zen Go answers
 * **HTTP 401** with `"Model deepseek-v4-pro-0813 is not supported"` — a status
 * that otherwise means "your credential is bad". Measured 2026-08-18 against a
 * real `OPENCODE_GO_API_KEY`: `zgo@deepseek-v4-pro-0813` returns 401 while
 * `zgo@kimi-k3` on the SAME key returns 200. The credential is provably fine and
 * the status is provably misleading.
 *
 * That matters because Zen Go sits early in a bare-name chain
 * (`deepseek-*` → opencode-zen-go → deepseek → openrouter). The chain still
 * advances — `isRetryableError` treats 401 as retryable, and OpenRouter probes
 * `live` — so no service is lost. What IS lost is the diagnosis: the probe
 * reported `auth-failed`, sending the user to check credentials that are
 * working, and burying the fact that a live hop exists further down.
 *
 * Two places must tell these apart, and they must not drift:
 *
 * 1. `composed-handler.ts` picks the user-facing hint. It already had this test
 *    inline and got it right — "Model not supported by this provider."
 * 2. `probe-live.ts` classifies the probe STATE, and did not — it returned
 *    `auth-failed` on the status alone, before any body inspection.
 *
 * One predicate, so the explanation and the state cannot disagree about what
 * happened. Same reasoning as `quota-exhaustion.ts`, which exists because a
 * spent plan also arrives under an auth-shaped status.
 *
 * Deliberately import-free: `probe-live.ts` has no dependencies at all, and a
 * pure string test keeps it that way with no risk of an import cycle.
 */

/**
 * Phrases that name the MODEL as the problem rather than the credential.
 *
 * Deliberately narrow, and the narrowness is load-bearing in the dangerous
 * direction: a false positive here tells a user with genuinely broken
 * credentials to go and check their model name instead. So every phrase names a
 * model or says "not supported" — never bare "invalid", "denied" or
 * "unauthorized", which are the vocabulary of real auth failures.
 */
const UNSUPPORTED_PHRASES = [
  "not supported",
  "unsupported model",
  "unsupported_model",
  "model not found",
  "model_not_found",
  "unknown model",
  "no such model",
] as const;

/**
 * True when this error body says the provider does not carry the requested
 * model, whatever status it arrived under.
 *
 * Status-agnostic ON PURPOSE: the whole point is that the status lies. Callers
 * that care about the status combine this with their own check — `probe-live`
 * consults it only for 401/403, because a 404 already means model-not-found and
 * needs no wording test.
 */
export function hasModelUnsupportedWording(errorBody: string): boolean {
  const lower = (errorBody || "").toLowerCase();
  return UNSUPPORTED_PHRASES.some((phrase) => lower.includes(phrase));
}
