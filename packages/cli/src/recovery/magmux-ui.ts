/**
 * The recovery UI manager — the single owner of the socket, the pane, the
 * `paneOpen` fact, the post-`bye` suppression window, the cross-process lock
 * and the lease.
 *
 * OWNERSHIP IS PROCESS-SCOPED; ONLY EPISODES ARE EPISODE-SCOPED. There is ONE
 * pane and it multiplexes every episode, so "a pane exists" is a property of
 * this module and never of an episode. An earlier design hung `paneOpened` on
 * each episode, which meant the second concurrent episode could never be leased
 * — only the first one ever received an `open_pane` reply — and that closing
 * one episode tore down a socket a different episode's renderer was reading.
 * `releaseEpisodeUi` therefore emits one episode's `closed` frame and NOTHING
 * else; the socket and the pane come down only when no episode is live at all.
 *
 * THE LEASE IS THE WHOLE POINT OF THIS FILE. It is not a latch, not a config
 * read and not "a client connected":
 *
 *   uiLeaseValid(id)  ⇔  paneOpen (WE opened it, and hold the reply)
 *                     ∧  some client heartbeated `ack` naming THIS episode
 *                        within UI_LEASE_MS
 *
 * Both clauses are load-bearing. `paneOpen` is what a forged same-uid client
 * cannot manufacture, so it cannot talk the proxy into the one forbidden state
 * (a retryable status with no banner on screen). The heartbeat window is what
 * makes the lease self-clearing on EOF, on a killed pane, on a frozen renderer
 * and on `[q]`, with no cleanup path anyone has to remember.
 *
 * AND THE HEARTBEAT IS THE RENDERER'S, NOT OURS. The pane sends `ack` on its
 * own 1 Hz timer for as long as it is painting an episode, whether or not a
 * frame arrived. Renewing from frame receipts would tie the renderer's apparent
 * liveness to OUR emission cadence — and we have nothing to say for the 20–75 s
 * an unreachable connect takes (measured: `192.0.2.1` = 75 005 ms). The lease
 * would then read false at exhaustion for precisely the failure class this
 * feature exists for, with a live painted banner on screen, and every
 * loopback-only test would still pass.
 *
 * NOTHING HERE CHANGES A STATUS IN THIS PHASE. The lease is computed and
 * logged; the 503-vs-400 flip is the next one. Shipping the flip before the
 * banner exists recreates the buried-reason bug the feature is meant to kill.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { type Socket, connect as netConnect } from "node:net";
import { basename, join } from "node:path";
import { log } from "../logger.js";
import { recoveryClock } from "./clock.js";
import {
  type RecoveryOutcome,
  type RecoveryUiHooks,
  attemptsSoFar,
  episodeIsLive,
  giveUpAll,
  markPaneRequested,
  registerRecoveryUi,
  renderableEpisodeFrame,
  tryNow,
} from "./coordinator.js";
import {
  type RecoverySocketServer,
  cleanupRecoverySocket,
  createRecoverySocketDir,
  recoverySocketPathIn,
  startRecoverySocketServer,
} from "./socket-server.js";
import {
  PANE_LINGER_MS,
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryCommand,
  UI_LEASE_MS,
} from "./types.js";

/** After `[q]`, do not re-open a pane for this long. */
export const UI_SUPPRESS_AFTER_BYE_MS = 60_000;

// ─── The control endpoint ────────────────────────────────────────────────────

let explicitControlSock: string | null = null;

/**
 * The magmux control socket, handed in by the launch wrapper.
 *
 * AN EXPLICIT INPUT, NOT AN ENV LOOKUP, and that is the only thing that makes
 * this work at all: claudish is magmux's PARENT, and `MAGMUX_SOCK` is exported
 * DOWNWARD, so the parent can never learn a pid-derived path. The wrapper
 * generates `--id claudish-<pid>`, which fixes the path before magmux starts,
 * and hands it here.
 */
export function setMagmuxControlSocket(sock: string | null): void {
  explicitControlSock = sock;
}

/**
 * Where can this process send `open_pane` right now?
 *
 * Order: the path the wrapper handed us, then an ambient `MAGMUX_SOCK` (the
 * already-inside-a-pane case, e.g. `team --grid --mode interactive`), then null.
 *
 * IT ANSWERS A LAUNCH-ORDER QUESTION, NOT A USER PREFERENCE, and only this
 * module may read it. Null means "this process cannot open a pane" — true in
 * `-p`, in `serve`, in the MCP server, in every unwrapped launch and in the
 * whole test suite. It must never gate whether a RETRY happens: keying the
 * retry ladder on it made recovery skip universally in every phase before the
 * wrapper existed, twice, and both times the same rule decided the tests.
 */
