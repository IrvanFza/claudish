/**
 * Pure resolver for the effective default provider used when a bare model name
 * is supplied without an explicit `provider@` prefix.
 *
 * No imports from cli.ts or proxy-server.ts (otherwise we get import cycles).
 * Reads from a passed-in config object, env vars, and an optional CLI flag.
 *
 * LiteLLM auto-promotion was removed in commit 5 of the model-catalog and
 * routing redesign. Users who relied on `LITELLM_BASE_URL` + `LITELLM_API_KEY`
 * triggering "make LiteLLM the default" must add `defaultProvider: "litellm"`
 * to `~/.claudish/config.json` (or set `CLAUDISH_DEFAULT_PROVIDER=litellm`).
 */

import type { ClaudishProfileConfig } from "./profile-config.js";

export type DefaultProviderSource =
  | "cli-flag"
  | "env-var"
  | "config-file"
  | "openrouter-key"
  | "hardcoded";

export interface ResolvedDefaultProvider {
  /** Resolved provider name (builtin or custom-endpoint name). */
  provider: string;
  /** Where the value came from. */
  source: DefaultProviderSource;
  /**
   * Always `false` post-commit-5. Field is preserved for type-stability with
   * existing callers that pattern-match on it; will be removed in a future
   * cleanup once those callers are gone.
   */
  legacyAutoPromoted: boolean;
}

export interface ResolveOptions {
  cliFlag?: string;
  config: ClaudishProfileConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective default provider using the precedence chain:
 *   1. --default-provider CLI flag
 *   2. CLAUDISH_DEFAULT_PROVIDER env var
 *   3. config.json defaultProvider
 *   4. OPENROUTER_API_KEY present → "openrouter"
 *   5. hardcoded "openrouter"
 */
export function resolveDefaultProvider(opts: ResolveOptions): ResolvedDefaultProvider {
  const env = opts.env ?? process.env;

  if (opts.cliFlag && opts.cliFlag.length > 0) {
    return { provider: opts.cliFlag, source: "cli-flag", legacyAutoPromoted: false };
  }

  const envVal = env.CLAUDISH_DEFAULT_PROVIDER;
  if (envVal && envVal.length > 0) {
    return { provider: envVal, source: "env-var", legacyAutoPromoted: false };
  }

  if (opts.config.defaultProvider && opts.config.defaultProvider.length > 0) {
    return {
      provider: opts.config.defaultProvider,
      source: "config-file",
      legacyAutoPromoted: false,
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", source: "openrouter-key", legacyAutoPromoted: false };
  }

  return { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false };
}

/**
 * Legacy stub — LiteLLM auto-promotion was removed in commit 5; the hint never
 * fires anymore. Kept as a no-op for callers that still import it.
 */
export function buildLegacyHint(_resolved: ResolvedDefaultProvider): string | null {
  return null;
}
