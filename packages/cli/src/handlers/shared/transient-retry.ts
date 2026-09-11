/**
 * Tier 1 of connection recovery: re-issue a failed operation on a shared
 * episode clock, inside the request that failed, before a single byte has been
 * flushed.
 *
 * WHERE THIS LIVES AND WHY IT IS NOT A TRANSPORT WRAPPER. `enqueueRequest` and
 * `getRequestInit` are OPTIONAL on the transport interface, so a wrapper down
 * there would miss every transport implementing neither; only the handler can
 * choose the final status; and the byte-stable re-issue closure already exists
 * at the handler level, built once from the serialized body. The separating
 * rule is structural rather than stylistic: **the transports handle the
 * has-a-Response case (429 loops, model fallback); this file handles the
 * no-Response case.** They cannot overlap, because a connect failure never
 * produces a Response.
 *
 * The existing per-transport 429 loops deliberately do NOT converge here. Their
 * budgets are measured and provider-specific — one is sized at ~3 s so a config
 * TUI probe deadline is not blown, another drives a model-fallback chain off
 * observed refusal latencies — and merging them is the textbook wrong
 * abstraction.
 *
 * NOTHING IN THIS FILE RUNS ON A HEALTHY REQUEST. Every construct is built from
 * inside a `catch`, after classification has already returned non-null. That is
 * enforced by placement, not by a flag.
 */

import type { Context } from "hono";
import { log } from "../../logger.js";
import { recoveryClock } from "../../recovery/clock.js";
import { type EpisodeHandle, joinEpisode } from "../../recovery/coordinator.js";
import { logDeadlineIfShortened, resolveTier1DeadlineMs } from "../../recovery/settings.js";
import {
  type ConnectionErrorKind,
  buildConnectionErrorMessage,
  classifyConnectionError,
} from "./connection-error.js";

export { EPISODE_GRACE_MS } from "../../recovery/coordinator.js";

/**
 * Connection backoff. Deliberately SEPARATE from `STREAM_RETRY_DELAYS_MS`:
 * those three values are load-bearing for the stream sniffer's budget and for a
 * duration quoted verbatim in a user-facing exhaustion message, and merging the
 * two schedules would couple unrelated budgets to each other.
 *
 * The last element REPEATS — the schedule is 5/10/30/60/60/… and the DEADLINE,
 * not the array, is what ends it. That inverts `STREAM_RETRY_DELAYS_MS`, where
 * the array running out IS the budget.
 */
export const CONNECTION_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000] as const;

/** The gap before the attempt at `ladderIndex`. Clamped to the last element. */
export function connectionRetryDelayMs(ladderIndex: number): number {
  const i = Math.max(0, Math.min(ladderIndex, CONNECTION_RETRY_DELAYS_MS.length - 1));
  return CONNECTION_RETRY_DELAYS_MS[i] as number;
}

/**
 * Ceiling on ONE retry attempt's connect-and-headers phase. Disarmed the
 * instant `fetch()` resolves, so it can never cut a live response body.
 *
 * NOT 75 000, and the 4 ms this avoids is the whole reason. macOS's own TCP
 * connect timeout was measured at **75.004 s** against an unrouted address, so
 * a 75 000 ms cap races the operating system by four milliseconds and is
 * decided differently on different runs — which makes every assertion keyed on
 * "the attempt ended at the clamp" flaky by construction. 45 s clears the
 * collision by 30 seconds, always wins the race, and keeps the ladder
 * responsive: at the default deadline it still leaves room for the full
 * 5/10/30/60/60 sequence, because a clamped attempt only costs its own wall
 * clock when the fault is slow, and a slow fault is exactly the case where
 * waiting out 75 s per attempt would spend the entire budget on two of them.
 */
export const PER_ATTEMPT_CONNECT_CAP_MS = 45_000;

/** Below this much budget remaining, do not start another attempt. */
export const MIN_ATTEMPT_SLOT_MS = 3_000;

