/**
 * Shared helpers for ~/.claudish/all-models.json
 *
 * This file is written and read by four independent consumers:
 *   - providers/catalog-resolvers/openrouter.ts (v2 authoritative — Firebase slim catalog)
 *   - cli.ts (fetchRemoteModels + printAllModels)
 *   - mcp-server.ts (loadAllModels)
 *   - model-selector.ts (fetchAllModels + shouldRefreshForFreeModels)
 *
 * Historically each consumer wrote its own v1-shape `{lastUpdated, models}` blob,
 * clobbering the v2 `entries` array that the OpenRouter catalog resolver relies on.
 *
 * This module provides a single normalized v2 read/write API:
 *   - `readAllModelsCache()` returns a v2 shape (normalizing v1 files on the fly)
 *   - `writeAllModelsCache(partial)` merges with the existing file so callers that
 *     only supply `models` do NOT destroy the Firebase `entries` catalog.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Slim catalog entry from the Firebase queryModels?catalog=slim endpoint.
 * Contains only what's needed for model name resolution.
 */
export interface SlimModelEntry {
  modelId: string;
  aliases: string[];
  sources: Record<string, { externalId: string }>;
}

/**
 * Disk cache format (version 2).
 * Contains both the slim Firebase data (for resolver) and a backward-compatible
 * models array (for existing consumers in cli.ts/mcp-server.ts that expect {id: string}).
 */
export interface DiskCacheV2 {
  version: 2;
  lastUpdated: string;
  entries: SlimModelEntry[];
  /** Backward-compatible: [{id: "vendor/model"}] for legacy consumers */
  models: Array<{ id: string }>;
}

export const ALL_MODELS_CACHE_PATH = join(homedir(), ".claudish", "all-models.json");

/**
 * Read the cache from disk, normalizing legacy v1 files to a v2 shape.
 *
 * Returns null if the file doesn't exist or is unparseable.
 * A legacy v1 file `{lastUpdated, models}` is normalized to
 * `{version: 2, lastUpdated, entries: [], models}` so callers can treat both
 * the same way.
 *
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV2 | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const lastUpdated =
    typeof data.lastUpdated === "string" ? data.lastUpdated : new Date(0).toISOString();
  const models = Array.isArray(data.models) ? (data.models as Array<{ id: string }>) : [];
  const entries = Array.isArray(data.entries) ? (data.entries as SlimModelEntry[]) : [];

  return {
    version: 2,
    lastUpdated,
    entries,
    models,
  };
}

/**
 * Write the cache to disk in v2 format, preserving any existing `entries`
 * or `models` the caller did not explicitly supply.
 *
 * This is the critical anti-clobber behavior: legacy writers that only know
 * about `models` will merge on top of the existing v2 `entries`, leaving the
 * OpenRouter Firebase catalog intact.
 *
 * @param data Partial DiskCacheV2. Any omitted fields are filled from the
 *             existing file (if present) rather than reset to defaults.
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function writeAllModelsCache(
  data: Partial<DiskCacheV2>,
  path: string = ALL_MODELS_CACHE_PATH
): void {
  const existing = readAllModelsCache(path);

  const merged: DiskCacheV2 = {
    version: 2,
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
    entries: data.entries ?? existing?.entries ?? [],
    models: data.models ?? existing?.models ?? [],
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged), "utf-8");
}
