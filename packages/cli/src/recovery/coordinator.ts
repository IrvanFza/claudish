/**
 * The recovery coordinator — one EPISODE per unreachable target, shared by
 * every request that is failing against it.
 *
 * WHY A COORDINATOR AND NOT N INDEPENDENT LADDERS. Claude Code issues
 * concurrent requests: the main loop, the small title/summary model, and every
 * subagent. During an outage all of them fail within milliseconds of each
 * other. Give each its own ladder and you get N times the connect attempts
 * against a dead network, N unsynchronised countdowns, and no single number a
 * banner could ever show. With one episode there is one timer per target, every
 * parked request wakes together, and each still re-issues ITS OWN bytes —
 * which matters, because they are different requests and the body was
 * serialized per request.
 *
 * THREE LIFETIMES LIVE HERE AND THEY ARE NOT THE SAME OBJECT. This is the
 * distinction the design got wrong once and it is worth restating:
 *
 *   - the DEADLINE belongs to one inbound request. Its owner is the waiter.
 *     A waiter past its own deadline answers for itself and leaves.
 *   - the LADDER belongs to the episode. It ends when the last waiter leaves
 *     or an attempt succeeds — never because one waiter ran out of time.
 *   - the PANE LEASE belongs to a renderer painting this episode. Nothing in
 *     this file grants one yet; see `uiLeaseValid`.
 *
 * Letting one field mean all three is what made a four-waiter episode show
 * `waiters: 4` while exactly one of them was still being retried.
 */

import { randomUUID } from "node:crypto";
import type { ConnectionErrorKind } from "../handlers/shared/connection-error.js";
import { log } from "../logger.js";
import { recoveryClock } from "./clock.js";

export type RecoveryState = "attempting" | "waiting" | "recovered" | "handoff" | "abandoned";

export type RecoveryOutcome =
  | "recovered"
  | "handoff"
  | "client_gone"
  | "gave_up"
  | "grace_expired"
  | "shutdown";

/** What a parked waiter is woken with. An abort REJECTS instead. */
export type WaitOutcome = { kind: "attempt" } | { kind: "gave_up" };

/**
 * How long a handed-off episode stays open waiting for the client to come back.
 *
 * Sized against a measurement, not a guess: Claude Code's own backoff after a
 * 503 doubles off ~0.5 s and CAPS at ~38.4 s, so 120 s is 3.1× the worst
 * observed rejoin gap.
 *
 * Defined here rather than beside the backoff ladder because it is EPISODE
 * state, and keeping it here is what lets this module stay free of any import
 * from `transient-retry.ts` — the ladder's own delays are handed IN by the
 * caller for exactly the same reason. One-way dependency, no cycle.
 */
export const EPISODE_GRACE_MS = 120_000;

export interface EpisodeSeed {
  providerName: string;
  providerDisplayName: string;
  /** The endpoint that actually failed — the AUTH host on an auth-path failure. */
  endpoint: string;
  kind: ConnectionErrorKind;
  code: string | null;
  /** The same sentence the immediate 400 would have carried. */
  reason: string;
  /** This waiter's own absolute deadline, PROCESS ms. */
  deadlineAt: number;
}

interface Waiter {
  deadlineAt: number;
  tier: 1 | 2;
  leftByDeadline: boolean;
  /** Non-null exactly while this waiter is parked. */
  wake: ((outcome: WaitOutcome) => void) | null;
  fail: ((err: unknown) => void) | null;
  /** Detach the abort listener. Always called; an Observer leak is the named risk. */
  detach: (() => void) | null;
}

interface Episode {
  episodeId: string;
  key: string;
  providerDisplayName: string;
  endpoint: string;
  host: string;
  kind: ConnectionErrorKind;
  loopback: boolean;
  code: string | null;
  reason: string;
  state: RecoveryState;
  startedAtPerf: number;
  startedAtMs: number;
  /** Set when a pane is first ASKED for. Null for the whole of this phase. */
  paneRequestedAtPerf: number | null;
  ladderIndex: number;
  attempts: number;
  clientRetries: number;
  /** Ladder rounds, so N concurrent waiters advance the ladder ONCE per round. */
  round: number;
  advancedForRound: number;
  /** How many attempts in this episode have SUCCEEDED. */
  recoveredCount: number;
  lastOutcome: string;
  maxTier: 1 | 2;
  waiters: Set<Waiter>;
  attemptTimer: unknown | null;
  graceTimer: unknown | null;
  nextAttemptAtPerf: number | null;
  /** True once ANY waiter has left because IT ran out of budget. */
  anyLeftByDeadline: boolean;
  gaveUp: boolean;
}

