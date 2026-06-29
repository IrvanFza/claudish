import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SignalWatcher } from "./signal-watcher.js";
import type { SignalData } from "./types.js";

describe("SignalWatcher", () => {
  let watcher: SignalWatcher;
  let events: SignalData[];
  let callback: (sessionId: string, data: SignalData) => void;

  beforeEach(() => {
    events = [];
    callback = (_sid, data) => events.push(data);
    watcher = new SignalWatcher("test-session", callback, 100); // 100ms for tests
  });

  afterEach(() => {
    watcher.dispose();
  });

  test("starts in 'starting' state", () => {
    expect(watcher.state).toBe("starting");
  });

  test("transitions to 'running' on first output", () => {
    watcher.feed("Hello world\n");
    expect(watcher.state).toBe("running");
    expect(events.length).toBe(1);
    expect(events[0].previousState).toBe("starting");
    expect(events[0].newState).toBe("running");
  });

  test("transitions to 'tool_executing' on tool pattern", () => {
    watcher.feed("Starting response\n");
    events = []; // clear starting→running event
    watcher.feed("  ⏺ Read packages/cli/src/index.ts\n");
    expect(watcher.state).toBe("tool_executing");
    expect(events.length).toBe(1);
    expect(events[0].newState).toBe("tool_executing");
    expect(events[0].toolName).toBe("Read");
  });

  test("transitions back to 'running' after tool output ends", () => {
    watcher.feed("Starting\n");
    watcher.feed("  ⏺ Bash echo hello\n");
    expect(watcher.state).toBe("tool_executing");
    watcher.feed("Some regular output\n");
    expect(watcher.state).toBe("running");
  });

  test("processExited(0) transitions to 'completed'", () => {
    watcher.feed("Output\n");
    events = [];
    watcher.processExited(0);
    expect(watcher.state).toBe("completed");
    expect(events[0].newState).toBe("completed");
  });

  test("processExited(1) transitions to 'failed'", () => {
    watcher.feed("Output\n");
    events = [];
    watcher.processExited(1);
    expect(watcher.state).toBe("failed");
    expect(events[0].newState).toBe("failed");
    expect(events[0].content).toContain("exit");
  });

  test("forceState sets state directly", () => {
    watcher.feed("Output\n");
    events = [];
    watcher.forceState("cancelled", "User cancelled");
    expect(watcher.state).toBe("cancelled");
    expect(events[0].newState).toBe("cancelled");
    expect(events[0].content).toBe("User cancelled");
  });

  test("processExited does not override 'cancelled' state", () => {
    watcher.feed("Output\n");
    watcher.forceState("cancelled");
    events = [];
    watcher.processExited(137);
    // Should NOT transition — already cancelled
    expect(watcher.state).toBe("cancelled");
    expect(events.length).toBe(0);
  });

  test("quiet period + question mark triggers 'waiting_for_input'", async () => {
    watcher.feed("Starting\n");
    events = [];
    watcher.feed("Which database should I use?\n");

    // Should NOT be waiting_for_input immediately
    expect(watcher.state).toBe("running");

    // Wait for quiet period (100ms) + buffer
    await new Promise((r) => setTimeout(r, 150));

    expect(watcher.state).toBe("waiting_for_input");
    const lastEvent = events[events.length - 1];
    expect(lastEvent.newState).toBe("waiting_for_input");
  });

  test("new output resets quiet timer (no false input_required)", async () => {
    watcher.feed("Starting\n");
    watcher.feed("Is this a question?\n");

    // Output more data before quiet period expires (at 50ms, well before 100ms quiet period)
    await new Promise((r) => setTimeout(r, 50));
    watcher.feed("More output arriving\n");

    // Wait past the original quiet period (150ms total > 100ms quiet period from first feed)
    await new Promise((r) => setTimeout(r, 150));

    // Should NOT be waiting_for_input because output reset the timer
    expect(watcher.state).toBe("running");
  });

  test("dispose prevents further transitions", () => {
    watcher.feed("Output\n");
    watcher.dispose();
    events = [];
    watcher.feed("More output\n");
    watcher.processExited(0);
    expect(events.length).toBe(0);
  });

  test("detects multiple tool patterns", () => {
    watcher.feed("Starting\n");

    watcher.feed("  ⏺ Write file.ts\n");
    expect(watcher.state).toBe("tool_executing");

    watcher.feed("Done writing\n");
    expect(watcher.state).toBe("running");

    watcher.feed("  ⏺ Bash npm test\n");
    expect(watcher.state).toBe("tool_executing");
  });
});
