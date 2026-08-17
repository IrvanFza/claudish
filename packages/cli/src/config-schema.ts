/**
 * Config schemas for the LiteLLM-demotion refactor (Phase 1).
 *
 * Defines:
 *   - BuiltinDefaultProviderSchema — enum of provider names users can name as
 *     their default provider for bare model names.
 *   - CustomEndpointSimpleSchema    — "URL + format + key" custom endpoints.
 *   - CustomEndpointComplexSchema   — full provider profile (Phase 3 will register).
 *   - CustomEndpointSchema          — discriminated union of the two.
 *   - DefaultProviderSchema         — builtin enum OR custom-endpoint name string.
 *
 * NOTE: This module is intentionally NOT imported by `profile-config.ts`.
 * Validation happens at the consumption site (Phase 3 will add a
 * `loadCustomEndpoints()` helper that calls Zod and warns on invalid entries).
 * Keeping `profile-config.ts` Zod-free matters because `loadConfig` is called
 * from many lightweight code paths.
 */

import { z } from "zod";

// Built-in providers users can name as their default.
// "litellm" is preserved for legacy compat (Phase 2 will gate auto-promotion on this).
export const BuiltinDefaultProviderSchema = z.enum([
  "openrouter",
  "litellm",
  "openai",
  "anthropic",
  "google",
]);

// "Simple" custom endpoint: just URL + format + key.
// Reuses existing OpenAI/Anthropic format converters and a generic transport.
export const CustomEndpointSimpleSchema = z.object({
  kind: z.literal("simple"),
  url: z.url(),
  format: z.enum(["openai", "anthropic"]),
  apiKey: z.string().min(1),
  modelPrefix: z.string().optional(),
  models: z.array(z.string()).optional(),
});

// "Complex" custom endpoint: a runtime PROVIDER_PROFILES entry.
// All ProviderProfile fields, with reasonable defaults documented in Phase 3.
export const CustomEndpointComplexSchema = z.object({
  kind: z.literal("complex"),
  displayName: z.string(),
  transport: z.enum(["openai", "anthropic", "gemini", "ollamacloud", "litellm"]),
  baseUrl: z.url(),
  apiPath: z.string().optional(),
  apiKey: z.string().min(1),
  authScheme: z.enum(["bearer", "x-api-key"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  streamFormat: z
    .enum(["openai-sse", "openai-responses-sse", "gemini-sse", "anthropic-sse", "ollama-jsonl"])
    .optional(),
  modelPrefix: z.string().optional(),
  models: z.array(z.string()).optional(),
});

export const CustomEndpointSchema = z.discriminatedUnion("kind", [
  CustomEndpointSimpleSchema,
  CustomEndpointComplexSchema,
]);

/**
 * Opt-out surface for the BUNDLED endpoint catalog (`predefined-catalog.ts`).
 *
 *   "predefinedEndpoints": {
 *     "enabled": false,              // the whole catalog is off
 *     "disable": ["groq"],           // individual opt-out, case-insensitive
 *     "enable":  ["tuningengines"]   // activate despite no locally-present key
 *   }
 *
 * `enable` exists because activation is otherwise inferred from a credential
 * being present SYNCHRONOUSLY, and a key that lives only behind an `op://`
 * reference cannot be seen without the async 1Password path — which the gate
 * deliberately cannot reach. It is also the answer for a keyless self-hosted
 * gateway sitting behind network auth.
 *
 * `disable` beats `enable`: refusals beat permissions, the same rule that puts
 * the collision check ahead of the credential gate.
 *
 * NOT `.strict()`, deliberately — an unknown key here is a forward-compat
 * config from a newer claudish, and the right response to that is to honour the
 * keys we understand, not to discard the block. Unknown NAMES in `disable` /
 * `enable` are likewise a silent no-op: a user who opts out of a vendor that is
 * later dropped from the bundle should not collect a warning on every launch
 * for a line that is now simply inert.
 */
export const PredefinedEndpointsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  disable: z.array(z.string()).optional(),
  enable: z.array(z.string()).optional(),
});

// defaultProvider can be a builtin OR the name of a custom endpoint
// (we validate the cross-reference at load time, not in the schema).
export const DefaultProviderSchema = z.union([BuiltinDefaultProviderSchema, z.string().min(1)]);

export type BuiltinDefaultProvider = z.infer<typeof BuiltinDefaultProviderSchema>;
export type CustomEndpointSimple = z.infer<typeof CustomEndpointSimpleSchema>;
export type CustomEndpointComplex = z.infer<typeof CustomEndpointComplexSchema>;
export type CustomEndpoint = z.infer<typeof CustomEndpointSchema>;
export type PredefinedEndpointsConfig = z.infer<typeof PredefinedEndpointsConfigSchema>;
