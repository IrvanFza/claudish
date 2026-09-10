/**
 * useProviderDiscovery — one settled outcome per discovery provider, and the elapsed
 * clock the in-flight indicator is drawn from.
 *
 * NO REJECTION BRANCH, BY CONTRACT. `discoverProviderRoster` never rejects — every
 * throw inside it is mapped to `failed{kind:"unreachable"}` — and
 * `buildDiscoveredModelOutcome` inherits that guarantee through `Promise.allSettled`.
 * That contract is what lets this hook be small; it is also pinned by a unit test
 * with a fetcher registered to throw, because a contract is not a type. The `catch`
 * below exists anyway, for the one failure a contract cannot cover: a data source
 * that is not the production one.
 *
 * THE ELAPSED CLOCK IS NOT STATE. `startedAt` is recorded once per request and the
 * view re-renders from `useAnimationFrame`'s 100 ms tick, computing
 * `Date.now() - startedAt` at render time. Storing elapsed milliseconds in state
 * would be a `setState` per tick for a number nothing else reads.
 *
 * EVERY FAILURE IS REPORTED, NOT JUST THE LAST. `onFailure` fires once per provider
 * whose outcome lands `failed`, in the order they occurred, because that is what the
 * behaviour being preserved does: today each failed selection writes its diagnostic
 * to stderr immediately, so a session that tried two failing providers leaves two
 * lines in the scrollback. Writing one after teardown would be a quiet narrowing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PickerDiscoveryOutcome } from "../../model-selector.js";
import type { PickerDataSource } from "../PickerDataSource.js";

export interface DiscoveryState {
  /** The selected provider's outcome, or `null` while it is in flight. */
  outcome: PickerDiscoveryOutcome | null;
  /** True while a request for the selected provider is open. */
  busy: boolean;
  /** `Date.now()` when the open request started, for the elapsed figure. */
  startedAt: number | null;
  /** Every outcome seen this session, so a revisit costs nothing. */
  seen: ReadonlyMap<string, PickerDiscoveryOutcome>;
}

export function useProviderDiscovery(
  source: PickerDataSource,
  provider: string | null,
  /** False unless this provider declares `modelDiscovery`. */
  wanted: boolean,
  /** Called once per provider that lands `failed`, for the post-teardown write. */
  onFailure?: (provider: string, notice: readonly string[]) => void
): DiscoveryState {
  const [outcomes, setOutcomes] = useState<Map<string, PickerDiscoveryOutcome>>(new Map());
  const [started, setStarted] = useState<Record<string, number>>({});
  const inflight = useRef(new Map<string, Promise<PickerDiscoveryOutcome>>());
  // A ref, not state: the callback identity must not re-trigger the effect, and a
  // stale closure here would report a failure to a buffer nobody drains.
  const report = useRef(onFailure);
  report.current = onFailure;
  const reported = useRef(new Set<string>());

  const load = useCallback(
    (name: string): void => {
      const cache = inflight.current;
      if (cache.has(name)) return;
      const request = source.discoverRoster(name);
      cache.set(name, request);
      setStarted((prev) => (prev[name] === undefined ? { ...prev, [name]: Date.now() } : prev));
      void request.then(
        (outcome) => {
          setOutcomes((prev) => new Map(prev).set(name, outcome));
          if (outcome.kind === "failed" && !reported.current.has(name)) {
            reported.current.add(name);
            report.current?.(name, outcome.notice);
          }
        },
        (err: unknown) => {
          cache.delete(name);
          setOutcomes((prev) =>
            new Map(prev).set(name, {
              kind: "failed",
              failure: { kind: "unreachable", provider: name, detail: String(err) },
              notice: [`${name} could not list its models: ${String(err)}`],
              fallbackRows: [],
            })
          );
        }
      );
    },
    [source]
  );

  useEffect(() => {
    if (provider === null || !wanted) return;
    load(provider);
  }, [provider, wanted, load]);

  const outcome = provider !== null && wanted ? (outcomes.get(provider) ?? null) : null;
  const busy = provider !== null && wanted && outcome === null;
  return {
    outcome,
    busy,
    startedAt: busy && provider !== null ? (started[provider] ?? null) : null,
    seen: outcomes,
  };
}
