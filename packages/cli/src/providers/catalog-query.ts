/**
 * Read-only accessor module over the slim model catalog cache
 * (`~/.claudish/all-models.json`).
 *
 * Used by feature code that needs to look up catalog entries without going
 * through the full `OpenRouterCatalogResolver` resolution chain. The resolver
 * is concerned with vendor-prefix translation for outbound API calls; this
 * module is concerned with answering "what does the catalog say about model
 * X / alias Y?" for cleanup-side consumers (vision proxy, advisor tier
 * resolution, pricing lookup).
 *
 * Architecture reference: §6.B in
 * `ai-docs/sessions/dev-feature-catalog-warm-hardcoded-cleanup-20260508-202624-9f3f45b8/architecture.md`.
 *
 * Design notes:
 *   - Sync. Reads through `readAllModelsCache()` (file read + JSON parse,
 *     fast enough for once-per-request use). A mtime-keyed memo will be added
 *     in commit 6 to make the per-request pricing-cache hot path cheap.
 *   - All three functions return `null` when the disk cache is missing OR
 *     when no matching entry exists. They never throw.
 *   - Aliases are matched case-sensitive (the slim catalog stores them in
 *     canonical form; case-insensitive lookups are the resolver's job, not
 *     this module's).
 *   - We expose a minimal `CatalogEntryQueryResult` shape rather than the
 *     full `SlimModelEntry` so callers don't depend on internal slim-cache
 *     structure (e.g., `sources`, `aggregators`). Add fields here as new
 *     consumers need them.
 */

import { readAllModelsCache, type SlimModelEntry } from "./all-models-cache.js";

/**
 * Minimal projection of a slim catalog entry for query consumers.
 *
 * Intentionally narrower than `SlimModelEntry` — only fields that current
 * callers (advisor tier resolution, vision proxy, pricing cache) need. If a
 * new caller needs `aggregators` or `sources` they should be added here
 * explicitly (with a doc comment) rather than callers reaching into the raw
 * `SlimModelEntry` shape.
 */
export interface CatalogEntryQueryResult {
  modelId: string;
  aliases: string[];
  /** Whether the model supports vision/image input. Optional — may be absent on older entries. */
  supportsVision?: boolean;
  /** Context window in tokens. Optional — may be absent on older entries. */
  contextWindow?: number;
}

function project(entry: SlimModelEntry): CatalogEntryQueryResult {
  return {
    modelId: entry.modelId,
    aliases: entry.aliases,
    supportsVision: entry.supportsVision,
    contextWindow: entry.contextWindow,
  };
}

/**
 * Find a slim entry whose `aliases[]` includes the given alias (case-sensitive).
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable (`readAllModelsCache` → null), OR
 *   - the cache has no entries, OR
 *   - no entry's `aliases` array contains `alias`.
 *
 * Never throws.
 */
export function findEntryByAlias(alias: string): CatalogEntryQueryResult | null {
  const cache = readAllModelsCache();
  if (!cache) return null;

  const entries = cache.entries;
  if (entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.aliases.includes(alias)) {
      return project(entry);
    }
  }
  return null;
}

/**
 * Find a slim entry by exact `modelId` match (case-sensitive).
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable, OR
 *   - the cache has no entries, OR
 *   - no entry's `modelId` equals `modelId`.
 *
 * Never throws.
 */
export function findEntryByModelId(modelId: string): CatalogEntryQueryResult | null {
  const cache = readAllModelsCache();
  if (!cache) return null;

  const entries = cache.entries;
  if (entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.modelId === modelId) {
      return project(entry);
    }
  }
  return null;
}

/**
 * Find an entry whose `aliases[]` includes `alias` AND whose
 * `supportsVision === true`.
 *
 * The catalog may have multiple entries that share a common alias (e.g., two
 * models tagged "sonnet"); only ones with `supportsVision === true` qualify.
 * The first match wins — entries are searched in the order they appear in the
 * cache, which matches the order Firebase returns them.
 *
 * Returns `null` when:
 *   - the disk cache is missing or unparseable, OR
 *   - the cache has no entries, OR
 *   - no entry both contains the alias and has `supportsVision === true`.
 *
 * Never throws.
 */
export function findVisionAlias(alias: string): CatalogEntryQueryResult | null {
  const cache = readAllModelsCache();
  if (!cache) return null;

  const entries = cache.entries;
  if (entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.supportsVision === true && entry.aliases.includes(alias)) {
      return project(entry);
    }
  }
  return null;
}
