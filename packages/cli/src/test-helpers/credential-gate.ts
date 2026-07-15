/**
 * Credential gating for real-API e2e tests — via claudish's OWN authority.
 *
 * Real-API tests must skip when no credential can serve their model. The
 * obvious gate (`!!process.env.SOME_API_KEY`) is WRONG: it only sees raw env,
 * while claudish resolves a provider's key through `CredentialAuthority` —
 * "THE single readiness oracle" — which checks env → aliases →
 * `~/.claudish/config.json` `apiKeys` → 1Password (`op://` refs / globs).
 *
 * So a user who configured keys the supported ways (`claudish config`, the
 * 1Password tab, an `op://` ref) has a fully working claudish while every
 * env-gated e2e test silently skips — the suite reports "green" having tested
 * nothing. Gating on the authority keeps the tests honest: they run exactly
 * when claudish itself could serve the request.
 *
 * `isAvailable` never throws (unknown provider / 1Password failure → false) and
 * does not prompt (`allowOpPrompt` is left off), so it is safe to await at
 * test-module load.
 *
 * Provider names are the BUILTIN_PROVIDERS names, e.g.: openrouter, openai,
 * google, x-ai, glm, glm-coding, z-ai, minimax, kimi, litellm, deepseek,
 * sakana, vertex, native-anthropic.
 */

import { credentials } from "../auth/credentials/authority.js";

/** True when claudish can serve `provider` (env, config apiKeys, or 1Password). */
export async function hasCredential(provider: string): Promise<boolean> {
  return credentials.isAvailable(provider);
}

/** True when claudish can serve AT LEAST ONE of `providers`. */
export async function hasAnyCredential(providers: string[]): Promise<boolean> {
  const results = await Promise.all(providers.map((p) => hasCredential(p)));
  return results.some(Boolean);
}
