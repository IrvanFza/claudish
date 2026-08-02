/**
 * provider-quota — tell "this provider's ACCOUNT is drained" apart from
 * "claudish broke".
 *
 * Real-API e2e tests are gated on whether a credential EXISTS
 * (`hasCredential`), which says nothing about whether the account can still
 * serve a request. When the balance runs out, a test whose job is to verify a
 * STREAM TRANSLATION PATH starts failing with a billing error — and a red
 * translation test reads as a regression in exactly the code it was written to
 * protect. A drained account is an environment condition and should skip, the
 * same way a missing key already does.
 *
 * Deliberately NARROW. It requires the claudish-side guidance string AND an
 * upstream billing signal (HTTP 429 or "insufficient balance"), so it cannot
 * swallow the failure these tests actually exist to catch — e.g. the #102
 * empty-response signature, which carries neither.
 *
 * Accepts `unknown` because the two callers see different shapes: an Error
 * thrown by the proxy (zai-glm.e2e.test.ts) and raw captured pane output from a
 * PTY (team-grid.e2e.test.ts).
 */
export const PROVIDER_QUOTA_GUIDANCE = "Out of quota — check your plan & billing details";

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : `\n${String(error.cause)}`;
    return `${error.message}${cause}`;
  }
  return String(error);
}

export function isConfirmedProviderQuotaError(error: unknown): boolean {
  const text = errorText(error);
  const hasQuotaGuidance = text.includes(PROVIDER_QUOTA_GUIDANCE);
  const hasUpstreamQuotaSignal =
    /insufficient balance/i.test(text) || /(?:HTTP|upstream_status["']?\s*:)\s*429/i.test(text);
  return hasQuotaGuidance && hasUpstreamQuotaSignal;
}