export function resolveMagmuxControl(): { sock: string } | null {
  if (explicitControlSock && existsSync(explicitControlSock)) return { sock: explicitControlSock };
  const ambient = process.env.MAGMUX_SOCK;
  if (ambient && existsSync(ambient)) return { sock: ambient };
  return null;
}

// ─── Manager state ───────────────────────────────────────────────────────────

interface ManagerState {
  server: RecoverySocketServer | null;
  socketPath: string | null;
  control: Socket | null;
  /** True only once magmux has REPLIED to our `open_pane`. */
  paneOpen: boolean;
  /** magmux's own index for our pane. Read from the reply — never assumed. */
  paneIndex: number | null;
  /** episodeId → PROCESS ms of the last heartbeat naming it. */
  leases: Map<string, number>;
  /** PROCESS ms before which no pane may be opened (post-`bye`). */
  suppressUntilPerf: number;
  /** Guards the async open against re-entry. */
  opening: boolean;
  lockPath: string | null;
  lingerTimer: unknown | null;
  nextControlId: number;
}

const state: ManagerState = {
  server: null,
  socketPath: null,
  control: null,
  paneOpen: false,
  paneIndex: null,
  leases: new Map(),
  suppressUntilPerf: 0,
  opening: false,
  lockPath: null,
  lingerTimer: null,
  nextControlId: 1,
};

let installed = false;

// ─── The lease ───────────────────────────────────────────────────────────────

/**
 * Is a renderer painting this episode right now?
 *
 * Read LIVE at the moment a status is chosen. Never cached: by the time a
 * caller destructures a boolean off a result object, the pane it describes may
 * have been killed.
 */
export function uiLeaseValid(episodeId: string): boolean {
  if (!state.paneOpen) return false;
  const last = state.leases.get(episodeId);
  if (last === undefined) return false;
  return recoveryClock().now() - last <= UI_LEASE_MS;
}

/** Diagnostics for the log and for tests. Never used to decide anything. */
export function describeLease(episodeId: string): {
  paneOpen: boolean;
  lastAckAgoMs: number | null;
  valid: boolean;
} {
  const last = state.leases.get(episodeId);
  return {
    paneOpen: state.paneOpen,
    lastAckAgoMs: last === undefined ? null : Math.round(recoveryClock().now() - last),
    valid: uiLeaseValid(episodeId),
  };
}

// ─── The magmux control connection ───────────────────────────────────────────

async function connectControl(sock: string): Promise<Socket | null> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(sock);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  } catch {
    return null;
  }
}

/** Send one control message and wait for the `reply` carrying the same id. */
function request(
  socket: Socket,
  msg: Record<string, unknown>,
  timeoutMs = 3_000
): Promise<Record<string, unknown> | null> {
  const id = state.nextControlId++;
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      clearTimeout(timer);
      resolve(v);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === "reply" && evt.id === id) finish(evt);
        } catch {
          /* magmux emits live events on the same stream; ignore what is not ours */
        }
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    socket.on("data", onData);
    try {
      socket.write(`${JSON.stringify({ ...msg, id })}\n`);
    } catch {
      finish(null);
    }
  });
}

// ─── The cross-process single-pane lock ──────────────────────────────────────

/**
 * ONE recovery pane per magmux, not N.
 *
 * `team --grid --mode interactive` launches one claudish per pane and magmux
 * exports the same `MAGMUX_SOCK` to all of them, so one outage hits N processes
 * at once and a merely process-level singleton would open N panes into one
 * grid. The losers still run the ladder — they retry and they recover — they
 * just never open a pane, hold no lease, and answer the inline error at
 * exhaustion. That is honest: one banner names one slot's provider, and every
 * slot still recovers.
 */
