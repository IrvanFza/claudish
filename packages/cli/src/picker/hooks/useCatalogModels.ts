/**
 * useCatalogModels — the cross-vendor catalog (A2) and the per-provider vendor list
 * (A12), with one promise memo between them.
 *
 * THE MEMO IS PORTED, NOT INVENTED: `selectModel` keeps a `remoteQueryCache` of
 * `Promise<ModelInfo[]>` keyed by query (`model-selector.ts:693-714`), so a provider
 * revisited during one picker session costs nothing. Caching the PROMISE rather than
 * the result is what makes two rapid arrow-key presses share one request instead of
 * racing two.
 *
 * THE PICKER STAYS USABLE IF THE CATALOG NEVER LANDS (edge case 8). The rail derives
 * from provider definitions, not from the catalog, so provider selection, every
 * discovery provider, the local/user-deployed providers and the custom-spec hatch all
 * work with a dead catalog. What degrades is exactly what the catalog supplies: the
 * vendor lists for non-discovery providers, which then show a `failed` notice instead
 * of rows. No path reaches a blank frame.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../model-selector.js";
import type { CatalogLoad, PickerDataSource } from "../PickerDataSource.js";

/** The shape `ProbeState` established (`hooks/useRouteProbe.ts:28-33`) — copied, not reinvented. */
export type LoadPhase = "idle" | "loading" | "ready" | "failed";

export interface CatalogState {
  phase: LoadPhase;
  /** Recommended ids, lower-cased — the corpus behind a row's `REC` marker. */
  recommended: Set<string>;
  /** How many models the cross-vendor load returned. A count, not a verdict. */
  size: number;
}

export interface ProviderListState {
  phase: LoadPhase;
  rows: ModelInfo[];
}

export interface CatalogModelsState {
  catalog: CatalogState;
  /** The selected provider's vendor list, when it is a provider that needs one. */
  list: ProviderListState;
}

const IDLE: ProviderListState = { phase: "idle", rows: [] };

export function useCatalogModels(
  source: PickerDataSource,
  provider: string | null,
  /** False for a discovery provider — its list comes from `useProviderDiscovery`. */
  wanted: boolean
): CatalogModelsState {
  const [catalog, setCatalog] = useState<CatalogState>({
    phase: "loading",
    recommended: new Set(),
    size: 0,
  });
  const [lists, setLists] = useState<Record<string, ProviderListState>>({});
  const inflight = useRef(new Map<string, Promise<ModelInfo[]>>());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const load: CatalogLoad = await source.loadCatalog();
        if (!live) return;
        setCatalog({
          phase: "ready",
          recommended: new Set(load.recommended.map((m) => m.id.toLowerCase())),
          size: load.top.length + load.recommended.length,
        });
      } catch {
        if (!live) return;
        // A failed catalog is a NOTICE, not an error: the picker still works, and
        // painting red for a degraded-but-functional screen teaches the user to
        // ignore red.
        setCatalog({ phase: "failed", recommended: new Set(), size: 0 });
      }
    })();
    return () => {
      live = false;
    };
  }, [source]);

  const load = useCallback(
    (name: string): void => {
      const cache = inflight.current;
      if (cache.has(name)) return;
      const request = source.catalogModels(name);
      cache.set(name, request);
      setLists((prev) => ({ ...prev, [name]: { phase: "loading", rows: [] } }));
      void request.then(
        (rows) => setLists((prev) => ({ ...prev, [name]: { phase: "ready", rows } })),
        () => {
          // Dropped from the memo so a retry is possible — a cached rejection would
          // make one transient network failure permanent for the whole session.
          cache.delete(name);
          setLists((prev) => ({ ...prev, [name]: { phase: "failed", rows: [] } }));
        }
      );
    },
    [source]
  );

  useEffect(() => {
    if (provider === null || !wanted) return;
    load(provider);
  }, [provider, wanted, load]);

  return {
    catalog,
    list: provider !== null && wanted ? (lists[provider] ?? IDLE) : IDLE,
  };
}
