/**
 * The one header that makes recovery chain-safety STRUCTURAL rather than a
 * wording rule.
 *
 * ## What it is for
 *
 * When a tier-1 hold exhausts its deadline with a surface still painting the
 * reason, `ComposedHandler` answers **503 `overloaded_error`** instead of
 * today's terminal 400, so Claude Code re-POSTs and the turn survives into
 * tier 2. That status then has to travel past `FallbackHandler`, and the
 * fallback chain is where a mistake here costs the user real money rather than
 * time: advancing off a `SUBSCRIPTION_PROVIDERS` candidate onto a metered one
 * quotes a per-token price for a fault that had nothing to do with the
 * provider.
 *
 * ## Why a header and not a status, and not a wording rule
 *
 * `fallback-handler.ts`'s `isRetryableError` has no 503 branch, so on the
 * status alone a 503 already stops the chain. That is NOT enough, twice over:
 *
 * 1. **The FIRST statement in its body is `hasQuotaExhaustionWording(errorBody)`,
 *    which is deliberately status-agnostic** — it exists because the transport
 *    has already remapped terminal errors to 400, so a status-gated test there
 *    would miss a spent plan. Its phrase list contains the **bare substring
 *    `"quota"`**, plus `"usage limit"`, `"plan limit"`, `"daily limit"`,
 *    `"billing cycle"`, `"credit balance"`, `"out of credits"` and
 *    `"exceeded your current"`. A 503 whose MESSAGE happens to trip that list
 *    advances the chain and spends the user's money. Checking the marker FIRST
 *    removes the message from the decision entirely.
 * 2. **A 503 does not necessarily reach the client.** When a candidate's error
 *    is not retryable and earlier candidates already failed, `handle()` pushes
 *    it and calls `formatCombinedError`, whose status comes from
 *    `exhaustedChainStatus(errors)` — 503 only if EVERY accumulated error is
 *    transient. One earlier auth/404 failure turns our 503 into a terminal 400
 *    and tier 2 never begins. The marker makes the response return VERBATIM
 *    before it can be folded into a combined one.
 *
 * ## Why it cannot be forged by an upstream provider
 *
 * The marker is only ever minted on a `Response` this process constructs, and
 * verified at source (2026-09-11):
 *
 * - every non-ok exit from `ComposedHandler` is `c.json(...)` — Hono builds
 *   those headers from nothing, so an upstream's headers are never copied onto
 *   a failure response. The single `c.header()` call in that file
 *   (`X-Dropped-Params`) sits AFTER the `!response.ok` early returns;
 * - the one path that DOES copy upstream headers verbatim,
 *   `stream-head-sniffer.ts`'s `replayResponse()`, is reachable only from step
 *   7b, which runs after `!response.ok` has already returned — i.e. on a 200.
 *   `FallbackHandler` returns an ok response as success before it ever looks at
 *   the marker, so a forged one on a 200 changes nothing.
 *
 * Keep both properties true. If a future edit returns an upstream `Response`
 * object on a non-ok path, the marker must be stripped there.
 */

/** The header name. Referenced by name in no other file — import this. */
export const RECOVERY_MARKER_HEADER = "x-claudish-recovery";

/** The only value that counts. Anything else is not our response. */
export const RECOVERY_MARKER_VALUE = "1";

/**
 * The headers a tier-1 exhaustion 503 carries.
 *
 * `x-should-retry` is read by the Anthropic TS SDK's `shouldRetry` before it
 * looks at the status at all, so it survives a future change to Claude Code's
 * status classification. It is set ONLY on this arm.
 */
export function recoveryHoldHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-should-retry": "true",
    [RECOVERY_MARKER_HEADER]: RECOVERY_MARKER_VALUE,
  };
}

/** Does this header bag carry the marker? Tolerates `undefined` for callers that have none. */
export function hasRecoveryMarker(headers: Headers | undefined | null): boolean {
  try {
    return headers?.get(RECOVERY_MARKER_HEADER) === RECOVERY_MARKER_VALUE;
  } catch {
    // A synthesised response with a non-Headers `headers` field. Not ours.
    return false;
  }
}

/** Is this response claudish's own recovery-exhaustion 503? */
export function isRecoveryHoldResponse(
  response: { headers?: Headers } | null | undefined
): boolean {
  return hasRecoveryMarker(response?.headers);
}