/**
 * The deadline the AUTH-path catches use, deliberately earlier than the fetch
 * catch's.
 *
 * Both sit in the same request and share one `deadlineAt`. If auth recovery
 * consumes the whole of it and then SUCCEEDS, the flow proceeds to the primary
 * fetch — which is byte-identical to today's expression and therefore
 * unclamped — and a maximal connect hang lands the response write a full
 * connect timeout past the deadline. Reserving the unclamped attempt's own
 * worst case out of the auth path's budget restores the margin the derivation
 * assumed, and costs one function rather than an edit to the healthy path.
 */
export function refreshDeadlineAt(deadlineAt: number): number {
  return deadlineAt - PER_ATTEMPT_CONNECT_CAP_MS;
}

/**
 * PROCESS ms at which the INBOUND request arrived — not at which this candidate
 * started.
 *
 * `handle()` mints its own `startTime` and the fallback chain calls `handle()`
 * once PER CANDIDATE, so deriving the deadline from that value gave every
 * candidate in a chain a fresh full budget and the chain as a whole could hold
 * a socket for candidates × deadline. A `WeakMap` keyed on the inbound
 * `Request` needs no route change and no context mutation (the fallback
 * handler's invariant forbids `c.set` no less than `c.header`), collects
 * itself, and is inherited by every later candidate because they share
 * `c.req.raw`.
 *
 * The residual is real and wanted: a candidate that recovers late and then
 * returns a retryable status leaves candidate 2 with only the remaining budget
 * rather than a fresh one. That is the point.
 */
const INBOUND_START = new WeakMap<Request, number>();

export function inboundStartedAtPerf(c: Context): number {
  const key = c.req?.raw as Request | undefined;
  if (!key) return recoveryClock().now();
  const seen = INBOUND_START.get(key);
  if (seen !== undefined) return seen;
  const t = recoveryClock().now();
  INBOUND_START.set(key, t);
  return t;
}

/** The absolute tier-1 deadline for this inbound request, PROCESS ms. */
export function tier1DeadlineAt(c: Context): number {
  const budget = resolveTier1DeadlineMs();
  logDeadlineIfShortened(budget);
  return inboundStartedAtPerf(c) + budget;
}

export interface ConnectionErrorInfo {
  kind: ConnectionErrorKind;
  code: string;
}

/**
 * Add an abort signal to an already-built fetch init WITHOUT discarding the
 * transport's own.
 *
 * The order is the entire point. The handler's fetch expressions spread the
 * transport's `getRequestInit()` **last**, so a signal written before that
 * spread is silently overwritten — and for a local provider the thing doing the
 * overwriting is a ten-minute `AbortSignal.timeout`. Compose rather than
 * replace: the per-attempt clamp then bounds the attempt while the transport's
 * own ceiling still applies, which is what both of them were for.
 */
export function mergeSignalIntoInit(
  init: Record<string, unknown>,
  signal?: AbortSignal
): RequestInit {
  if (!signal) return init as RequestInit;
  const own = init.signal as AbortSignal | undefined;
  return { ...init, signal: own ? AbortSignal.any([own, signal]) : signal } as RequestInit;
}

export interface ConnectionRetryContext {
  providerName: string;
  providerDisplayName: string;
  /**
   * The endpoint the FAILING call was made to. On the inference path this is
   * the model endpoint; on an auth path the model endpoint may not be computed
   * yet and a refresh can contact several auth/setup/catalog hosts, so it is
   * read from the error. Naming the wrong host in the message is a real defect,
   * not a cosmetic one.
   */
  resolveEndpoint: (err: unknown) => string;
  /** Absolute deadline for THIS request, PROCESS ms. */
  deadlineAt: number;
  /** `c.req.raw.signal` — the client going away. */
  signal: AbortSignal;
}

/**
 * The counters every outcome carries, in TWO scopes, because the two answer
 * different questions and conflating them mis-reports both.
 *
 * EPISODE scope (`attempts`, `recoveryMs`) is what the human reads: one banner
 * saying "attempt 9 · 4m 12s in recovery" across every waiter and both tiers,
 * which is the honest account of the OUTAGE.
 *
 * REQUEST scope (`requestRetries`, `requestRecoveryMs`) is what stats record,
 * because a stats event is one-per-request by definition. The episode figures
 * cannot stand in for these: N concurrent requests share one episode, so each
 * would report the sum of all of them, and a tier-2 re-entry inherits counters
 * from a request that already recorded its own — so summing `retry_attempts`
 * over an outage would multiply it by the number of waiters and again by the
 * number of re-entries.
 */
