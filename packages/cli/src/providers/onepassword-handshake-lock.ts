/**
 * onepassword-handshake-lock — a CROSS-PROCESS mutex around the 1Password
 * DesktopAuth handshake.
 *
 * WHY THIS EXISTS
 *
 * `Denied authorization for SDK client` has four documented causes. Three of
 * them (the user clicked Cancel, the Mac screen is locked, the app is locked)
 * are states of the machine. The fourth is a RACE, and it is the one claudish
 * creates itself: 1Password arbitrates the DesktopAuth handshake across the
 * whole MACHINE, authorizes exactly ONE client, and instantly denies every
 * concurrent peer.
 *
 * Measured 2026-07-31 against the real desktop app with a bare `@1password/sdk`
 * probe — no claudish code in the picture, screen unlocked, app unlocked
 * (ai-docs/sessions/op-denial-rootcause-20260731-153357-90bf2332/):
 *
 *   1 process                    → 1 authorized, 0 denied
 *   6 concurrent processes       → 1 authorized, 5 DENIED in 945–1029ms
 *   6 concurrent + this lock     → 6 authorized, 0 denied
 *
 * Two facts from that run shape this module:
 *
 *   · The denial fires on `createClient()` — the handshake — not on the secret
 *     fetch. So the lock covers ONLY the handshake. Holding it across the
 *     actual `resolveAll`/`getVariables` would serialize work that does not
 *     contend at all.
 *   · An already-authorized client is NOT revoked when a peer authorizes: in
 *     the unlocked arm the winner completed its fetch after the five denials.
 *     So releasing the moment the handshake returns is safe.
 *
 * The uniform ~950ms denial latency is also the proof that no human was asked —
 * nobody clicks that fast. This is denial-without-a-dialog, which is why
 * `isTransientSdkError` correctly refuses to retry it (retrying a real Cancel
 * re-opens the dialog the user just dismissed — the "second dialog" bug,
 * aa71ce3). Preventing the race is the only fix available at this layer.
 *
 * `prehydrateCredentialsForSpawn` already removes most of the need to hold this
 * lock at all: children inherit resolved keys and never build a client. This is
 * the backstop for what is left — chain candidates 1Password cannot supply, and
 * two INDEPENDENT claudish processes launched at the same instant, which no
 * in-process queue and no parent/child protocol can span.
 *
 * DEPENDENCY-LIGHT by contract: node built-ins only. `onepassword.ts` is
 * imported by `index.ts` before the heavy deps, and this module is imported by
 * it at module load.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How long a lock file may sit untouched before a waiter treats it as
 * abandoned and steals it.
 *
 * Deliberately generous. The handshake it guards CAN block on a human clicking
 * "Authorize" in the 1Password app, and a lock stolen out from under someone
 * mid-approval recreates the exact race this module exists to prevent. A dead
 * holder is detected directly (pid liveness) rather than by waiting this out,
 * so the age check only has to cover a process that is alive but wedged.
 */
const DEFAULT_STALE_MS = 120_000;

/**
 * How long to wait for the lock before giving up and handshaking anyway.
 *
 * Never block a run forever on a lock. Past this point we degrade to exactly
 * the pre-lock behaviour — which may mean a denial, and a denial is a strictly
 * better outcome than claudish hanging.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Poll interval base; jittered so waiters do not wake in lockstep. */
const DEFAULT_POLL_MS = 60;

type Timing = { staleMs: number; timeoutMs: number; pollMs: number };
let timing: Timing = {
  staleMs: DEFAULT_STALE_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  pollMs: DEFAULT_POLL_MS,
};

let lockPath: string | undefined;

/** The lock lives per-USER: 1Password arbitrates per user session. */
function defaultLockPath(): string {
  return join(homedir(), ".claudish", "op-handshake.lock");
}

function currentLockPath(): string {
  return lockPath ?? defaultLockPath();
}

/**
 * Test seam: point the lock at a temp file and compress the timings.
 * MANDATORY in tests — the real defaults would add 45s of wall clock to any
 * case that exercises the timeout path.
 */
