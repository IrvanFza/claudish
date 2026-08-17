/**
 * Why an endpoint provider is not answering — recorded where the reason is
 * KNOWN, read where the error is PRINTED.
 *
 * The routing pre-flight has exactly one way of expressing "there is no handler
 * for this explicit `provider@model`": `proxy-server.ts` reports *no credential*
 * and names the env var to set. That is right for the overwhelmingly common
 * case and wrong for every other one — a bundled endpoint skipped because its
 * `*_BASE_URL` override is malformed, or because its name collides with a
 * builtin, produces the identical message, sending the user to look for a key
 * they already have. "Absence with the wrong reason" is the failure this
 * codebase keeps paying for; a skip message that is indistinguishable from
 * absence is barely better than silence.
 *
 * So: whoever decides an endpoint cannot serve requests records that decision
 * here, and the routing error prefers it over its own guess. Deliberately tiny
 * and dependency-free — it is imported by both the loader and the proxy, and it
 * must not become a place where anything else lives.
 *
 * Process-scoped and last-write-wins, which is correct: a later successful
 * registration CLEARS the entry, so a user who fixes their URL and re-runs (or
 * re-registers via the config TUI) does not keep reading a stale reason.
 */

const reasons = new Map<string, string>();

/**
 * Record why `name` cannot serve requests. `reason` is spliced into a sentence
 * after an em dash, so it should read as a clause: "its TUNING_ENGINES_BASE_URL
 * is set to '…', which is not a valid http(s) URL".
 */
export function recordEndpointUnavailable(name: string, reason: string): void {
  reasons.set(name, reason);
}

/** Forget any recorded reason for `name` — call on successful registration. */
export function clearEndpointUnavailable(name: string): void {
  reasons.delete(name);
}

/** The recorded reason, or `undefined` when nothing better than "no credential" is known. */
export function getEndpointUnavailableReason(name: string): string | undefined {
  return reasons.get(name);
}

/** Test-only: drop every recorded reason. */
export function __resetEndpointDiagnosticsForTests(): void {
  reasons.clear();
}