interface ConnectionRetryTally {
  /** Episode-scoped: every attempt by every waiter, across both tiers. */
  attempts: number;
  /** Episode-scoped: ms since the episode opened. */
  recoveryMs: number;
  /**
   * THIS request's RE-ISSUES — the operation run again, not counting the
   * failure that brought us here. 0 is meaningful and reachable: an episode
   * existed and this request added nothing to it because its own budget was
   * already spent. That is what `retry_attempts` records.
   */
  requestRetries: number;
  /** THIS request's own ms inside the ladder — `recovery_ms`. */
  requestRecoveryMs: number;
  /** Which tier-2 re-entry this is. 0 = the request that opened the episode. */
  clientRetry: number;
  episodeId: string;
}

export type ConnectionRetryResult<T> =
  | ({ kind: "ok"; value: T } & ConnectionRetryTally)
  /**
   * NOTE the absence of a `uiLeased` field. Whether a surface is painting this
   * episode is LIVE and must be read at the moment the status is chosen; a
   * boolean on this result IS a cache of it, and by the time a caller
   * destructures the result it can already be stale.
   */
  | ({
      kind: "exhausted";
      conn: ConnectionErrorInfo;
      error: unknown;
      endpoint: string;
    } & ConnectionRetryTally)
  | ({
      kind: "gave_up";
      conn: ConnectionErrorInfo;
      error: unknown;
      endpoint: string;
    } & ConnectionRetryTally)
  | ({ kind: "client_gone" } & ConnectionRetryTally)
  /** A later attempt threw something that is NOT a connection error. Not ours. */
  | ({ kind: "threw"; error: unknown } & ConnectionRetryTally);

/** True when the rejection is the inbound client going away, not our own clamp. */
function isClientAbort(signal: AbortSignal, err: unknown): boolean {
  if (signal.aborted) return true;
  return (err as { name?: string })?.name === "AbortError";
}

/**
 * Re-issue `op` on a classified connection error, on the shared episode clock.
 *
 * `op` TAKES the signal rather than closing over one. That is what lets a
 * single contract cover both the fetch path and the auth path: the per-attempt
 * clamp is built here, merged with the client signal here, and handed in, so
 * the clamp bounds the OPERATION rather than only the `fetch` buried inside it.
 *
 * Classification runs on EVERY attempt, not just the first. A retry that throws
 * an auth failure, a transport bug or a programming error must not be
 * relabelled as the previous network error — that would quietly widen recovery
 * past the classified set. Such a result comes back as `threw` and the caller
 * rethrows it exactly as it rethrows an unclassifiable first failure today.
 */
