/**
 * Shared constants for the TUI. Extracted from App.tsx so both the keyboard
 * handler (App.tsx) and the render components can import them.
 */

import { PROVIDERS } from "./providers.js";

// Common models offered as autocomplete suggestions in the profile editor.
export const COMMON_MODELS = [
  "g@gemini-3.1-pro-preview",
  "g@gemini-2.5-flash",
  "g@gemini-2.5-pro",
  "oai@gpt-4o",
  "oai@gpt-4o-mini",
  "oai@o3-mini",
  "or@anthropic/claude-sonnet-4-20250514",
  "mm@minimax-m2.5",
  "kimi@kimi-k2.5",
  "glm@glm-5",
  "zen@glm-5",
  "zen@minimax-m2.5-free",
  "ll@gemini-2.5-flash",
  "ll@gpt-4o",
  "or@google/gemini-3.1-pro-preview",
  "or@x-ai/grok-code-fast-1",
  "or@deepseek/deepseek-r1",
];

// Provider prefix suggestions for the provider picker (e.g. "g@", "oai@", ...).
export const PROVIDER_PREFIXES = PROVIDERS.map((p) => ({
  prefix: p.aliases?.[0] ? `${p.aliases[0]}@` : `${p.name}@`,
  displayName: p.displayName,
  name: p.name,
}));

// Chain selector uses same PROVIDERS list for consistent naming.
export const CHAIN_PROVIDERS = PROVIDERS;

// Layout constants — header(1) + tab-bar(3) + content(flex) + detail(fixed) + footer(1).
export const HEADER_H = 1;
export const TABS_H = 3;
export const FOOTER_H = 1;
export const DETAIL_H = 7;

export const VERSION = "v5.16";
