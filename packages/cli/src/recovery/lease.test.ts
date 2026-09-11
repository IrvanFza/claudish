/**
 * The UI lease — the round-2 CRITICAL, and the reason this file exists at all.
 *
 * The lease is what will decide, one phase from now, whether an exhausted
 * episode may answer a RETRYABLE status instead of an inline error. The rule it
 * encodes is: *a retryable status is permissible exactly while claudish still
 * has a surface on which the reason is legible.*
 *
 * The superseded design renewed that lease from FRAME RECEIPTS, and frames only
 * ticked while the ladder was `waiting`. A connect against an unreachable host
 * takes 20–75 s (measured on this machine: `192.0.2.1` = 75 005 ms), during
 * which the proxy has nothing new to say — so the lease died ten seconds into
 * every slow attempt, and the exhaustion arm, which reads it immediately after
 * an attempt returns, saw it false for the ENTIRE failure class the feature was
 * built for, with a live painted banner on screen.
 *
 * And every test passed, because every fault in the suite was a ~1 ms loopback
 * refusal. These are the tests that can fail on it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resetRecoveryClock, setRecoveryClock } from "./clock.js";
import {
  __handleCommandForTests,
  __resetUiStateForTests,
  __setPaneOpenForTests,
  describeLease,
  uiLeaseValid,
} from "./magmux-ui.js";
import { runRecoveryPane } from "./pane-app.js";
import {
  type RecoverySocketServer,
  createRecoverySocketDir,
  recoverySocketPathIn,
  startRecoverySocketServer,
} from "./socket-server.js";
import { FakeClock } from "./test-helpers/fake-clock.js";
import {
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryEpisodeFrame,
  UI_HEARTBEAT_MS,
  UI_LEASE_MS,
} from "./types.js";

const EPISODE: RecoveryEpisodeFrame = {
  v: RECOVERY_PROTOCOL_VERSION,
  type: "episode",
  episodeId: "ep-slow",
  // `attempting`, not `waiting`: this is the state the proxy sits in for the
  // whole of a 45-second connect, and the state in which the old design went
  // silent.
  state: "attempting",
  tier: 1,
  providerDisplayName: "Openai-codex",
  host: "chatgpt.com",
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  kind: "unreachable",
  code: "ConnectionClosed",
  loopback: false,
  reason: "Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses.",
  attempts: 4,
  clientRetries: 0,
  startedAtMs: 1_700_000_000_000,
  nextAttemptAtMs: null,
  lastOutcome: "ConnectionClosed after 45001ms",
  waiters: 1,
  otherEpisodes: 0,
};

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock(0);
  setRecoveryClock(clock);
  __resetUiStateForTests();
});

afterEach(() => {
  __resetUiStateForTests();
  resetRecoveryClock();
});

const ack = (episodeId: string) =>
  __handleCommandForTests({
    v: RECOVERY_PROTOCOL_VERSION,
    type: "ack",
    episodeId,
    paintedAt: Date.now(),
  });

describe("the UI lease (unit, fake clock)", () => {
  test("SURVIVES an attempt far longer than UI_LEASE_MS while the renderer heartbeats", async () => {
    // THE round-2 CRITICAL, expressed as an assertion. 45 seconds of attempt —
    // 4.5 leases — with NOT ONE FRAME emitted, because the proxy has nothing to
    // say while a connect hangs. The renderer's own heartbeat is the only thing
    // renewing anything.
    __setPaneOpenForTests(true);
    ack("ep-slow");

    for (let elapsed = 0; elapsed < 45_000; elapsed += UI_HEARTBEAT_MS) {
      await clock.advance(UI_HEARTBEAT_MS);
      ack("ep-slow"); // the renderer, on ITS timer, not on a frame
      expect(uiLeaseValid("ep-slow")).toBe(true);
    }

    expect(clock.now()).toBeGreaterThanOrEqual(45_000);
    expect(uiLeaseValid("ep-slow")).toBe(true);
  });

  test("expires UI_LEASE_MS after the last heartbeat — a frozen renderer holds nothing", async () => {
    __setPaneOpenForTests(true);
    ack("ep-slow");
    await clock.advance(UI_LEASE_MS);
    expect(uiLeaseValid("ep-slow")).toBe(true); // exactly at the boundary
    await clock.advance(1);
    expect(uiLeaseValid("ep-slow")).toBe(false);
  });

  test("a forged client cannot grant itself a lease: paneOpen is required", () => {
    // The socket has no same-uid boundary and cannot have one. What is defended
    // is the CONSEQUENCE: the one forbidden state (a retryable status with no
    // banner) additionally requires that WE opened a pane and hold the reply,
    // which is a fact no client can cause.
    __setPaneOpenForTests(false);
    ack("ep-slow");
    expect(uiLeaseValid("ep-slow")).toBe(false);
    expect(describeLease("ep-slow").lastAckAgoMs).toBe(0); // it DID heartbeat…
    expect(describeLease("ep-slow").paneOpen).toBe(false); // …and it still gets nothing
  });

  test("the lease is per-EPISODE: heartbeating one does not lease another", () => {
    __setPaneOpenForTests(true);
    ack("ep-slow");
    expect(uiLeaseValid("ep-slow")).toBe(true);
    expect(uiLeaseValid("ep-other")).toBe(false);
  });

  test("switching the painted episode lets the old lease lapse with no extra protocol", async () => {
    __setPaneOpenForTests(true);
    ack("ep-slow");
    for (let i = 0; i < 12; i++) {
      await clock.advance(UI_HEARTBEAT_MS);
      ack("ep-other"); // the renderer moved on
    }
    expect(uiLeaseValid("ep-other")).toBe(true);
    expect(uiLeaseValid("ep-slow")).toBe(false);
  });

  test("`bye` revokes every lease, and no later heartbeat can resurrect one", () => {
    // `[q] give up` is the affordance the superseded design labelled
    // "give up" and gave no server-side effect at all — so a user could close
    // the banner while the machine kept retrying and eventually answered a
    // retryable status with nothing on screen. That is the design's OWN stated
    // worst case, reached through a key that says "give up".
    __setPaneOpenForTests(true);
    ack("ep-slow");
    ack("ep-other");
    expect(uiLeaseValid("ep-slow")).toBe(true);

    __handleCommandForTests({ v: RECOVERY_PROTOCOL_VERSION, type: "bye", reason: "user_quit" });

    expect(uiLeaseValid("ep-slow")).toBe(false);
    expect(uiLeaseValid("ep-other")).toBe(false);
    // The pane is genuinely gone, not merely un-leased…
    expect(describeLease("ep-slow").paneOpen).toBe(false);
    // …so a client that keeps heartbeating into the closed socket gets nothing.
    // Without this, `bye` would be undone by the very next tick of a renderer
    // that had not noticed it was closed.
    ack("ep-slow");
    expect(uiLeaseValid("ep-slow")).toBe(false);
  });
});

// ─── The same property, end to end, over a real socket ───────────────────────

class FakeStdin extends EventEmitter {
  rawMode = false;
  setRawMode(on: boolean) {
    this.rawMode = on;
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
}

class FakeStdout extends EventEmitter {
  columns = 100;
  chunks: string[] = [];
  write(s: string) {
    this.chunks.push(s);
    return true;
  }
}

describe("the UI lease (end to end, real socket, real renderer)", () => {
  test("the REAL pane heartbeats through total frame silence, and the lease holds", async () => {
    // One frame in the whole run — the replay — and then nothing, which is what
    // a hung connect looks like on the wire. If the renderer ever goes back to
    // acking per received frame, the ack count collapses to 1 and the lease is
    // dead by fake-t=10s. That is the defect this test exists to fail on.
    const path = recoverySocketPathIn(createRecoverySocketDir());
    let framesSent = 0;
    let acks = 0;

    let server: RecoverySocketServer | null = null;
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();

    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => {
        framesSent++;
        return EPISODE;
      },
      onCommand: (cmd) => {
        if (cmd.type === "ack") acks++;
        __handleCommandForTests(cmd);
      },
      tickMs: 0, // the proxy says NOTHING after the replay
    });

    __setPaneOpenForTests(true);
    const paneDone = runRecoveryPane({
      socketPath: path,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    // ~4 real heartbeat intervals, with the LEASE clock advancing 5 s each time
    // — so the episode is 20 s old in lease terms while the socket has carried
    // exactly one frame.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, UI_HEARTBEAT_MS + 120));
      await clock.advance(5_000);
      expect(uiLeaseValid("ep-slow")).toBe(true);
    }

    expect(framesSent).toBe(1);
    expect(acks).toBeGreaterThanOrEqual(3);
    expect(clock.now()).toBeGreaterThan(UI_LEASE_MS);
    expect(uiLeaseValid("ep-slow")).toBe(true);

    stdin.emit("data", Buffer.from("q"));
    await paneDone;
    await server.close();
  }, 15_000);
});
