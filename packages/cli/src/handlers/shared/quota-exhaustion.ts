/**
 * Detecting "your subscription allowance is spent" from an error response.
 *
 * ## Why this needs its own module
 *
 * Providers do not agree on how to report an exhausted plan. A 429 is the
 * obvious channel, but Kimi's coding plan answers with
 * `403 permission_error: "You've reached your usage limit for this billing
 * cycle"` — a status code otherwise reserved for authorization failures. Two
 * separate places in the codebase have to tell those apart, and they must not
 * drift:
 *
 * 1. `composed-handler.ts` picks the user-facing hint. Classifying an exhausted
 *    plan as an auth failure told users to "Check API key / OAuth credentials"
 *    while the provider's own explanation sat in the same message — sending
 *    them to debug a credential that was working perfectly.
 *
 * 2. `fallback-handler.ts` decides whether to advance the provider chain. This
 *    one costs money. A 403 is retryable there on the reasoning that "a
 *    different provider might have valid credentials", which is right for a
 *    genuine auth failure and wrong for an exhausted plan: the next candidate
 *    in a chain like `["kimi-coding", "kimi", "openrouter"]` is the SAME vendor
 *    billed per-token. Falling through silently converts "your subscription is
 *    out" into "you are now paying per token", with no prompt and no notice.
 *
 * Sharing one predicate keeps the CLI's explanation and the billing decision
 * from disagreeing about what happened.
 */

/**
 * Phrases that indicate a spent allowance rather than a bad credential.
 *
 * Deliberately narrow. A false positive here is not harmless in the other
 * direction: it would tell a user with genuinely broken credentials to go and
 * check their billing. So this matches only wording about limits, cycles and
 * balances — never bare "permission", "denied", "forbidden" or "invalid",
 * which are the vocabulary of real auth failures.
 */
const EXHAUSTION_PHRASES = [
  "usage limit",
  "billing cycle",
  "quota",
  "insufficient balance",
  "insufficient_quota",
  "upgrade your plan",
  "exceeded your current",
  "out of credits",
  "credit balance",
] as const;

/**
 * True when this response says the plan/allowance is spent.
 *
 * Scoped to the statuses providers actually use for it. 402 is excluded on
 * purpose: it already means "payment required" and is already handled as its
 * own case by both callers.
 */
export function isQuotaExhaustionError(status: number, errorBody: string): boolean {
  if (status !== 401 && status !== 403 && status !== 429) return false;
  const lower = (errorBody || "").toLowerCase();
  return EXHAUSTION_PHRASES.some((phrase) => lower.includes(phrase));
}
