/**
 * Provider definitions for the claudish config TUI.
 * Derived from BUILTIN_PROVIDERS — single source of truth.
 */

import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { getAllProviders, type ProviderDefinition } from "../providers/provider-definitions.js";

export interface ProviderDef {
  /** TUI-facing name (e.g. "gemini" for the renamed Google direct API). */
  name: string;
  /** Original catalog name — needed for OAuth credential lookups
   *  (hasOAuthCredentials uses catalog names like "google", not "gemini"). */
  catalogName: string;
  displayName: string;
  apiKeyEnvVar: string;
  description: string;
  keyUrl: string;
  endpointEnvVar?: string;
  defaultEndpoint?: string;
  aliases?: string[];
  /**
   * If set, this provider supports OAuth login via `claudish login {slug}`.
   * Used by the Providers tab `l` keybinding.
   */
  oauthSlug?: "gemini" | "codex" | "kimi";
}

// Skip virtual providers that have no API key and no TUI presence
const SKIP = new Set(["qwen", "native-anthropic"]);

function toProviderDef(def: ProviderDefinition): ProviderDef {
  return {
    name: def.name === "google" ? "gemini" : def.name,
    catalogName: def.name,
    displayName: def.displayName,
    apiKeyEnvVar: def.apiKeyEnvVar,
    description: def.description || def.apiKeyDescription,
    keyUrl: def.apiKeyUrl,
    endpointEnvVar: def.baseUrlEnvVars?.[0],
    defaultEndpoint: def.baseUrl || undefined,
    aliases: def.apiKeyAliases,
    // Sourced from the catalog (provider-definitions.ts), not a duplicate
    // table here. If a provider supports `claudish login {slug}`, the
    // catalog entry declares which slug.
    oauthSlug: def.oauthLoginSlug,
  };
}

/**
 * Compute the authentication source for a provider: where the credentials
 * actually come from. Used for the AUTH column on the Providers tab and
 * for sorting "configured first".
 *
 * Priority (highest to lowest):
 *   1. "e+c"  - both env var AND config-file key present
 *   2. "env"  - env var only
 *   3. "cfg"  - config-file key only
 *   4. "oauth" - valid OAuth credentials on disk (no env/cfg key)
 *   5. null   - no credentials of any kind
 */
export type AuthSource = "e+c" | "env" | "cfg" | "oauth" | null;

export function providerAuthSource(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string> },
): AuthSource {
  const hasCfg = !!p.apiKeyEnvVar && !!config.apiKeys?.[p.apiKeyEnvVar];
  const hasEnv = !!p.apiKeyEnvVar && !!process.env[p.apiKeyEnvVar];
  if (hasEnv && hasCfg) return "e+c";
  if (hasEnv) return "env";
  if (hasCfg) return "cfg";
  if (hasOAuthCredentials(p.catalogName)) return "oauth";
  return null;
}

/** True when a provider has any usable credentials (key OR OAuth). */
export function providerIsReady(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string> },
): boolean {
  return providerAuthSource(p, config) !== null;
}

export const PROVIDERS: ProviderDef[] = getAllProviders()
  .filter((d) => !SKIP.has(d.name))
  .map(toProviderDef);

/**
 * Fixed 8-character visually dense key mask.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "────────";
  if (key.length < 8) return "****    ";
  return `${key.slice(0, 3)}••${key.slice(-3)}`;
}