export async function withConnectionRetry<T>(
  op: (signal: AbortSignal) => Promise<T>,
  first: unknown,
  ctx: ConnectionRetryContext
): Promise<ConnectionRetryResult<T>> {
  const clock = recoveryClock();
  // PROCESS ms at which THIS request entered the ladder. `recovery_ms` is
  // measured from here rather than from the episode, because an episode can be
  // older than the request that joined it — a tier-2 re-entry inherits one —
  // and a `recovery_ms` larger than the same record's `latency_ms` is a figure
  // no reader can make sense of.
  const enteredAtPerf = clock.now();
  let requestRetries = 0;

  const firstConn = classifyConnectionError(first);
  if (!firstConn) {
    // The caller is contractually required to classify before calling. Being
    // defensive here costs nothing and keeps a future caller's mistake from
    // silently widening what "transient" means.
    return {
      kind: "threw",
      error: first,
      attempts: 0,
      recoveryMs: 0,
      requestRetries: 0,
      requestRecoveryMs: 0,
      clientRetry: 0,
      episodeId: "",
    };
  }

  let conn: ConnectionErrorInfo = firstConn;
  let error: unknown = first;
  let endpoint = ctx.resolveEndpoint(first);

  const handle: EpisodeHandle = joinEpisode({
    providerName: ctx.providerName,
    providerDisplayName: ctx.providerDisplayName,
    endpoint,
    kind: conn.kind,
    code: conn.code,
    reason: buildConnectionErrorMessage(conn.kind, ctx.providerDisplayName, endpoint),
    deadlineAt: ctx.deadlineAt,
  });

  /**
   * The counters, snapshotted at the instant an outcome is returned. Every
   * `return` in this function goes through it, so a new counter is added in one
   * place and cannot be forgotten on one arm — which is how five hand-written
   * copies of the same four fields drift.
   */
  const tally = () => ({
    attempts: handle.attempts(),
    recoveryMs: handle.recoveryMs(),
    requestRetries,
    requestRecoveryMs: Math.round(clock.now() - enteredAtPerf),
    clientRetry: handle.clientRetries(),
    episodeId: handle.episodeId,
  });

  try {
    handle.recordAttemptResult(conn.code, false);

    for (;;) {
      if (ctx.signal.aborted) {
        return { kind: "client_gone", ...tally() };
      }

      const delay = connectionRetryDelayMs(handle.ladderIndex());
      const now = clock.now();
      // The check bounds the ATTEMPT THAT FOLLOWS the sleep, not just the
      // sleep. Bounding only the sleep is how a budget stops being a ceiling.
      if (now + delay + MIN_ATTEMPT_SLOT_MS > ctx.deadlineAt) {
        handle.handoff();
        return { kind: "exhausted", conn, error, endpoint, ...tally() };
      }

      let waited: { kind: "attempt" } | { kind: "gave_up" };
      try {
        waited = await handle.waitForNextAttempt(ctx.signal, delay);
      } catch (err) {
        if (isClientAbort(ctx.signal, err)) {
          log(`[Recovery] client gone during wait (episode ${handle.episodeId})`);
          return { kind: "client_gone", ...tally() };
        }
        throw err;
      }

      if (waited.kind === "gave_up") {
        return { kind: "gave_up", conn, error, endpoint, ...tally() };
      }

      // Per-attempt clamp. Cleared the moment the operation settles, so it can
      // only ever bound connect-and-headers.
      const attemptAc = new AbortController();
      const remaining = ctx.deadlineAt - clock.now();
      const clampMs = Math.max(
        MIN_ATTEMPT_SLOT_MS,
        Math.min(PER_ATTEMPT_CONNECT_CAP_MS, remaining)
      );
      const clampTimer = clock.setTimeout(
        () => attemptAc.abort(new DOMException("attempt cap", "TimeoutError")),
        clampMs
      );
      const merged = AbortSignal.any([ctx.signal, attemptAc.signal]);

      try {
        requestRetries++;
        const value = await op(merged);
        handle.recordAttemptResult("ok", true);
        log(
          `[Recovery] ${ctx.providerDisplayName} recovered after ${handle.attempts()} attempts ` +
            `in ${handle.recoveryMs()}ms (episode ${handle.episodeId})`
        );
        return { kind: "ok", value, ...tally() };
      } catch (err) {
        if (isClientAbort(ctx.signal, err)) {
          log(`[Recovery] client gone during attempt (episode ${handle.episodeId})`);
          return { kind: "client_gone", ...tally() };
        }
        // Re-classify EVERY attempt. Our own clamp lands here as a
        // `TimeoutError`, which classification now recognises for the same
        // reason a hung upstream does: both are a failure to get a response
        // out of a host we could not reach in time.
        const next = classifyConnectionError(err);
        if (!next) {
          return { kind: "threw", error: err, ...tally() };
        }
        conn = next;
        error = err;
        endpoint = ctx.resolveEndpoint(err) || endpoint;
        handle.recordAttemptResult(next.code, false);
      } finally {
        clock.clearTimeout(clampTimer);
      }
    }
  } finally {
    // Unconditional. A waiter that never leaves is the subscribe-without-
    // unsubscribe leak this design named as its own most likely failure.
    handle.leave();
  }
}
