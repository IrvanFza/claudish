/**
 * Tests for onepassword-handshake-lock.ts — the dependency-light cross-process
 * mutex around the 1Password DesktopAuth handshake.
 *
 * Every test redirects the exported path seam into a fresh temp directory and
 * compresses the shipped 120s stale / 45s timeout timings to milliseconds. The
 * real ~/.claudish directory, 1Password SDK, `op` binary, and network are never
 * touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetHandshakeLockTestSeams,
  setHandshakeLockTestSeams,
  withHandshakeLock,
} from "./onepassword-handshake-lock.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let lockPath: string;
let savedBypass: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-op-handshake-lock-"));
  lockPath = join(dir, "op-handshake.lock");
  savedBypass = process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  delete process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  setHandshakeLockTestSeams({
    path: lockPath,
    timing: { staleMs: 500, timeoutMs: 100, pollMs: 1 },
  });
});

afterEach(() => {
  resetHandshakeLockTestSeams();
  if (savedBypass === undefined) delete process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK;
  else process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = savedBypass;
  rmSync(dir, { recursive: true, force: true });
});

describe("withHandshakeLock", () => {
  test("mutually excludes concurrent handshakes", async () => {
    type Event = { name: "first" | "second"; phase: "enter" | "exit"; at: number };
    const events: Event[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (name: Event["name"], holdMs: number) =>
      withHandshakeLock(async () => {
        events.push({ name, phase: "enter", at: Date.now() });
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(holdMs);
        active--;
        events.push({ name, phase: "exit", at: Date.now() });
      });

    await Promise.all([run("first", 15), run("second", 5)]);

    const firstEnter = events.find((event) => event.name === "first" && event.phase === "enter");
    const firstExit = events.find((event) => event.name === "first" && event.phase === "exit");
    const secondEnter = events.find((event) => event.name === "second" && event.phase === "enter");
    const secondExit = events.find((event) => event.name === "second" && event.phase === "exit");

    expect(events).toHaveLength(4);
    expect(maxActive).toBe(1);
    expect(firstEnter).toBeDefined();
    expect(firstExit).toBeDefined();
    expect(secondEnter).toBeDefined();
    expect(secondExit).toBeDefined();
    expect(
      (firstExit?.at ?? 0) <= (secondEnter?.at ?? 0) ||
        (secondExit?.at ?? 0) <= (firstEnter?.at ?? 0)
    ).toBe(true);
  });

  test("removes the lock after success and after a propagated callback error", async () => {
    const result = await withHandshakeLock(async () => {
      expect(existsSync(lockPath)).toBe(true);
      return "done";
    });

    expect(result).toBe("done");
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withHandshakeLock(async () => {
        expect(existsSync(lockPath)).toBe(true);
        throw new Error("handshake failed");
      })
    ).rejects.toThrow("handshake failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("bypasses locking when CLAUDISH_NO_OP_HANDSHAKE_LOCK=1", async () => {
    process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK = "1";

    const result = await withHandshakeLock(async () => {
      expect(existsSync(lockPath)).toBe(false);
      return "unlocked";
    });

    expect(result).toBe("unlocked");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("steals a fresh lock whose owner process has exited", async () => {
    const deadProcess = spawnSync(process.execPath, ["-e", ""]);
    expect(deadProcess.status).toBe(0);
    expect(deadProcess.pid).toBeGreaterThan(0);
    writeFileSync(lockPath, `${deadProcess.pid} ${Date.now()}`);

    const startedAt = Date.now();
    const holder = await withHandshakeLock(async () => readFileSync(lockPath, "utf-8"));

    expect(holder.startsWith(`${process.pid} `)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("degrades to an unlocked callback after acquire timeout", async () => {
    setHandshakeLockTestSeams({ timing: { timeoutMs: 10, pollMs: 1 } });
    const originalHolder = `${process.pid} ${Date.now()}`;
    writeFileSync(lockPath, originalHolder);

    const startedAt = Date.now();
    let callbackRan = false;
    await withHandshakeLock(async () => {
      callbackRan = true;
    });

    expect(callbackRan).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(readFileSync(lockPath, "utf-8")).toBe(originalHolder);
  });

  test("degrades to an unlocked callback when the lock path is unwritable", async () => {
    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "blocking file");
    setHandshakeLockTestSeams({ path: join(parentFile, "op-handshake.lock") });

    let callbackRan = false;
    await expect(
      withHandshakeLock(async () => {
        callbackRan = true;
        return "unlocked";
      })
    ).resolves.toBe("unlocked");

    expect(callbackRan).toBe(true);
    expect(readFileSync(parentFile, "utf-8")).toBe("blocking file");
  });
});
