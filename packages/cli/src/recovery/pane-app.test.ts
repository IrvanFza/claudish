/**
 * The recovery banner.
 *
 * `renderPane` is pure, which is why it is the thing asserted on: the live
 * evidence (a capture of the real pane in a real magmux) and these tests then
 * look at the SAME function rather than at two implementations that drift.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import {
  type PaneViewState,
  formatDuration,
  parsePaneArgs,
  renderPane,
  runRecoveryPane,
  stripAnsi,
  wrapText,
} from "./pane-app.js";
import {
  type RecoverySocketServer,
  createRecoverySocketDir,
  recoverySocketPathIn,
  startRecoverySocketServer,
} from "./socket-server.js";
import {
  PROXY_SILENT_MS,
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryCommand,
  type RecoveryEpisodeFrame,
} from "./types.js";

const T0 = 1_700_000_000_000;

const EPISODE: RecoveryEpisodeFrame = {
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
  reason:
    "Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses. Check your network connection.",
  attempts: 5,
  clientRetries: 0,
  startedAtMs: T0,
  nextAttemptAtMs: T0 + 132_000,
  lastOutcome: "ConnectionClosed after 11ms",
  waiters: 2,
  otherEpisodes: 0,
};

const view = (over: Partial<PaneViewState> = {}): PaneViewState => ({
  frame: EPISODE,
  closed: null,
  nowMs: T0 + 120_000,
  lastFrameAtMs: T0 + 120_000,
  connected: true,
  protocolMismatch: false,
  notice: null,
  ...over,
});

/** Escapes are the medium, not the message — strip them to read the banner. */
/** The banner's text, without the paint. Shared with the renderer on purpose:
 *  a second escape-stripper in the test would be a second thing to get wrong. */
const plain = stripAnsi;

afterEach(() => {
  // `setThemeMode` flips a PROCESS-GLOBAL palette and Bun runs sibling test
  // files in one process. Never leave it flipped.
  resetThemeModeForTests();
});

describe("renderPane", () => {
  test("names the provider, the host and the reason — C-3's three facts", () => {
    const out = plain(renderPane(view(), 100));
    expect(out).toContain("Openai-codex");
    expect(out).toContain("chatgpt.com");
    // The reason is `buildConnectionErrorMessage`'s OWN sentence, not a
    // paraphrase: if the banner and the inline error ever disagree, the user is
    // being told two different stories about one fault.
    expect(out).toContain("Cannot reach Openai-codex at");
    // The sentence is wrapped to the pane, so read it as one flow.
    expect(out.replace(/\s+/g, " ")).toContain("Check your network connection.");
    expect(out).toContain("ConnectionClosed");
  });

  test("offers both keys and does not promise focus it will not steal", () => {
    const out = plain(renderPane(view(), 100));
    expect(out).toContain("[r]");
    expect(out).toContain("[q]");
    // magmux forwards clicks to focus a pane. Stealing focus would swallow
    // keystrokes the user was queueing into Claude Code, which accepts messages
    // while a turn is in flight — a worse failure than one extra click.
    expect(out).toContain("click here");
  });

  test("the countdown DECREASES between two renders — C-4, as a unit", () => {
    const early = plain(renderPane(view({ nowMs: T0 + 70_000 }), 100));
    const later = plain(renderPane(view({ nowMs: T0 + 73_000 }), 100));
    expect(early).toContain("next attempt in 1m 02s");
    expect(later).toContain("next attempt in 59s");
    expect(early).not.toBe(later);
  });

  test("a countdown that has gone past reads 0s, never a negative", () => {
    expect(plain(renderPane(view({ nowMs: T0 + 200_000 }), 100))).toContain("next attempt in 0s");
  });

  test("`attempting` shows what we are doing, not a frozen countdown", () => {
    // A 45-second connect with a countdown stuck at the same number reads as a
    // hang. This line is why the proxy ticks in every live state.
    const out = plain(
      renderPane(view({ frame: { ...EPISODE, state: "attempting", nextAttemptAtMs: null } }), 100)
    );
    expect(out).toContain("connecting to chatgpt.com");
    expect(out).not.toContain("next attempt in");
  });

  test("`handoff` says the client is expected back, which is the truth", () => {
    const out = plain(
      renderPane(
        view({
          frame: { ...EPISODE, state: "handoff", nextAttemptAtMs: null, tier: 2, clientRetries: 2 },
        }),
        100
      )
    );
    expect(out).toContain("waiting for Claude Code to retry");
    expect(out).toContain("client retry 2");
  });

  test("counters: attempts, elapsed, last outcome, held requests, other episodes", () => {
    const out = plain(renderPane(view({ frame: { ...EPISODE, otherEpisodes: 1 } }), 100));
    expect(out).toContain("attempt 5");
    expect(out).toContain("2m 00s in recovery");
    expect(out).toContain("last: ConnectionClosed after 11ms");
    expect(out).toContain("2 requests held");
    expect(out).toContain("+1 more");
  });

  test("a loopback endpoint is marked local", () => {
    const out = plain(renderPane(view({ frame: { ...EPISODE, loopback: true } }), 100));
    expect(out).toContain("local");
  });

  test("the dead-proxy notice appears only after real silence", () => {
    // C-18 asserts this notice is ABSENT for a whole slow-connect run, so it
    // must key on silence longer than the proxy's own tick and nothing else.
    const quiet = view({ lastFrameAtMs: T0 + 120_000 - (PROXY_SILENT_MS - 500) });
    expect(plain(renderPane(quiet, 100))).not.toContain("has not reported");
    const dead = view({ lastFrameAtMs: T0 + 120_000 - (PROXY_SILENT_MS + 500) });
    expect(plain(renderPane(dead, 100))).toContain("has not reported");
  });

  test("a closed episode says how it ended and that the pane will go by itself", () => {
    const ok = plain(
      renderPane(
        view({ closed: { v: 1, type: "closed", episodeId: "ep-1", outcome: "recovered" } }),
        100
      )
    );
    expect(ok).toContain("recovered");
    expect(ok).toContain("this pane closes on its own");
    const bad = plain(
      renderPane(
        view({ closed: { v: 1, type: "closed", episodeId: "ep-1", outcome: "gave_up" } }),
        100
      )
    );
    expect(bad).toContain("gave up");
  });

  test("version skew prints a notice instead of rendering fields it cannot read", () => {
    const out = plain(renderPane(view({ protocolMismatch: true }), 100));
    expect(out).toContain("version skew");
    expect(out).not.toContain("Openai-codex");
  });

  test("before the first frame it says what it is waiting for", () => {
    expect(plain(renderPane(view({ frame: null }), 100))).toContain("waiting for the proxy");
    expect(plain(renderPane(view({ frame: null, connected: false }), 100))).toContain(
      "connecting to the claudish proxy"
    );
  });

  test("every line fits a 40-column pane — a split pane is HALF the terminal", () => {
    // Measured on magmux 0.11.0: `split:"vertical"` took pane 0 from 40 rows to
    // 20 and gave the new pane 19. A user with a narrow window gets a narrow
    // pane, and a banner that runs off it is a banner that cannot be read.
    const narrow = renderPane(view(), 40)
      .split("\n")
      .map((l) => plain(l));
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(40);
    // …and the keys survive the squeeze, because they are the part a user
    // cannot work out for themselves.
    const joined = narrow.join(" ");
    expect(joined).toContain("[r]");
    expect(joined).toContain("[q]");
  });

  // ── THE THEMING INVARIANT ────────────────────────────────────────────────
  test("the palette is read at RENDER time, not at module load", () => {
    // This module was imported at the top of this file, long before the line
    // below runs — which is exactly the production ordering: command modules
    // are imported before theme detection completes. A module-level
    // `const C = cliAnsi()` would snapshot the dark palette here and never
    // change again. That bug class has been found six times in this codebase.
    setThemeMode("dark");
    const dark = renderPane(view(), 100);
    setThemeMode("light");
    const light = renderPane(view(), 100);
    expect(light).not.toBe(dark);
    expect(light).toContain("\x1b[38;2;"); // truecolor: the LIGHT palette
    expect(dark).not.toContain("\x1b[38;2;"); // classic 16-colour: dark/unknown
  });

  test("the red banner fill is the SAME in both themes — it is theme-independent", () => {
    // The one element that must be legible whatever happens does not depend on
    // detection succeeding: a self-contained mid-dark fill with bright-white
    // ink, the pairing `team-grid.ts` established.
    const FILL = "\x1b[1;97;48;2;160;50;70m";
    setThemeMode("dark");
    expect(renderPane(view(), 100)).toContain(FILL);
    setThemeMode("light");
    expect(renderPane(view(), 100)).toContain(FILL);
  });
});

