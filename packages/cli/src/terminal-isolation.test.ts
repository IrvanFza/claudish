import { afterEach, describe, expect, test } from "bun:test";
import { format } from "node:util";
import {
  type SuppressedOutput,
  beginTerminalIsolation,
  isTerminalIsolated,
} from "./terminal-isolation.js";

const CONSOLE_METHODS = ["log", "error", "warn", "info", "debug", "trace"] as const;
const originalConsole = Object.fromEntries(
  CONSOLE_METHODS.map((method) => [method, console[method]])
) as Pick<Console, (typeof CONSOLE_METHODS)[number]>;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

let restoreIsolation: (() => void) | null = null;

afterEach(() => {
  try {
    restoreIsolation?.();
  } finally {
    restoreIsolation = null;

    // Last-resort cleanup: a failing assertion must never leave the Bun test
    // runner's own output routed into a test sink.
    for (const method of CONSOLE_METHODS) {
      console[method] = originalConsole[method];
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

describe("terminal isolation", () => {
  test("diverts console output with its method source and util.format text", () => {
    const entries: SuppressedOutput[] = [];
    restoreIsolation = beginTerminalIsolation((entry) => entries.push(entry));

    try {
      for (const method of CONSOLE_METHODS) {
        console[method]("%s=%d", method, 7);
      }
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(entries).toEqual(
      CONSOLE_METHODS.map((method) => ({
        source: `console.${method}`,
        text: format("%s=%d", method, 7),
      }))
    );
  });

  test("diverts stdout and stderr writes", () => {
    const entries: SuppressedOutput[] = [];
    restoreIsolation = beginTerminalIsolation((entry) => entries.push(entry));

    try {
      expect(process.stdout.write("stdout text")).toBe(true);
      expect(process.stderr.write("stderr text")).toBe(true);
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(entries).toEqual([
      { source: "stdout", text: "stdout text" },
      { source: "stderr", text: "stderr text" },
    ]);
  });

  test("decodes Buffer and Uint8Array chunks as UTF-8", () => {
    const entries: SuppressedOutput[] = [];
    restoreIsolation = beginTerminalIsolation((entry) => entries.push(entry));

    try {
      expect(process.stdout.write(Buffer.from("buffer: café", "utf8"))).toBe(true);
      expect(process.stderr.write(new TextEncoder().encode("uint8: 日本語"))).toBe(true);
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(entries).toEqual([
      { source: "stdout", text: "buffer: café" },
      { source: "stderr", text: "uint8: 日本語" },
    ]);
  });

  test("write returns true and invokes callbacks passed as the second or third argument", () => {
    const callbacks: Array<Error | null | undefined> = [];
    restoreIsolation = beginTerminalIsolation(() => {});

    try {
      const secondArgResult = process.stdout.write("second", (error) => {
        callbacks.push(error);
      });
      const thirdArgResult = process.stderr.write("third", "utf8", (error) => {
        callbacks.push(error);
      });

      expect(secondArgResult).toBe(true);
      expect(thirdArgResult).toBe(true);
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(callbacks).toEqual([null, null]);
  });

  test("restore reinstates the console methods and stream writers", () => {
    const stdoutCalls: string[] = [];
    const stderrCalls: string[] = [];

    const savedConsoleMethods = Object.fromEntries(
      CONSOLE_METHODS.map((method) => [method, console[method]])
    ) as Pick<Console, (typeof CONSOLE_METHODS)[number]>;
    const savedStdoutWrite = process.stdout.write;
    const savedStderrWrite = process.stderr.write;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutCalls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      restoreIsolation = beginTerminalIsolation(() => {});
      restoreIsolation();
      restoreIsolation = null;

      for (const method of CONSOLE_METHODS) {
        expect(console[method]).toBe(savedConsoleMethods[method]);
      }
      process.stdout.write("stdout restored");
      process.stderr.write("stderr restored");

      expect(stdoutCalls).toEqual(["stdout restored"]);
      expect(stderrCalls).toEqual(["stderr restored"]);
    } finally {
      process.stdout.write = savedStdoutWrite;
      process.stderr.write = savedStderrWrite;
    }
  });

  test("a second begin call is a no-op and cannot clobber the first restore", () => {
    const firstEntries: SuppressedOutput[] = [];
    const secondEntries: SuppressedOutput[] = [];
    const savedConsoleError = console.error;

    restoreIsolation = beginTerminalIsolation((entry) => firstEntries.push(entry));
    const secondRestore = beginTerminalIsolation((entry) => secondEntries.push(entry));

    try {
      secondRestore();
      expect(isTerminalIsolated()).toBe(true);
      console.error("still routed by first sink");

      restoreIsolation();
      restoreIsolation = null;
      expect(isTerminalIsolated()).toBe(false);
      expect(console.error).toBe(savedConsoleError);
    } finally {
      restoreIsolation?.();
      restoreIsolation = null;
    }

    expect(firstEntries).toEqual([{ source: "console.error", text: "still routed by first sink" }]);
    expect(secondEntries).toEqual([]);
  });

  test("drops re-entrant console output from the suppression sink", () => {
    const entries: SuppressedOutput[] = [];
    restoreIsolation = beginTerminalIsolation((entry) => {
      entries.push(entry);
      console.error("nested sink output");
    });

    try {
      console.warn("outer output");
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(entries).toEqual([{ source: "console.warn", text: "outer output" }]);
  });

  test("swallows exceptions thrown by the suppression sink", () => {
    restoreIsolation = beginTerminalIsolation(() => {
      throw new Error("sink failed");
    });

    try {
      expect(() => console.error("must not escape")).not.toThrow();
      expect(() => process.stderr.write("must not escape")).not.toThrow();
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }
  });

  test("isTerminalIsolated reflects begin and restore state", () => {
    expect(isTerminalIsolated()).toBe(false);
    restoreIsolation = beginTerminalIsolation(() => {});

    try {
      expect(isTerminalIsolated()).toBe(true);
    } finally {
      restoreIsolation();
      restoreIsolation = null;
    }

    expect(isTerminalIsolated()).toBe(false);
  });
});