const episodes = new Map<string, Episode>();
const byId = new Map<string, Episode>();

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** Exported for tests and for `shutdown()`; not part of the waiter contract. */
export function episodeCount(): number {
  return episodes.size;
}

/** Snapshot for logs and tests. Never mutate the returned object. */
export function describeEpisode(episodeId: string): Readonly<Record<string, unknown>> | null {
  const ep = byId.get(episodeId);
  if (!ep) return null;
  return {
    episodeId: ep.episodeId,
    key: ep.key,
    state: ep.state,
    ladderIndex: ep.ladderIndex,
    attempts: ep.attempts,
    round: ep.round,
    clientRetries: ep.clientRetries,
    waiters: ep.waiters.size,
    maxTier: ep.maxTier,
    lastOutcome: ep.lastOutcome,
    nextAttemptAtPerf: ep.nextAttemptAtPerf,
  };
}

/**
 * Is a renderer currently painting this episode?
 *
 * SEAM, deliberately inert in this phase. There is no socket, no pane and no
 * heartbeat yet, so the honest answer is false and the exhaustion arm keeps
 * answering today's 400. It is a function rather than a field because the
 * answer is LIVE — a lease read once and cached into a boolean is stale by the
 * time the status is chosen, which is the whole reason the previous design's
 * `uiAttached` latch was wrong.
 */
export function uiLeaseValid(_episodeId: string): boolean {
  return false;
}

export interface EpisodeHandle {
  readonly episodeId: string;
  readonly key: string;
  /** Total attempts this EPISODE has made, across every waiter and both tiers. */
  attempts(): number;
  /** Ms since the episode opened — not since this request started. */
  recoveryMs(): number;
  ladderIndex(): number;
  /** LIVE. Never cache the result. */
  uiLeaseValid(): boolean;
  /**
   * Park until the next attempt is due. Resolves `{kind:"attempt"}` on the
   * shared timer, `{kind:"gave_up"}` if the user asked to stop, and REJECTS
   * with the signal's abort reason if the client goes away.
   *
   * `delayMs` is the caller's reading of the ladder at `ladderIndex()`. It is
   * used only by the FIRST waiter to park in a round — the timer is shared, so
   * a second waiter joining an armed round inherits the gap already running
   * rather than restarting it. That is the whole point of one episode.
   */
  waitForNextAttempt(signal: AbortSignal, delayMs: number): Promise<WaitOutcome>;
  recordAttemptResult(outcome: string, ok: boolean): void;
  /**
   * THIS waiter ran out of budget. It does not move the episode: the episode
   * enters `handoff` only when the LAST waiter has left and at least one of
   * them left this way — a property of the SET, computed on the final leave.
   */
  handoff(): void;
  close(outcome: RecoveryOutcome): void;
  /** MUST be called in a `finally`. */
  leave(): void;
}

/**
 * Join the episode for this target, creating it if this is the first failure.
 *
 * A request arriving while an episode is in `handoff` REJOINS it — same
 * `episodeId`, same ladder position, `clientRetries` incremented — which is
 * what makes an in-request hold and a client-side retry read as one continuous
 * recovery rather than as two unrelated failures.
 */