describe("formatDuration / wrapText / parsePaneArgs", () => {
  test("durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(132_000)).toBe("2m 12s");
  });

  test("wrapping never drops or splits a word", () => {
    const words = "alpha beta gamma delta epsilon".split(" ");
    const lines = wrapText(words.join(" "), 12);
    expect(lines.join(" ").split(/\s+/)).toEqual(words);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12);
  });

  test("--socket parses in both spellings, and is required", () => {
    expect(parsePaneArgs(["--socket", "/tmp/x/r.sock"]).socketPath).toBe("/tmp/x/r.sock");
    expect(parsePaneArgs(["--socket=/tmp/y/r.sock"]).socketPath).toBe("/tmp/y/r.sock");
    expect(parsePaneArgs([]).socketPath).toBeNull();
  });
});

// ─── Keys, over a real socket ────────────────────────────────────────────────

class FakeStdin extends EventEmitter {
  setRawMode() {
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

describe("the pane's two keys", () => {
  test("`r`, `R` and Enter each ask for an attempt now; `q` gives up and exits", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    const received: RecoveryCommand[] = [];
    let server: RecoverySocketServer | null = null;
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => EPISODE,
      onCommand: (cmd) => received.push(cmd),
      tickMs: 0,
    });

    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const done = runRecoveryPane({
      socketPath: path,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    await new Promise((r) => setTimeout(r, 150));

    for (const key of ["r", "R", "\r"]) stdin.emit("data", Buffer.from(key));
    await new Promise((r) => setTimeout(r, 120));
    expect(received.filter((c) => c.type === "retry_now")).toHaveLength(3);
    expect(
      received
        .filter((c) => c.type === "retry_now")
        .every((c) => "episodeId" in c && c.episodeId === "ep-1")
    ).toBe(true);

    stdin.emit("data", Buffer.from("q"));
    expect(await done).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(received.filter((c) => c.type === "bye")).toHaveLength(1);
    await server.close();
  }, 15_000);

  test("the banner is painted from the REPLAYED frame, with no tick at all", async () => {
    const path = recoverySocketPathIn(createRecoverySocketDir());
    let server: RecoverySocketServer | null = null;
    server = await startRecoverySocketServer({
      socketPath: path,
      snapshot: () => EPISODE,
      onCommand: () => {},
      tickMs: 0,
    });
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const done = runRecoveryPane({
      socketPath: path,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    await new Promise((r) => setTimeout(r, 150));
    const painted = plain(stdout.chunks.join(""));
    expect(painted).toContain("Openai-codex");
    expect(painted).toContain("chatgpt.com");
    stdin.emit("data", Buffer.from("q"));
    await done;
    await server.close();
  }, 15_000);
});
