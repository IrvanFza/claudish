/**
 * Provider definitions for the claudish config TUI.
 * Derived from BUILTIN_PROVIDERS — single source of truth.
 */

import { getAllProviders, type ProviderDefinition } from "../providers/provider-definitions.js";

export interface ProviderDef {
  name: string;
  displayName: string;
  apiKeyEnvVar: string;
  description: string;
  keyUrl: string;
  endpointEnvVar?: string;
  defaultEndpoint?: string;
  aliases?: string[];
  /**
   * If set, this provider supports OAuth login via `claudish login {slug}`.
   * Derived from the underlying provider catalog's oauthFallback field
   * mapped to the three login subcommand slugs: gemini, codex, kimi.
   * Used by the Providers tab `l` keybinding to offer in-place OAuth flow.
   */
  oauthSlug?: "gemini" | "codex" | "kimi";
}

// Skip virtual providers that have no API key and no TUI presence
const SKIP = new Set(["qwen", "native-anthropic"]);

function toProviderDef(def: ProviderDefinition): ProviderDef {
  return {
    name: def.name === "google" ? "gemini" : def.name,
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