export function joinEpisode(seed: EpisodeSeed): EpisodeHandle {
  const clock = recoveryClock();
  const host = hostOf(seed.endpoint);
  const key = `${seed.providerName}|${host}`;

  let ep = episodes.get(key);
  let tier: 1 | 2 = 1;

  if (ep && (ep.state === "recovered" || ep.state === "abandoned")) {
    episodes.delete(key);
    ep = undefined;
  }

  if (ep) {
    if (ep.state === "handoff") {
      // The client came back inside the grace window: same episode, same
      // ladder, one more client retry. The ladder does NOT reset — the target
      // has been down for the whole of it and starting again at 5 s would
      // hammer a dead host harder the longer the outage lasted.
      if (ep.graceTimer !== null) {
        clock.clearTimeout(ep.graceTimer);
        ep.graceTimer = null;
      }
      ep.clientRetries++;
      ep.state = "attempting";
      ep.maxTier = 2;
      tier = 2;
      log(
        `[Recovery] ${ep.providerDisplayName} rejoined episode ${ep.episodeId} ` +
          `(client retry ${ep.clientRetries}, ladder ${ep.ladderIndex}, attempts ${ep.attempts})`
      );
    }
  } else {
    const nowPerf = clock.now();
    ep = {
      episodeId: randomUUID(),
      key,
      providerDisplayName: seed.providerDisplayName,
      endpoint: seed.endpoint,
      host,
      kind: seed.kind,
      loopback: false,
      code: seed.code,
      reason: seed.reason,
      state: "attempting",
      startedAtPerf: nowPerf,
      startedAtMs: Date.now(),
      paneRequestedAtPerf: null,
      ladderIndex: 0,
      attempts: 0,
      clientRetries: 0,
      round: 0,
      // Round 0 counts as already advanced. The failure that OPENS an episode
      // is attempt 1, and attempt 1's gap is the ladder's FIRST rung (5 s) —
      // so recording it must not push the index to the second (10 s). Getting
      // this off by one turns the specified 5/10/30/60/60 into 10/30/60/60.
      advancedForRound: 0,
      recoveredCount: 0,
      lastOutcome: seed.code ?? "unknown",
      maxTier: 1,
      waiters: new Set(),
      attemptTimer: null,
      graceTimer: null,
      nextAttemptAtPerf: null,
      anyLeftByDeadline: false,
      gaveUp: false,
    };
    episodes.set(key, ep);
    byId.set(ep.episodeId, ep);
    log(
      `[Recovery] episode ${ep.episodeId} opened for ${ep.providerDisplayName} at ${ep.endpoint} ` +
        `(${ep.kind}/${ep.code ?? "?"})`
    );
  }

  const episode = ep;
  const waiter: Waiter = {
    deadlineAt: seed.deadlineAt,
    tier,
    leftByDeadline: false,
    wake: null,
    fail: null,
    detach: null,
  };
  episode.waiters.add(waiter);

  let left = false;

  return {
    episodeId: episode.episodeId,
    key: episode.key,
    attempts: () => episode.attempts,
    recoveryMs: () => Math.round(recoveryClock().now() - episode.startedAtPerf),
    ladderIndex: () => episode.ladderIndex,
    uiLeaseValid: () => uiLeaseValid(episode.episodeId),

    waitForNextAttempt(signal: AbortSignal, delayMs: number): Promise<WaitOutcome> {
      if (episode.gaveUp || episode.state === "abandoned") {
        return Promise.resolve({ kind: "gave_up" });
      }
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));

      return new Promise<WaitOutcome>((resolve, reject) => {
        const onAbort = () => {
          waiter.wake = null;
          waiter.fail = null;
          waiter.detach = null;
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new Error("aborted"));
        };
        // Unsubscribe is not optional. A parked waiter that leaves without
        // detaching keeps this closure — and the whole episode — alive for as
        // long as the client signal exists.
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
        waiter.wake = (outcome) => {
          waiter.detach?.();
          waiter.detach = null;
          waiter.wake = null;
          waiter.fail = null;
          resolve(outcome);
        };
        waiter.fail = (err) => {
          waiter.detach?.();
          waiter.detach = null;
          waiter.wake = null;
          waiter.fail = null;
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        armAttemptTimer(episode, delayMs);
      });
    },

    recordAttemptResult(outcome: string, ok: boolean): void {
      episode.attempts++;
      episode.lastOutcome = outcome;
      if (ok) {
        // The target just proved reachable. The episode is NOT torn down here:
        // other waiters may still be parked on the shared timer, and closing
        // it from under them clears that timer and strands them forever with
        // nothing to wake them. Wake them instead, and reset the ladder — a
        // host that answered a second ago has not earned a sixty-second gap.
        // The episode's own end is decided by the LAST waiter to leave.
        episode.recoveredCount++;
        episode.ladderIndex = 0;
        episode.advancedForRound = episode.round;
        episode.state = "attempting";
        clearAttemptTimer(episode);
        for (const w of [...episode.waiters]) w.wake?.({ kind: "attempt" });
        return;
      }
      // Advance the ladder ONCE per round however many waiters attempted it.
      if (episode.advancedForRound !== episode.round) {
        episode.advancedForRound = episode.round;
        episode.ladderIndex++;
      }
      log(
        `[Recovery] ${episode.providerDisplayName} attempt ${episode.attempts} failed: ${outcome} ` +
          `(episode ${episode.episodeId}, ladder ${episode.ladderIndex})`
      );
    },

    handoff(): void {
      waiter.leftByDeadline = true;
      episode.anyLeftByDeadline = true;
    },

    close(outcome: RecoveryOutcome): void {
      closeEpisode(episode, outcome);
    },

    leave(): void {
      if (left) return;
      left = true;
      waiter.detach?.();
      waiter.detach = null;
      waiter.wake = null;
      waiter.fail = null;
      episode.waiters.delete(waiter);
      if (episode.waiters.size > 0) return;

      // Last one out.
      clearAttemptTimer(episode);
      if (episode.state === "recovered" || episode.state === "abandoned") {
        byId.delete(episode.episodeId);
        return;
      }

      if (episode.recoveredCount > 0 && !episode.anyLeftByDeadline) {
        closeEpisode(episode, "recovered");
      } else if (episode.anyLeftByDeadline) {
        // A DELIBERATE handoff: a re-POST is expected, so hold the counters.
        episode.state = "handoff";
        const c = recoveryClock();
        const timer = c.setTimeout(() => {
          episode.graceTimer = null;
          closeEpisode(episode, "grace_expired");
        }, EPISODE_GRACE_MS);
        c.unref?.(timer);
        episode.graceTimer = timer;
        log(
          `[Recovery] episode ${episode.episodeId} handed off after ${Math.round(
            c.now() - episode.startedAtPerf
          )}ms, ${episode.attempts} attempts — holding ${EPISODE_GRACE_MS / 1000}s for a client retry`
        );
      } else {
        // The client went away. The grace is for a handoff, not a general
        // retention policy: release now.
        closeEpisode(episode, "client_gone");
      }
    },
  };
}

