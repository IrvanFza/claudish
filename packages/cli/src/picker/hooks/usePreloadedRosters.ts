/**
 * usePreloadedRosters — every ready provider's LIVE roster, fetched concurrently
 * and merged into the flat list as each one lands.
 *
 * THE DEFECT THIS FIXES WAS REPORTED FROM A LIVE RUN. The owner typed `gemini`
 * into the filter and got eleven rows, every one of them `or@`. His words: *"why i
 * search gemini i see only open router models, no models from antigravity and
 * devin and subscriptions"*. The flat list was built from the cloud catalog alone,
 * so the thirteen providers that serve their roster through live discovery —
 * Antigravity, Devin, both Qwen consoles, Grok Build, OpenCode Zen Go, the coding
 * plans, Ollama and LM Studio — contributed NOTHING until the user had already
 * guessed to scope to them. MEASURED on this machine: eight of those thirteen have
 * zero catalog entries by design, so they were entirely absent from a list whose
 * title said `437 models`.
 *
 * IT MATTERS MORE THAN A MISSING ROW. The one genuinely useful thing about a
 * cross-provider list is seeing the same model on several routes at different
 * prices — `gpt-6-astra` on `or@` at $30.00, on `oai@` at $30.00, on `cx@` as
 * `SUB`. The routes that were being hidden are the FLAT-RATE ones: Antigravity
 * serves gemini and claude models on a subscription that costs nothing at the
 * point of use. A user searching `gemini` was quoted $2.25/1M and never told he
 * already had it.
 *
 * THREE RULES KEEP IT FROM BECOMING THE FAN-OUT THAT WAS REJECTED:
 *
 * 1. **Concurrent, never serial.** One request per provider, all in flight at
 *    once, results merged in completion order.
 * 2. **No catalog leg.** `source.rosterRows` calls `preloadProviderRoster`, which
 *    does NOT run `loadModelsForPickerProvider` — that live `?provider=` query is
 *    the one measured at 10 018 ms for 22 concurrent callers. Prices come from the
 *    local served-by index instead.
 * 3. **Never blocks a paint.** The catalog rows are on screen before the first
 *    request settles; each roster is merged when it arrives and the header count
 *    moves. A picker that waited for the slowest provider would be trading one
 *    complaint for a worse one.
 *
 * READY PROVIDERS ONLY. An uncredentialled provider's roster request cannot
 * succeed — it would spend a round-trip to be told 401 — and its rows could not be
 * launched anyway. `usePickerProviders` has already answered which are ready, one
 * `setState` at a time, so this fires each provider's request the moment its own
 * probe settles rather than waiting for the whole sweep.
 *
 * A FAILURE IS COUNTED, NOT SWALLOWED. `failures` carries one entry per provider
 * whose roster could not be listed, and the caller renders the aggregate — `2
 * providers could not be listed · p` — because a per-provider banner is the wrong
 * shape for a state that is about the list as a whole. The full diagnostic still
 * goes to the post-teardown stderr write, exactly as the scoped path's does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { log } from "../../logger.js";
import type { ModelInfo } from "../../model-selector.js";
import type { PickerDataSource, PickerProviderChoice } from "../PickerDataSource.js";

export interface RosterPreloadState {
  /** Live rows per provider, added as each roster lands. */
  rowsByProvider: ReadonlyMap<string, ModelInfo[]>;
  /** Providers whose roster could not be listed, in the order they failed. */
  failures: readonly string[];
  /** Rosters settled so far. */
  done: number;
  /** Rosters that will be asked for. Grows as credential probes settle. */
  total: number;
  /** True while any request is open. */
  busy: boolean;
}

export function usePreloadedRosters(
  source: PickerDataSource,
  roster: PickerProviderChoice[],
  /** Providers whose credential probe came back true. */
  ready: ReadonlySet<string>,
  /** Called once per provider that fails, for the ONE write after teardown. */
  onFailure?: (provider: string, notice: readonly string[]) => void
): RosterPreloadState {
  const [rowsByProvider, setRows] = useState<Map<string, ModelInfo[]>>(new Map());
  const [failures, setFailures] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  /** Providers already asked. One request per provider per picker open. */
  const asked = useRef(new Set<string>());
  const startedAt = useRef<number | null>(null);
  // A ref, not a dependency: the callback identity must not re-trigger the
  // effect, and a stale closure would report a failure to a buffer nobody drains.
  const report = useRef(onFailure);
  report.current = onFailure;

  /**
   * ONE liveness flag for the whole mount, NOT one per effect run.
   *
   * The ready set is re-derived every render, so this effect re-runs often. A
   * `let live = true` inside it would be flipped false by the NEXT run's cleanup
   * while its own requests were still in flight — every roster started before the
   * last credential probe settled would land, find `live === false`, and merge
   * nothing. The bug is invisible in a test with instant probes and total on a
   * real machine, which is the worst combination there is.
   */
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  // The ready SET cannot be a dependency (a new Set every frame); its signature can.
  const signature = useMemo(() => [...ready].sort().join(","), [ready]);

  useEffect(() => {
    const wanted = roster.filter((r) => r.hasDiscovery && ready.has(r.value));
    const fresh = wanted.filter((r) => !asked.current.has(r.value));
    if (fresh.length === 0) return;

    for (const r of fresh) asked.current.add(r.value);
    if (startedAt.current === null) startedAt.current = Date.now();
    setTotal(asked.current.size);

    // CONCURRENT: every request starts here, in this tick. Nothing awaits the
    // previous one, and each merges itself when it settles.
    for (const choice of fresh) {
      void source.rosterRows(choice.value).then(
        (outcome) => {
          if (!alive.current) return;
          setDone((n) => n + 1);
          if (outcome.kind === "rows") {
            setRows((prev) => new Map(prev).set(choice.value, outcome.rows));
            return;
          }
          if (outcome.kind === "failed") {
            setFailures((prev) => (prev.includes(choice.value) ? prev : [...prev, choice.value]));
            report.current?.(choice.value, outcome.notice);
          }
        },
        // `preloadProviderRoster` never rejects by contract; a contract is not a
        // type, and an unhandled rejection behind a live renderer has nowhere to
        // surface. Count it settled so the meter cannot stall at 12/13 forever.
        (err: unknown) => {
          if (!alive.current) return;
          setDone((n) => n + 1);
          setFailures((prev) => (prev.includes(choice.value) ? prev : [...prev, choice.value]));
          log(`[picker] roster preload for ${choice.value} rejected: ${String(err)}`);
        }
      );
    }
    // The requests are abandoned on unmount, never awaited: React is unmounted
    // before the renderer is destroyed, so nothing can paint into a dead one.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the stable projection of `ready`; depending on the Set itself re-runs every frame
  }, [source, roster, signature, ready]);

  const busy = total > 0 && done < total;
  // ONE line, when the last roster lands, with the numbers the owner asked for.
  // It goes to the debug log rather than the terminal: the renderer owns the
  // terminal while the picker is up.
  const logged = useRef(false);
  if (!busy && total > 0 && !logged.current) {
    logged.current = true;
    const rows = [...rowsByProvider.values()].reduce((n, r) => n + r.length, 0);
    log(
      `[picker] preloaded ${total} live roster(s) concurrently in ${
        startedAt.current === null ? 0 : Date.now() - startedAt.current
      } ms: ${rows} row(s) merged, ${failures.length} provider(s) could not be listed`
    );
  }

  return { rowsByProvider, failures, done, total, busy };
}
