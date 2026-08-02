/**
 * Last-resort context-window resolution against the cloud model catalog.
 *
 * The normal path is entirely local and free: the model dialect reads
 * `~/.claudish/all-models.json` (the Firebase slim catalog written at proxy
 * startup) via `lookupModel`, and some transports refine it per-provider. When
 * BOTH miss, the TokenTracker is seeded with 0, which it serializes as
 * `"context_window": "unknown"` — and the status line's numeric grep cannot
 * match a quoted string, so the whole context field silently disappears.
 *
 * A miss is real and common enough to be worth one network call:
 *   - the slim catalog is capped (`?catalog=slim&limit=1000`) and a
 *     just-released model can be absent from it while the full catalog knows it;
 *   - the cache is cold on a first run, or was written before the model existed.
 *
 * So on a miss we ask the SAME `queryModels` endpoint the rest of the CLI uses
 * (`getModelByIdFromFirebase`) for that one model id. Properties this must have,
 * and does:
 *   - **Non-blocking.** Fire-and-forget; the in-flight request is never awaited
 *     by the proxy path. The first turn writes `"unknown"` exactly as before and
 *     later turns pick up the real number.
 *   - **Fail-soft.** Network error, timeout, no match, or no `contextWindow` on
 *     the doc → the callback never fires and behaviour is identical to today.
 *   - **At most one call per model id per process.** Both hits and misses are
 *     memoized, so a model the catalog genuinely doesn't know costs one request
 *     for the whole session, not one per turn.
 *   - **Silent under test.** `bun test` sets NODE_ENV=test; unit tests that
 *     construct handlers for synthetic model ids must not reach the network.
 *     Injecting a fetcher via `setContextWindowFetcher` re-enables it.
 */

import { log } from "../../logger.js";
import { getModelByIdFromFirebase } from "../../model-loader.js";

/** Resolve a model id to a positive context window, or null when unknown. */
export type ContextWindowFetcher = (modelId: string) => Promise<number | null>;

const defaultFetcher: ContextWindowFetcher = async (modelId) => {
  const doc = await getModelByIdFromFirebase(modelId);
  const cw = doc?.contextWindow;
  return typeof cw === "number" && cw > 0 ? cw : null;
};

let fetcher: ContextWindowFetcher = defaultFetcher;
let fetcherInjected = false;

/**
 * Test seam: replace the catalog fetcher. Pass `null` to restore the real one.
 * Injecting also lifts the NODE_ENV=test network guard for this module.
 * @internal
 */
export function setContextWindowFetcher(fn: ContextWindowFetcher | null): void {
  fetcher = fn ?? defaultFetcher;
  fetcherInjected = fn !== null;
  resetContextWindowFallback();
}

/** Test seam: drop the per-model memo. @internal */
export function resetContextWindowFallback(): void {
  results.clear();
  inFlight.clear();
}

/** modelId → resolved window (number) or null when the catalog had nothing. */
const results = new Map<string, number | null>();
const inFlight = new Map<string, Promise<number | null>>();

function isDisabled(): boolean {
  if (process.env.CLAUDISH_NO_CATALOG_FALLBACK) return true;
  return process.env.NODE_ENV === "test" && !fetcherInjected;
}

/**
 * Resolve `modelId`'s context window from the cloud catalog, memoized.
 * Returns null when disabled, unknown, or the lookup failed. Never throws.
 */
export function resolveCatalogContextWindow(modelId: string): Promise<number | null> {
  if (!modelId || isDisabled()) return Promise.resolve(null);

  const cached = results.get(modelId);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = inFlight.get(modelId);
  if (pending) return pending;

  const promise = fetcher(modelId)
    .then((cw) => {
      const value = typeof cw === "number" && cw > 0 ? cw : null;
      results.set(modelId, value);
      return value;
    })
    .catch((err) => {
      // Negative-cache the failure too: a catalog that is unreachable now is
      // very likely unreachable for the rest of this session, and retrying on
      // every turn would put a network call on the hot path.
      results.set(modelId, null);
      log(`[ContextWindow] Catalog lookup failed for ${modelId}: ${err}`);
      return null;
    })
    .finally(() => {
      inFlight.delete(modelId);
    });

  inFlight.set(modelId, promise);
  return promise;
}

/**
 * Fire-and-forget variant: kick off the lookup and hand a positive result to
 * `apply`. Returns immediately. `apply` is never called on a miss.
 */
export function requestCatalogContextWindow(
  modelId: string,
  apply: (contextWindow: number) => void
): void {
  void resolveCatalogContextWindow(modelId).then((cw) => {
    if (cw === null) return;
    try {
      apply(cw);
      log(`[ContextWindow] Resolved ${modelId} = ${cw} tokens from the cloud catalog`);
    } catch (err) {
      log(`[ContextWindow] Failed to apply catalog window for ${modelId}: ${err}`);
    }
  });
}
