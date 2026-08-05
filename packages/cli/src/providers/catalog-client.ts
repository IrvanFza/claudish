/**
 * The model catalog client — fetch, cache, and resolve, for ALL providers.
 *
 * This is the single source of truth for model facts. It fetches the Firebase
 * slim catalog, keeps it in memory and on disk (`~/.claudish/all-models.json`),
 * and answers "what does provider P call model M?" from `aggregators[]`.
 *
 * ## Why this file exists
 *
 * All of this previously lived inside `catalog-resolvers/openrouter.ts` behind
 * an `OpenRouterCatalogResolver` class, which made the app-wide catalog loader
 * look like an OpenRouter feature. It was not: `writeAllModelsCache` had exactly
 * one caller in the codebase, and every catalog read — context windows,
 * reasoning capability, tokenParam, routeVariant — depended on that class
 * having run. The name hid the dependency and made "why is there only one
 * resolver?" unanswerable.
 *
 * The per-provider resolver interface is gone with it. Name resolution was
 * never provider-specific logic — it is one lookup, `aggregators[]`, which the
 * catalog now populates for 18 providers. A registry of classes to perform one
 * table lookup per provider is a registry of one thing repeated.
 *
 * ## The two data sources, and which owns what
 *
 * - **This catalog (cloud, TTL'd)** owns model IDENTITY: what a model is, what
 *   it can do, what each provider calls it, what it costs. Same for everyone.
 * - **A provider's own live endpoint** (`model-discovery.ts`) owns ENTITLEMENT:
 *   which subset of those models THIS key may use, and the context window for
 *   THIS subscription tier. Per-user, and impossible to hold statically.
 *
 * They are joined on model id, not chained as fallbacks. There is deliberately
 * NO per-model cloud lookup for gaps: re-querying the same cloud one model at a
 * time returns the same answer N times more slowly. A field missing here is a
 * models-index gap to fix there.
 */

import {
  type DiskCacheV2,
  type SlimModelEntry,
  readAllModelsCache,
  writeAllModelsCache,
} from "./all-models-cache.js";

/**
 * Firebase slim catalog endpoint. Override via:
 *   - `CLAUDISH_CATALOG_URL` (preferred, documented spelling)
 *   - `FIREBASE_CATALOG_URL` (backwards-compat alias)
 *
 * Chiefly useful for integration tests that point at a local server to force
 * fetch failures.
 */
const FIREBASE_CATALOG_URL =
  process.env.CLAUDISH_CATALOG_URL ??
  process.env.FIREBASE_CATALOG_URL ??
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

// Re-export so existing imports of the DiskCache type keep working.
export type DiskCache = DiskCacheV2;

/**
 * Outcome of an explicit `refreshCatalog()` call.
 *
 * Unlike `warmCatalog()` (fire-and-forget, silent on failure), this returns
 * ground truth so the launcher can make a policy decision.
 */
export type RefreshOutcome =
  | { kind: "refreshed"; modelCount: number }
  | { kind: "fetch_failed"; reason: "timeout" | "network" | "http_error" | "empty" };

/** Result of resolving a user-typed model name for a provider. */
export interface ModelResolutionResult {
  /** The resolved model ID (e.g. "qwen/qwen3-coder-next"). */
  resolvedId: string;
  /** Whether resolution changed the input (false = passthrough unchanged). */
  wasResolved: boolean;
  /** Human-readable source label for the log line. */
  sourceLabel: string;
}

/** Module-level memory cache of slim catalog entries. */
let _memCache: SlimModelEntry[] | null = null;

/** In-flight warm, so concurrent callers await one fetch rather than N. */
let _warmPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Cache access
// ---------------------------------------------------------------------------

/**
 * All catalog entries: memory first, then the disk cache, then null.
 *
 * Null means "cold" — never "empty catalog". Callers must degrade to
 * passthrough rather than concluding a model does not exist.
 */
export function getCatalogEntries(): SlimModelEntry[] | null {
  if (_memCache) return _memCache;

  const cache = readAllModelsCache();
  if (!cache) return null;

  if (cache.entries.length > 0) {
    _memCache = cache.entries;
    return _memCache;
  }

  // Backward-compat: synthesize entries from a legacy v1 models array.
  if (cache.models.length > 0) {
    _memCache = cache.models.map((m) => ({
      modelId: m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id,
      aliases: [],
      sources: { "openrouter-api": { externalId: m.id } },
    }));
    return _memCache;
  }

  return null;
}

/** Whether the in-memory catalog is populated. */
export function isCatalogWarm(): boolean {
  return _memCache !== null && _memCache.length > 0;
}

/** Test seam: drop the in-memory catalog and any in-flight warm. @internal */
export function _resetCatalogClient(): void {
  _memCache = null;
  _warmPromise = null;
}

// ---------------------------------------------------------------------------
// Name resolution — generic over aggregators[]
// ---------------------------------------------------------------------------

/**
 * What `provider` calls `entry`, or null if it does not serve it.
 *
 * `aggregators[]` is the typed multi-provider routing index and the primary
 * source. The `sources` fallbacks below exist only for OpenRouter, whose
 * catalog rows predate `aggregators[]`; without them a cold or partially
 * ingested row would stop resolving vendor prefixes that used to work.
 */
export function externalIdFor(entry: SlimModelEntry, provider: string): string | null {
  const agg = entry.aggregators?.find((a) => a.provider === provider);
  if (agg?.externalId) return agg.externalId;

  if (provider !== "openrouter") return null;

  const orSource = entry.sources["openrouter-api"];
  if (orSource?.externalId) return orSource.externalId;

  // Last resort: any source carrying a vendor-prefixed id.
  for (const src of Object.values(entry.sources)) {
    if (src.externalId.includes("/")) return src.externalId;
  }
  return null;
}