function armAttemptTimer(episode: Episode, delay: number): void {
  if (episode.attemptTimer !== null) return;
  const clock = recoveryClock();
  episode.state = "waiting";
  episode.nextAttemptAtPerf = clock.now() + delay;
  episode.attemptTimer = clock.setTimeout(() => {
    episode.attemptTimer = null;
    episode.nextAttemptAtPerf = null;
    episode.state = "attempting";
    episode.round++;
    for (const w of [...episode.waiters]) w.wake?.({ kind: "attempt" });
  }, delay);
  log(
    `[Recovery] ${episode.providerDisplayName} waiting ${delay / 1000}s before attempt ` +
      `${episode.attempts + 1} (episode ${episode.episodeId}, ${episode.waiters.size} waiting)`
  );
}

function clearAttemptTimer(episode: Episode): void {
  if (episode.attemptTimer === null) return;
  recoveryClock().clearTimeout(episode.attemptTimer);
  episode.attemptTimer = null;
  episode.nextAttemptAtPerf = null;
}

function closeEpisode(episode: Episode, outcome: RecoveryOutcome): void {
  if (episode.state === "recovered" || episode.state === "abandoned") return;
  const clock = recoveryClock();
  clearAttemptTimer(episode);
  if (episode.graceTimer !== null) {
    clock.clearTimeout(episode.graceTimer);
    episode.graceTimer = null;
  }
  episode.state = outcome === "recovered" ? "recovered" : "abandoned";
  if (episodes.get(episode.key) === episode) episodes.delete(episode.key);
  byId.delete(episode.episodeId);
  // Never strand a parked waiter. Shutdown and give-up both reach here with
  // waiters still on the shared timer, and the timer has just been cleared —
  // without this they would wait on a promise nothing can ever settle.
  if (episode.state === "abandoned") {
    for (const w of [...episode.waiters]) w.wake?.({ kind: "gave_up" });
  }
  log(
    `[Recovery] episode ${episode.episodeId} closed: ${outcome} after ` +
      `${Math.round(clock.now() - episode.startedAtPerf)}ms and ${episode.attempts} attempts`
  );
}

/**
 * Collapse the wait for an episode and attempt now. The pane's `[r] try now`
 * key routes here in a later phase; nothing calls it in this one, and it is
 * exported now so the ladder never grows a second wake path later.
 */
export function tryNow(episodeId: string): void {
  const ep = byId.get(episodeId);
  if (!ep || ep.attemptTimer === null) return;
  clearAttemptTimer(ep);
  ep.state = "attempting";
  ep.round++;
  for (const w of [...ep.waiters]) w.wake?.({ kind: "attempt" });
}

/** Wake every waiter of every episode with `gave_up`. The `[q]` key, later. */
export function giveUp(episodeId: string): void {
  const ep = byId.get(episodeId);
  if (!ep) return;
  ep.gaveUp = true;
  clearAttemptTimer(ep);
  for (const w of [...ep.waiters]) w.wake?.({ kind: "gave_up" });
}

/** Proxy shutdown: no episode may outlive the process that owns its timers. */
export function closeAllEpisodes(outcome: RecoveryOutcome = "shutdown"): void {
  for (const ep of [...episodes.values()]) closeEpisode(ep, outcome);
  for (const ep of [...byId.values()]) closeEpisode(ep, outcome);
  episodes.clear();
  byId.clear();
}
