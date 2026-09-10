/**
 * usePickerModels — ONE flat cross-provider list, and the per-provider counts the
 * provider dialog prints.
 *
 * THIS HOOK IS THE FIX FOR "SUPER UNCLEAR WHAT IS HAPPENING". The build it
 * replaces asked the user which PROVIDER before it would answer which MODEL, and
 * put a cursor in each of the two lists with only a border colour to say which one
 * the arrow keys drove. One list has one cursor. So the provider stops being a
 * navigation step and becomes a COLUMN — the routing shortcut, which is also the
 * string the user could have typed on argv.
 *
 * IT IS AFFORDABLE BECAUSE `servedModels` IS SYNCHRONOUS. The obvious
 * implementation — `loadModelsForPickerProvider` per provider — was MEASURED at
 * 10 s for 22 concurrent owner-slug queries, every one of which aborted on its
 * shared timeout and returned zero rows. That is not a slow picker; it is the
 * picker saying "this provider has no models", which is the exact complaint this
 * feature exists to remove. `PickerDataSource.servedModels` reads the catalog's
 * local served-by index instead, in about a millisecond, and
 * `model-catalog.ts:servedByVendor` records why that index is the same authority
 * rather than a second one.
 *
 * ONLY CREDENTIALLED PROVIDERS CONTRIBUTE ROWS, and the absence is EXPLAINED
 * rather than silent: the count in the dialog title reads `24/31 providers`, and
 * `p` lists all 31 with the reason each unready one is not there. A row the user
 * cannot launch is worse than a row that is missing — it fails at
 * `validateApiKeysForModels`, after the picker has closed.
 *
 * ONE `servedModels` CALL PER PROVIDER PER OPEN, held in a ref. Readiness arrives
 * as ~31 separate `setState`s (that incremental fill IS the loading affordance),
 * so a memo that re-derived every provider's rows on each of them would read the
 * slim cache ~500 times.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ModelInfo,
  buildExplicitModelSpec,
  compareByReleaseDateDesc,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
} from "../../model-selector.js";
import type { PickerDataSource, PickerProviderChoice } from "../PickerDataSource.js";
import { priceLabel } from "../rows.js";

/** One choice in the flat list: a model AND the provider that would serve it. */
export interface PickerRow {
  /** `ProviderDefinition.name` — what every source call is keyed by. */
  provider: string;
  /** The routing shortcut printed in the provider column: `or@`, `kc@`. */
  shortcut: string;
  /** Exactly what Enter returns. */
  spec: string;
  /** Already reshaped by `priceLabel` — `$2.25`, `SUB`, `FREE`, `local`. */
  price: string;
  model: ModelInfo;
}

/** The shape `ProbeState` established (`hooks/useRouteProbe.ts:28-33`) — copied, not reinvented. */
export type LoadPhase = "idle" | "loading" | "ready";

export interface PickerModelsState {
  /** Every (provider, model) pair a credentialled provider serves, newest first. */
  rows: PickerRow[];
  /** Rows per provider — the `p` dialog's count column. */
  counts: ReadonlyMap<string, number>;
  /** Whether the cross-vendor catalog warm has settled. */
  phase: LoadPhase;
}

/**
 * One model under one provider, as a row.
 *
 * EXPORTED BECAUSE THERE ARE TWO LISTS AND THEY MUST NOT DIFFER. The flat list is
 * built from the served-by index; a scoped list may instead be a live discovery
 * roster or its catalog fallback. If those paths built rows differently, a fallback
 * list would be distinguishable by ACCIDENT — a different price string, a different
 * spec spelling — rather than by the three deliberate provenance encodings, and a
 * reader would learn to read the accident instead of the mark.
 */
export function toPickerRow(choice: PickerProviderChoice, model: ModelInfo): PickerRow {
  return {
    provider: choice.value,
    shortcut: choice.shortcut,
    // The SAME spec builder the classic path uses, with the provider's own
    // externalId — `or@openai/gpt-5`, not the catalog's bare key. Every row is
    // provider-scoped, so no bare Claude name can leave this picker.
    spec: buildExplicitModelSpec(choice.value, resolveProviderExternalId(choice.value, model)),
    price: priceLabel(resolveProviderDisplayPrice(choice.value, model), choice.billing),
    model,
  };
}

export function usePickerModels(
  source: PickerDataSource,
  roster: PickerProviderChoice[],
  /** Providers whose credential probe came back true. */
  ready: ReadonlySet<string>
): PickerModelsState {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const cache = useRef(new Map<string, PickerRow[]>());

  useEffect(() => {
    let live = true;
    void (async () => {
      // Bounded, and documented never to throw. A cold cache is the only case
      // this actually waits for; a warm one returns on the first line.
      await source.ensureCatalog();
      if (!live) return;
      // The warm may have REPLACED the slim cache on disk, so anything derived
      // from it before now is stale by construction.
      cache.current.clear();
      setPhase("ready");
    })();
    return () => {
      live = false;
    };
  }, [source]);

  // The ready set is re-derived per render by `usePickerProviders`, so it cannot
  // be a memo dependency directly — a new Set every frame would rebuild the whole
  // list every frame. Its SIGNATURE can.
  const signature = useMemo(() => [...ready].sort().join(","), [ready]);

  return useMemo(() => {
    if (phase !== "ready") return { rows: [], counts: new Map(), phase };
    const counts = new Map<string, number>();
    const rows: PickerRow[] = [];
    for (const choice of roster) {
      let cached = cache.current.get(choice.value);
      if (cached === undefined) {
        cached = source.servedModels(choice.value).map((m) => toPickerRow(choice, m));
        cache.current.set(choice.value, cached);
      }
      // The COUNT is what the catalog serves, credentials or not — the provider
      // dialog shows it beside `needs OPENAI_API_KEY`, and "0 models" there would
      // read as "this provider has nothing" rather than "you have no key".
      counts.set(choice.value, cached.length);
      if (ready.has(choice.value)) rows.push(...cached);
    }
    // Newest first, across providers. The same comparator the classic picker
    // uses, so two lists of the same models cannot disagree about their order.
    rows.sort((a, b) => compareByReleaseDateDesc(a.model, b.model));
    return { rows, counts, phase };
    // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the stable projection of `ready`; depending on the Set itself rebuilds every frame
  }, [source, roster, phase, signature, ready]);
}
