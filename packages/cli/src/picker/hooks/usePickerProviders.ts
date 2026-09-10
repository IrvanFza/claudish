/**
 * usePickerProviders — the rail's roster, and the credential probe that fills it in.
 *
 * FRAME ONE IS NEVER BLANK, STRUCTURALLY. The roster comes from
 * `source.providerRoster()`, which is synchronous and derived from the provider
 * definitions, so the first render already lists every pickable provider with a `◌`
 * pending marker. The probe then flips each row to `●` or `○` as it settles. That
 * incremental fill IS the loading affordance for the ~30 `credentials.isAvailable`
 * calls — each of which may read env, config, an OAuth file, the macOS Keychain and
 * the 1Password SDK — and it is why `probeCredentials` is an AsyncIterable rather
 * than one awaited map: a map would hold every row hostage to the slowest handshake.
 *
 * MEMBERSHIP IN THE STEADY STATE IS IDENTICAL TO TODAY'S. The old picker filtered
 * unready providers out entirely (`getProviderChoices`), which made the first frame
 * wait for every probe. This mounts the UNFILTERED roster and then collapses the
 * unready ones into one dim, non-selectable summary row — so the rail does not
 * lengthen, no row can be picked that would fail later at `validateApiKeysForModels`,
 * and the absence is EXPLAINED rather than silent, which is the principle the rest of
 * the feature is built on.
 *
 * ONE FAN-OUT PER MOUNT, never per render: `selectModel` hoisted this call for
 * exactly that reason (its comment at `model-selector.ts:660-668`), and the profile
 * wizard's four-times-over probe is the counter-example this must not become.
 */

import { useEffect, useMemo, useState } from "react";
import type { PickerDataSource, RailChoice } from "../PickerDataSource.js";
import type { Readiness } from "../rows.js";

export interface RailRow extends RailChoice {
  readiness: Readiness;
}

export interface PickerProvidersState {
  /** Every pickable provider, in picker order, readiness included. */
  rows: RailRow[];
  /** Ready providers — the selectable ones. */
  ready: RailRow[];
  /** Settled-but-unready providers, collapsed behind one summary row. */
  missing: RailRow[];
  /** Probes settled so far. */
  done: number;
  /** Probes in total — known synchronously, which is what makes this real progress. */
  total: number;
  /** True until the last probe settles. */
  probing: boolean;
  /** Built-in local providers not enabled in config (§3.9) — a hint, not a row. */
  notEnabledLocal: string[];
}

export function usePickerProviders(source: PickerDataSource): PickerProvidersState {
  // The roster is resolved ONCE. `providerRoster()` is pure and derived, so calling
  // it per render would be correct and still wrong: the rows would be new objects
  // every frame and every memo downstream would miss.
  const roster = useMemo(() => source.providerRoster(), [source]);
  const notEnabledLocal = useMemo(() => source.notEnabledLocalProviders(), [source]);
  const [readiness, setReadiness] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      for await (const [name, ok] of source.probeCredentials(roster.map((r) => r.value))) {
        if (!live) return;
        // One `setState` per settled probe, deliberately: ~30 of them over a second
        // or two is nowhere near the frame rate at which the mutable-store-plus-poll
        // pattern becomes necessary, and a batched update would lose the incremental
        // fill that is the whole affordance.
        setReadiness((prev) => ({ ...prev, [name]: ok }));
      }
    })();
    return () => {
      // The probes are abandoned, not awaited. Nothing writes to a destroyed
      // renderer because React is unmounted before the renderer is destroyed, and
      // `isAvailable` has no side effect worth draining.
      live = false;
    };
  }, [source, roster]);

  const rows: RailRow[] = roster.map((r) => {
    const settled = readiness[r.value];
    return { ...r, readiness: settled === undefined ? "pending" : settled ? "ready" : "missing" };
  });
  const done = Object.keys(readiness).length;

  return {
    rows,
    ready: rows.filter((r) => r.readiness === "ready"),
    missing: rows.filter((r) => r.readiness === "missing"),
    done,
    total: roster.length,
    probing: done < roster.length,
    notEnabledLocal,
  };
}