/**
 * Resolve a user-typed model name to the id `provider` accepts.
 *
 * Chain (first hit wins):
 *  1. Already vendor-prefixed → exact `externalId` match, else passthrough.
 *  2. Exact `modelId` match.
 *  3. `aliases[]` match.
 *  4. Any provider's `externalId` matches the input (cross-provider hop).
 *  5. Suffix match on this provider's external ids (`/name`).
 *  6. Case-insensitive suffix match.
 *
 * Returns null on a cold cache or no match — the caller sends the input
 * unchanged.
 */
export function resolveExternalId(userInput: string, provider: string): string | null {
  const entries = getCatalogEntries();

  // Step 1: already vendor-prefixed.
  if (userInput.includes("/")) {
    if (entries) {
      for (const entry of entries) {
        for (const src of Object.values(entry.sources)) {
          if (src.externalId === userInput) return userInput;
        }
      }
    }
    return userInput;
  }

  if (!entries) return null;

  // Step 2: exact modelId.
  const byModelId = entries.find((e) => e.modelId === userInput);
  if (byModelId) {
    const id = externalIdFor(byModelId, provider);
    if (id) return id;
  }

  // Step 3: aliases.
  const byAlias = entries.find((e) => e.aliases.includes(userInput));
  if (byAlias) {
    const id = externalIdFor(byAlias, provider);
    if (id) return id;
  }

  // Step 4: the input is some other provider's external id.
  for (const entry of entries) {
    for (const src of Object.values(entry.sources)) {
      if (src.externalId === userInput) {
        const id = externalIdFor(entry, provider);
        if (id) return id;
      }
    }
  }

  // Step 5: suffix match.
  const suffix = `/${userInput}`;
  for (const entry of entries) {
    const id = externalIdFor(entry, provider);
    if (id?.endsWith(suffix)) return id;
  }

  // Step 6: case-insensitive suffix match.
  const lowerSuffix = `/${userInput.toLowerCase()}`;
  for (const entry of entries) {
    const id = externalIdFor(entry, provider);
    if (id?.toLowerCase().endsWith(lowerSuffix)) return id;
  }

  return null;
}

/**
 * Synchronous resolution entry point, called before handler construction.
 *
 * OpenRouter is the one provider that resolves even an already-prefixed name,
 * because the vendor part users type is frequently wrong.
 */
export function resolveModelNameSync(
  userInput: string,
  targetProvider: string
): ModelResolutionResult {
  if (targetProvider !== "openrouter" && userInput.includes("/")) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolved = resolveExternalId(userInput, targetProvider);
  if (!resolved || resolved === userInput) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  return { resolvedId: resolved, wasResolved: true, sourceLabel: `${targetProvider} catalog` };
}

/** Emit a resolution notice to stderr (after `wasResolved=true`). */
export function logResolution(
  userInput: string,
  result: ModelResolutionResult,
  quiet = false
): void {
  if (result.wasResolved && !quiet) {
    process.stderr.write(
      `[Model] Resolved "${userInput}" → "${result.resolvedId}" (${result.sourceLabel})\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch / warm
// ---------------------------------------------------------------------------

/**
 * One-shot catalog fetch with explicit success/failure return.
 *
 * On success replaces `_memCache` atomically AFTER the body parses, writes the
 * disk cache, and marks the warm as settled. On any failure leaves both caches
 * untouched and returns the reason. Never throws.
 */
export async function refreshCatalog(timeoutMs: number): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(FIREBASE_CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string } | null | undefined)?.name;
    const reason: "timeout" | "network" =
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return { kind: "fetch_failed", reason };
  }

  if (!response.ok) return { kind: "fetch_failed", reason: "http_error" };

  let data: { models: SlimModelEntry[]; total?: number };
  try {
    data = (await response.json()) as { models: SlimModelEntry[]; total?: number };
  } catch {
    // Got a response but could not read it — network-class, distinct from "empty".
    return { kind: "fetch_failed", reason: "network" };
  }

  if (!Array.isArray(data.models) || data.models.length === 0) {
    return { kind: "fetch_failed", reason: "empty" };
  }

  // Build the backward-compat models array BEFORE mutating shared state, so a
  // throw below leaves _memCache and the disk file untouched.
  const backwardCompatModels: Array<{ id: string }> = [];
  for (const entry of data.models) {
    const id = externalIdFor(entry, "openrouter");
    if (id) backwardCompatModels.push({ id });
  }

  _memCache = data.models;
  writeAllModelsCache({ entries: data.models, models: backwardCompatModels });

  // Short-circuit the proxy-server background warm.
  _warmPromise = Promise.resolve();

  return { kind: "refreshed", modelCount: data.models.length };
}

/** Fire-and-forget warm. Failures fall through to the disk-read fallback. */
export async function warmCatalog(): Promise<void> {
  if (!_warmPromise) {
    _warmPromise = refreshCatalog(8000).then(() => undefined);
  }
  await _warmPromise;
}

/**
 * Wait for the catalog to be usable, bounded by `timeoutMs`. Never throws —
 * on timeout the caller proceeds with whatever the disk cache holds.
 */
export async function ensureCatalogReady(timeoutMs = 5000): Promise<void> {
  if (isCatalogWarm()) return;

  if (!_warmPromise) {
    _warmPromise = refreshCatalog(8000).then(() => undefined);
  }

  await Promise.race([
    _warmPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
