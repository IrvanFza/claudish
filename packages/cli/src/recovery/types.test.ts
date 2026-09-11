/**
 * The wire contract.
 *
 * Worth its own file because both processes depend on it and NEITHER can
 * detect a breakage in the other: a proxy that emits a frame the pane silently
 * drops shows a blank banner, and a pane that sends a command the proxy silently
 * drops holds no lease. Both failures are silent by construction, so the
 * parsers' refusals are what has to be pinned.
 */

import { describe, expect, test } from "bun:test";
import {
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryEpisodeFrame,
  UI_HEARTBEAT_MS,
  UI_LEASE_MS,
  encodeLine,
  parseCommand,
  parseFrame,
} from "./types.js";

const frame = (over: Partial<RecoveryEpisodeFrame> = {}): RecoveryEpisodeFrame => ({
  v: RECOVERY_PROTOCOL_VERSION,
  type: "episode",
  episodeId: "ep-1",
  state: "waiting",
  tier: 1,
  providerDisplayName: "Openai-codex",
  host: "chatgpt.com",
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  kind: "unreachable",
  code: "ConnectionClosed",
  loopback: false,
  reason: "Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses.",
  attempts: 5,
  clientRetries: 0,
  startedAtMs: 1_789_234_567_890,
  nextAttemptAtMs: 1_789_234_627_890,
  lastOutcome: "ConnectionClosed after 11ms",
  waiters: 2,
  otherEpisodes: 0,
  ...over,
});

describe("recovery wire contract", () => {
  test("an episode frame round-trips through one NDJSON line", () => {
    const line = encodeLine(frame());
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1); // exactly one, at the end
    expect(parseFrame(line)).toEqual(frame());
  });

  test("a frame from a DIFFERENT protocol version is refused, not guessed at", () => {
    const skewed = encodeLine({ ...frame(), v: 2 });
    expect(parseFrame(skewed)).toBeNull();
  });

  test("malformed JSON and unknown types parse to null rather than throwing", () => {
    expect(parseFrame("{not json")).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(parseFrame(JSON.stringify({ v: 1, type: "wat", episodeId: "x" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ v: 1, type: "episode" }))).toBeNull(); // no episodeId
  });

  test("the SKEW NOTICE parses at the wrong version — it is the one frame that must", () => {
    // The mirror image of `hello` below, and for the same reason. The proxy
    // answers a mismatched pane with a `closed` / `protocol_mismatch` frame
    // carrying the PROXY'S version, so a blanket version gate dropped the very
    // message addressed to the build that cannot read the others:
    // `PaneViewState.protocolMismatch` was unreachable in a real skew and the
    // pane printed "the claudish proxy closed this connection" instead — a safe
    // failure with the wrong diagnosis, on the one day it mattered.
    const notice = JSON.stringify({
      v: 99,
      type: "closed",
      episodeId: "",
      outcome: "protocol_mismatch",
    });
    const parsed = parseFrame(notice);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("closed");
    expect((parsed as { outcome?: string }).outcome).toBe("protocol_mismatch");

    // And ONLY that outcome. A skewed `closed` frame of any other kind is still
    // refused — the exemption is for the notice, not for the type.
    expect(
      parseFrame(JSON.stringify({ v: 99, type: "closed", episodeId: "e", outcome: "recovered" }))
    ).toBeNull();
  });

  test("`hello` parses even at the WRONG version — the mismatch must be answerable", () => {
    // The server cannot tell a skewed client it is skewed if the one message it
    // needs to answer is the one it drops.
    const cmd = parseCommand(JSON.stringify({ v: 99, type: "hello", protocol: 99, pid: 7 }));
    expect(cmd).not.toBeNull();
    expect(cmd?.type).toBe("hello");
  });

  test("every OTHER command is version-gated", () => {
    expect(parseCommand(JSON.stringify({ v: 2, type: "ack", episodeId: "ep-1" }))).toBeNull();
    expect(parseCommand(JSON.stringify({ v: 2, type: "retry_now", episodeId: "ep-1" }))).toBeNull();
    expect(parseCommand(JSON.stringify({ v: 2, type: "bye", reason: "user_quit" }))).toBeNull();
  });

  test("ack, retry_now and bye parse at the right version", () => {
    expect(
      parseCommand(JSON.stringify({ v: 1, type: "ack", episodeId: "ep-1", paintedAt: 5 }))
    ).toEqual({ v: 1, type: "ack", episodeId: "ep-1", paintedAt: 5 });
    expect(parseCommand(JSON.stringify({ v: 1, type: "retry_now", episodeId: "ep-1" }))).toEqual({
      v: 1,
      type: "retry_now",
      episodeId: "ep-1",
    });
    expect(parseCommand(JSON.stringify({ v: 1, type: "bye", reason: "user_quit" }))).toEqual({
      v: 1,
      type: "bye",
      reason: "user_quit",
    });
  });

  test("the heartbeat leaves an order of magnitude of headroom under the lease", () => {
    // Nine consecutive dropped heartbeats must be survivable. If these two ever
    // come within 2x of each other, one slow paint revokes a live banner's
    // lease and the exhaustion arm answers as though nothing were on screen.
    expect(UI_LEASE_MS / UI_HEARTBEAT_MS).toBeGreaterThanOrEqual(10);
  });
});
