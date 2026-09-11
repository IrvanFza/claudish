/**
 * The recovery socket, over a REAL unix socket with REAL clients.
 *
 * No `mock.module()` anywhere: this repo's standing rule is that mocking shared
 * infrastructure bleeds across sibling test files in Bun's module registry, and
 * `node:net` is about as shared as infrastructure gets. The socket is cheap
 * enough to use for real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import {
  type RecoverySocketServer,
  createRecoverySocketDir,
  recoverySocketPathIn,
  startRecoverySocketServer,
} from "./socket-server.js";
import {
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryCommand,
  type RecoveryEpisodeFrame,
  type RecoveryFrame,
  encodeLine,
  parseFrame,
} from "./types.js";

const EPISODE: RecoveryEpisodeFrame = {
  v: RECOVERY_PROTOCOL_VERSION,
  type: "episode",
  episodeId: "ep-replay",
  state: "attempting",
  tier: 1,
  providerDisplayName: "Openai-codex",
  host: "chatgpt.com",
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  kind: "unreachable",
  code: "ConnectionClosed",
  loopback: false,
  reason: "Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses.",
  attempts: 3,
  clientRetries: 0,
  startedAtMs: 1_700_000_000_000,
  nextAttemptAtMs: null,
  lastOutcome: "ConnectionClosed after 11ms",
  waiters: 1,
  otherEpisodes: 0,
};

/** A raw NDJSON client, so the test exercises the same bytes the pane does. */
function rawClient(path: string): Promise<{
  frames: RecoveryFrame[];
  send: (line: string) => void;
  end: () => void;
}> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    const frames: RecoveryFrame[] = [];
    let buf = "";
    s.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        const f = parseFrame(line);
        if (f) frames.push(f);
      }
    });
    s.once("connect", () =>
      resolve({
        frames,
        send: (line: string) => s.write(line),
        end: () => s.destroy(),
      })
    );
    s.once("error", reject);
  });
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let server: RecoverySocketServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("recovery socket server", () => {
  test("replays the current episode to a client that connects LATE", async () => {
    // The pane starts ~100ms after `open_pane`, which is always after the
    // episode began. Without a replay its first paint is blank, and that blank
    // is the first thing a user ever sees of this feature.
    const path = recoverySocketPathIn(createRecoverySocketDir());
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => EPISODE,
      onCommand: () => {},
      tickMs: 0,
    });

    const client = await rawClient(path);
    await settle();
    expect(client.frames).toHaveLength(1);
    expect(client.frames[0]).toEqual(EPISODE);
    client.end();
  });

  test("ticks in EVERY live state, including `attempting` with no state change", async () => {
    // The state below never changes and no broadcast is ever called. Frames
    // must arrive anyway: a 45-second connect is 45 seconds of silence
    // otherwise, which looks identical to a dead proxy to the pane's own
    // liveness heuristic.
    const path = recoverySocketPathIn(createRecoverySocketDir());
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => ({ ...EPISODE, state: "attempting", nextAttemptAtMs: null }),
      onCommand: () => {},
      tickMs: 25,
    });
    const client = await rawClient(path);
    await settle(180);
    // 1 replay + several ticks.
    expect(client.frames.length).toBeGreaterThanOrEqual(4);
    expect(client.frames.every((f) => f.type === "episode" && f.state === "attempting")).toBe(true);
    client.end();
  });

  test("a null snapshot suppresses the replay and the tick rather than sending junk", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => null,
      onCommand: () => {},
      tickMs: 25,
    });
    const client = await rawClient(path);
    await settle(120);
    expect(client.frames).toHaveLength(0);
    client.end();
  });

  test("routes ack, retry_now and bye; ignores malformed and skewed lines", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    const seen: RecoveryCommand[] = [];
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => null,
      onCommand: (cmd) => seen.push(cmd),
      tickMs: 0,
    });
    const client = await rawClient(path);
    client.send(
      encodeLine({ v: 1, type: "ack", episodeId: "ep-replay", paintedAt: 1 }) +
        encodeLine({ v: 1, type: "retry_now", episodeId: "ep-replay" }) +
        "{bad json}\n" +
        `${JSON.stringify({ v: 9, type: "ack", episodeId: "ep-replay" })}\n` +
        encodeLine({ v: 1, type: "bye", reason: "user_quit" })
    );
    await settle();
    expect(seen.map((c) => c.type)).toEqual(["ack", "retry_now", "bye"]);
    client.end();
  });

  test("a client on the WRONG protocol is told so and dropped", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    const seen: RecoveryCommand[] = [];
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => null,
      onCommand: (cmd) => seen.push(cmd),
      tickMs: 0,
    });
    const client = await rawClient(path);
    client.send(`${JSON.stringify({ v: 9, type: "hello", protocol: 9, pid: 1 })}\n`);
    await settle();
    expect(client.frames).toHaveLength(1);
    expect(client.frames[0]).toMatchObject({ type: "closed", outcome: "protocol_mismatch" });
    // And the command is NOT delivered — a build we cannot talk to must not be
    // able to drive the ladder.
    expect(seen).toHaveLength(0);
  });

  test("the directory is 0700, the socket 0600, and both are gone after close", async () => {
    const dir = createRecoverySocketDir();
    const path = recoverySocketPathIn(dir);
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => null,
      onCommand: () => {},
      tickMs: 0,
    });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await server.close();
    server = null;
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("two directories from two calls never collide", async () => {
    const a = createRecoverySocketDir();
    const b = createRecoverySocketDir();
    expect(a).not.toBe(b);
    // 24 hex characters of randomness — not the proxy port, which is printed at
    // startup and would make the path guessable by something not looking for us.
    expect(a).toMatch(/^\/tmp\/claudish-recovery-[0-9a-f]{24}$/);
  });

  test("disconnects are reported, and broadcasting afterwards does not throw", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    let gone = 0;
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => null,
      onCommand: () => {},
      onDisconnect: () => {
        gone++;
      },
      tickMs: 0,
    });
    const client = await rawClient(path);
    await settle();
    expect(server.clientCount()).toBe(1);
    client.end();
    await settle();
    expect(gone).toBe(1);
    expect(server.clientCount()).toBe(0);
    server.broadcast(EPISODE); // must be a no-op, not a throw
  });
});