export function setHandshakeLockTestSeams(seams: {
  path?: string;
  timing?: Partial<Timing>;
}): void {
  if (seams.path !== undefined) lockPath = seams.path;
  if (seams.timing) timing = { ...timing, ...seams.timing };
}

/** Test seam: restore the shipped path and timings. */
export function resetHandshakeLockTestSeams(): void {
  lockPath = undefined;
  timing = {
    staleMs: DEFAULT_STALE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `CLAUDISH_OP_LOCK_TRACE=1` → one stderr line per lock transition.
 *
 * The failure this guards against is invisible by construction: when the lock
 * silently does not engage, what you see is a denial — the exact symptom you
 * would see with no lock at all. Off by default, no overhead.
 */
function trace(message: string): void {
  if (process.env.CLAUDISH_OP_LOCK_TRACE !== "1") return;
  console.error(`[op-lock] pid=${process.pid} ${message}`);
}

/** `{ pid, at }` of the current holder, or null if unreadable/garbled. */
function readHolder(path: string): { pid: number; at: number } | null {
  try {
    const [pidRaw, atRaw] = readFileSync(path, "utf-8").trim().split(/\s+/);
    const pid = Number(pidRaw);
    const at = Number(atRaw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, at: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/**
 * Is `pid` still running? `kill(pid, 0)` sends no signal — it only asks the
 * kernel whether the process exists. EPERM means it exists but belongs to
 * someone else, which still counts as alive.
 */
function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** True when the lock file looks abandoned (dead holder, or wedged past staleMs). */
function isAbandoned(path: string): boolean {
  const holder = readHolder(path);
  if (!holder) {
    // Unreadable or garbled: fall back to file age alone.
    try {
      return Date.now() - statSync(path).mtimeMs > timing.staleMs;
    } catch {
      return false;
    }
  }
  if (holder.pid !== process.pid && !holderAlive(holder.pid)) return true;
  return Date.now() - holder.at > timing.staleMs;
}

/**
 * Take the lock, or return false if `timeoutMs` elapses first.
 *
 * NEVER THROWS. A filesystem this cannot write to (read-only HOME, exotic
 * container) must not break secret resolution — it degrades to unlocked, which
 * is exactly the pre-lock behaviour.
 */
async function acquire(path: string): Promise<boolean> {
  const deadline = Date.now() + timing.timeoutMs;
  let madeDir = false;
  for (;;) {
    try {
      if (!madeDir) {
        mkdirSync(dirname(path), { recursive: true });
        madeDir = true;
      }
      // "wx" = O_CREAT | O_EXCL: succeeds for exactly one process.
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${process.pid} ${Date.now()}`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false; // unwritable → degrade
      if (isAbandoned(path)) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* someone else got there first — just retry */
        }
        continue;
      }
      if (Date.now() >= deadline) return false;
      await sleep(timing.pollMs + Math.floor(Math.random() * timing.pollMs));
    }
  }
}

/** Drop the lock, but only if we still own it (never free someone else's). */
function release(path: string): void {
  try {
    if (readHolder(path)?.pid === process.pid) rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Run `handshake` under the cross-process lock.
 *
 * The lock is an OPTIMISATION OF WHEN, not a gate on WHETHER: on timeout or any
 * filesystem failure the handshake runs anyway, unlocked. Set
 * `CLAUDISH_NO_OP_HANDSHAKE_LOCK=1` to bypass it entirely.
 */
export async function withHandshakeLock<T>(handshake: () => Promise<T>): Promise<T> {
  if (process.env.CLAUDISH_NO_OP_HANDSHAKE_LOCK === "1") {
    trace("bypassed (CLAUDISH_NO_OP_HANDSHAKE_LOCK=1)");
    return handshake();
  }

  const path = currentLockPath();
  const t0 = Date.now();
  let held = false;
  try {
    held = await acquire(path);
  } catch {
    held = false;
  }
  trace(`${held ? "acquired" : "NOT held (timeout or unwritable)"} after ${Date.now() - t0}ms`);
  try {
    return await handshake();
  } finally {
    if (held) release(path);
    trace(`handshake done after ${Date.now() - t0}ms${held ? ", released" : ""}`);
  }
}