function acquirePaneLock(controlSock: string): string | null {
  const lockPath = join("/tmp", `claudish-recovery-${basename(controlSock)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return lockPath;
    } catch {
      // Held — by a live peer, or by debris from one that was SIGKILLed.
      try {
        const owner = Number(readFileSync(lockPath, "utf-8").trim());
        if (Number.isFinite(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
            return null; // a live peer owns the banner
          } catch {
            unlinkSync(lockPath); // the owner is gone; the lock is debris
            continue;
          }
        }
        unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function releasePaneLock(): void {
  if (!state.lockPath) return;
  try {
    if (existsSync(state.lockPath)) {
      const owner = Number(readFileSync(state.lockPath, "utf-8").trim());
      if (owner === process.pid) unlinkSync(state.lockPath);
    }
  } catch {
    /* best effort */
  }
  state.lockPath = null;
}

// ─── The pane command line ───────────────────────────────────────────────────

/**
 * How to run `claudish recovery-pane` from wherever this build lives.
 *
 * Built from `process.argv` rather than from the name `claudish`, because the
 * process that must start is THIS build: a global install mid-update, a `bun
 * run src/index.ts` in a worktree and an npm-installed bundle are three
 * different files, and a pane from a different build is the version-skew case
 * the protocol has to print a notice for. `claudish` on PATH stays as the
 * fallback for a packaging shape neither argv entry describes.
 */
export function recoveryPaneCommandLine(socketPath: string): string {
  const script = process.argv[1];
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  if (script && (script.endsWith(".ts") || script.endsWith(".js") || script.endsWith(".cjs"))) {
    return `${q(process.execPath)} ${q(script)} recovery-pane --socket ${q(socketPath)}`;
  }
  return `claudish recovery-pane --socket ${q(socketPath)}`;
}

// ─── Opening and closing the pane ────────────────────────────────────────────

function onCommand(cmd: RecoveryCommand): void {
  switch (cmd.type) {
    case "hello":
      log(`[Recovery] pane connected (pid ${cmd.pid}, protocol ${cmd.protocol})`);
      break;
    case "ack": {
      // THE LEASE RENEWAL. Only here, and only from a renderer that painted.
      const first = !state.leases.has(cmd.episodeId);
      state.leases.set(cmd.episodeId, recoveryClock().now());
      if (first) {
        log(
          `[Recovery] pane is painting episode ${cmd.episodeId} — lease granted ` +
            `(paneOpen=${state.paneOpen})`
        );
      }
      break;
    }
    case "retry_now":
      if (episodeIsLive(cmd.episodeId)) {
        const n = attemptsSoFar(cmd.episodeId) + 1;
        log(`[Recovery] attempt ${n} (manual) for episode ${cmd.episodeId}`);
        tryNow(cmd.episodeId);
      }
      break;
    case "bye":
      log(`[Recovery] pane said bye (${cmd.reason}) — giving up on every live episode`);
      state.suppressUntilPerf = recoveryClock().now() + UI_SUPPRESS_AFTER_BYE_MS;
      giveUpAll();
      // The pane the user just closed must not reappear two seconds later, and
      // closing it is ALSO what revokes every lease: `teardown()` drops
      // `paneOpen`, and without that clause no heartbeat can grant anything.
      // One revocation path, not two — a second one is a second thing to
      // forget, and the superseded design's bug was exactly a revocation path
      // that existed on paper and cleared nothing.
      void closePane();
      break;
  }
}

async function openPane(): Promise<void> {
  const control = resolveMagmuxControl();
  if (!control) {
    log("[Recovery] no magmux control endpoint — no pane, recovery continues without a banner");
    return;
  }
  const lock = acquirePaneLock(control.sock);
  if (!lock) {
    log("[Recovery] another claudish already owns the recovery pane for this magmux");
    return;
  }
  state.lockPath = lock;

  const dir = createRecoverySocketDir();
  const socketPath = recoverySocketPathIn(dir);
  state.socketPath = socketPath;
  state.server = await startRecoverySocketServer({
    socketPath,
    snapshot: () => renderableEpisodeFrame(),
    onCommand,
    onDisconnect: () => {
      // EOF revokes nothing by itself — the lease expires on its own within
      // UI_LEASE_MS, and having exactly one expiry path means there is no
      // second one to forget. The retry loop is not the pane's business.
      log("[Recovery] pane disconnected");
    },
  });

  const socket = await connectControl(control.sock);
  if (!socket) {
    log(`[Recovery] could not reach magmux at ${control.sock}`);
    await teardown();
    return;
  }
  state.control = socket;
  socket.on("error", () => {
    state.paneOpen = false;
  });
  socket.on("close", () => {
    state.paneOpen = false;
  });

  const reply = await request(socket, {
    type: "open_pane",
    cmd: recoveryPaneCommandLine(socketPath),
    cwd: process.cwd(),
    split: "vertical",
  });
  if (!reply || reply.ok !== true) {
    log(`[Recovery] magmux refused open_pane: ${JSON.stringify(reply)}`);
    await teardown();
    return;
  }
  const result = reply.result as { pane?: number } | undefined;
  // Read the index back. magmux's own control panel occupies an index, so the
  // first pane an agent opens is NOT necessarily 1 — measured: 2.
  state.paneIndex = typeof result?.pane === "number" ? result.pane : null;
  state.paneOpen = true;
  log(`[Recovery] recovery pane opened (magmux pane ${state.paneIndex}) at ${socketPath}`);
}

async function closePane(): Promise<void> {
  if (state.control && state.paneIndex !== null) {
    await request(state.control, { type: "close_pane", pane: state.paneIndex, force: true }, 1_000);
  }
  await teardown();
}

async function teardown(): Promise<void> {
  state.paneOpen = false;
  state.paneIndex = null;
  state.leases.clear();
  if (state.control) {
    try {
      state.control.end();
    } catch {
      /* already gone */
    }
    state.control = null;
  }
  if (state.server) {
    await state.server.close();
    state.server = null;
  } else if (state.socketPath) {
    cleanupRecoverySocket(state.socketPath);
  }
  state.socketPath = null;
  releasePaneLock();
}

// ─── The hooks ───────────────────────────────────────────────────────────────

/**
 * Ask for a surface for this episode. Idempotent, and never awaited by the
 * retry loop — a pane that takes 200 ms to appear must not delay the first
 * retry by 200 ms.
 */
export function ensureRecoveryUi(episodeId: string): void {
  // Asking and being told no is still asking: the timestamp is what a later
  // phase's grace rule measures from, and it must be set even when the answer
  // is an immediate no.
  markPaneRequested(episodeId);
  if (state.lingerTimer !== null) {
    recoveryClock().clearTimeout(state.lingerTimer);
    state.lingerTimer = null;
  }
  if (state.paneOpen || state.opening) return;
  if (recoveryClock().now() < state.suppressUntilPerf) {
    log("[Recovery] pane suppressed — the user pressed [q] less than a minute ago");
    return;
  }
  state.opening = true;
  void openPane()
    .catch((err) => {
      log(`[Recovery] pane could not be opened: ${String(err)}`);
    })
    .finally(() => {
      state.opening = false;
    });
}

/**
 * One episode ended. Tell the renderer, and NOTHING else — a concurrent
 * episode may still be painting through the same socket and the same pane.
 */
export function releaseEpisodeUi(episodeId: string, outcome: RecoveryOutcome): void {
  state.leases.delete(episodeId);
  state.server?.broadcast({
    v: RECOVERY_PROTOCOL_VERSION,
    type: "closed",
    episodeId,
    outcome,
  });
  if (renderableEpisodeFrame() !== null) return; // something else is still live
  // Nothing left to paint. Linger, so the pane does not flap open and shut on
  // every client-retry cycle, and so the last thing that happened stays
  // readable for someone who looked away.
  if (state.lingerTimer !== null) recoveryClock().clearTimeout(state.lingerTimer);
  const clock = recoveryClock();
  const timer = clock.setTimeout(() => {
    state.lingerTimer = null;
    if (renderableEpisodeFrame() !== null) return;
    void closePane();
  }, PANE_LINGER_MS);
  clock.unref?.(timer);
  state.lingerTimer = timer;
}

const hooks: RecoveryUiHooks = {
  onEpisodeOpened: (episodeId) => ensureRecoveryUi(episodeId),
  onEpisodeClosed: (episodeId, outcome) => releaseEpisodeUi(episodeId, outcome),
  leaseValid: (episodeId) => uiLeaseValid(episodeId),
};

/**
 * Install the recovery UI into the coordinator.
 *
 * Called from exactly one place — the magmux launch wrapper, once it knows the
 * control socket. Every other entry point leaves it uninstalled, so `-p`,
 * `--stdin`, `serve`, the MCP server and the test suite cannot open a pane and
 * cannot hold a lease, without any of them having to opt out.
 */
export function installRecoveryUi(controlSock: string | null): void {
  setMagmuxControlSocket(controlSock);
  if (installed) return;
  installed = true;
  registerRecoveryUi(hooks);
  process.on("exit", () => {
    releasePaneLock();
    if (state.socketPath) cleanupRecoverySocket(state.socketPath);
  });
}

/** Tear everything down. Proxy shutdown, and tests. */
export async function shutdownRecoveryUi(): Promise<void> {
  if (state.lingerTimer !== null) {
    recoveryClock().clearTimeout(state.lingerTimer);
    state.lingerTimer = null;
  }
  await closePane();
  registerRecoveryUi(null);
  installed = false;
  state.suppressUntilPerf = 0;
  explicitControlSock = null;
}

/** Tests only: the manager is process state shared with every sibling test. */
export function __setPaneOpenForTests(open: boolean, socketPath?: string): void {
  state.paneOpen = open;
  if (socketPath !== undefined) state.socketPath = socketPath;
}

/** Tests only: feed a command as though a pane had sent it. */
export function __handleCommandForTests(cmd: RecoveryCommand): void {
  onCommand(cmd);
}

/** Tests only: forget every lease and every suppression. */
export function __resetUiStateForTests(): void {
  state.leases.clear();
  state.paneOpen = false;
  state.paneIndex = null;
  state.suppressUntilPerf = 0;
  state.opening = false;
  state.socketPath = null;
  state.server = null;
  state.control = null;
  if (state.lingerTimer !== null) {
    recoveryClock().clearTimeout(state.lingerTimer);
    state.lingerTimer = null;
  }
  releasePaneLock();
  explicitControlSock = null;
}
