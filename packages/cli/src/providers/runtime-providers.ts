/**
 * Runtime Provider Registry
 *
 * A small Map-backed registry for provider definitions and profiles that are
 * registered at startup (not compile time). Used by `custom-endpoints-loader.ts`
 * to make user-declared custom endpoints appear in lookups and handler creation.
 *
 * Kept separate from `provider-definitions.ts` so BUILTIN_PROVIDERS stays a true
 * const and the registry can be cleared/inspected in isolation during tests.
 *
 * Adding to this registry must NOT mutate BUILTIN_PROVIDERS — callers consult
 * both sources via `getAllProviders()` and the lookup helpers.
 */

import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderProfile } from "./provider-profiles.js";

const _runtimeProviders = new Map<string, ProviderDefinition>();
const _runtimeProfiles = new Map<string, ProviderProfile>();

/**
 * Register a runtime ProviderDefinition. Overwrites any existing entry with
 * the same name (idempotent — safe to call twice from the loader).
 */
export function registerRuntimeProvider(def: ProviderDefinition): void {
  _runtimeProviders.set(def.name, def);
}

/**
 * Register a runtime ProviderProfile. Overwrites any existing entry.
 */
export function registerRuntimeProfile(name: string, profile: ProviderProfile): void {
  _runtimeProfiles.set(name, profile);
}

/**
 * Get all runtime-registered provider definitions.
 * Returns a read-only view of the internal map.
 */
export function getRuntimeProviders(): ReadonlyMap<string, ProviderDefinition> {
  return _runtimeProviders;
}

/**
 * Get all runtime-registered provider profiles.
 * Returns a read-only view of the internal map.
 */
export function getRuntimeProfiles(): ReadonlyMap<string, ProviderProfile> {
  return _runtimeProfiles;
}

/**
 * Clear the runtime registry. Intended for tests — invoke in beforeEach()
 * to ensure isolation between test cases.
 */
export function clearRuntimeRegistry(): void {
  _runtimeProviders.clear();
  _runtimeProfiles.clear();
}
