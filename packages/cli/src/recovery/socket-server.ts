/**
 * The proxy half of the recovery link: an NDJSON server on a unix socket.
 *
 * WHY A SOCKET AND NOT THE MAGMUX CHANNEL. magmux's `send` writes KEYSTROKES
 * into a pane, and the receiving program reads them as user input. Using it as
 * a data bus would make the renderer parse one stream for both proxy state and
 * the user's `[r]`/`[q]` — two protocols on one fd, with this repo's own
 * paste-detection trap waiting at the bottom of it.
 *
 * WHY NOT A FILE. No poller exists to read one (`docs/usage/magmux.md`'s 500 ms
 * status-bar poller was removed in `168c814` and the docs were never
 * corrected), building one buys 500 ms granularity and whole-file rewrite
 * races, and decisively there is no upstream path for `[r] try now`.
 *
 * WHY `/tmp` AND NOT `~/.claudish`. macOS `sun_path` is 104 bytes, `$TMPDIR` on
 * macOS is `/var/folders/<28 chars>/T/`, and `~` is longer still for many
 * users. `/tmp` is also magmux's own convention for its control socket.
 *
 * WHAT THIS DEFENDS AND WHAT IT DOES NOT. The directory is 0700 with an
 * unguessable name and the socket is 0600, which excludes other uids. It is NOT
 * a boundary against a SAME-UID process and no unix socket can be: that process
 * can read our argv, read the pane's argv, or attach a debugger. Saying
 * otherwise would be theatre. What is defended is the consequence — a forged
 * client cannot manufacture the one forbidden state (a retryable status with no
 * banner), because the lease additionally requires that the proxy ITSELF opened
 * a pane, which is a fact no client can cause.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { dirname, join } from "node:path";
import { log } from "../logger.js";
import {
  FRAME_TICK_MS,
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryCommand,
  type RecoveryEpisodeFrame,
  type RecoveryFrame,
  encodeLine,
  parseCommand,
} from "./types.js";

export interface RecoverySocketClientHandle {
  readonly id: number;
  /** The pid the client claimed in its `hello`, once it has sent one. */
  pid: number | null;
  send(frame: RecoveryFrame): void;
  close(): void;
}

export interface RecoverySocketServerOptions {
  socketPath: string;
  /**
   * The frame a NEWLY CONNECTED client must see immediately, and the frame the
   * tick broadcasts. Null means there is nothing live to paint.
   *
   * REPLAY-ON-CONNECT is what makes a late pane correct rather than blank. The
   * pane starts roughly 100 ms after `open_pane` and the episode began before
   * that; without a replay its first paint would be empty until the next tick,
   * which is the first thing a user sees of this feature.
   */
  snapshot: () => RecoveryEpisodeFrame | null;
  onCommand: (cmd: RecoveryCommand, client: RecoverySocketClientHandle) => void;
  onDisconnect?: (client: RecoverySocketClientHandle) => void;
  /**
   * Broadcast cadence. A tick fires in EVERY live state, not only while
   * `waiting`: the banner has to say "connecting…" during a 45 s attempt, and
   * the pane's dead-proxy heuristic is frame silence, so a quiet `attempting`
   * phase would make a healthy proxy look dead to its own renderer.
   */
  tickMs?: number;
}

export interface RecoverySocketServer {
  readonly path: string;
  broadcast(frame: RecoveryFrame): void;
  clientCount(): number;
  close(): Promise<void>;
}

/**
 * A private directory for one process's recovery socket.
 *
 * The name carries 96 bits of randomness rather than the proxy port, which is
 * printed at startup and would make the path guessable — and while a same-uid
 * process can find it anyway, an unguessable name costs one line and removes
 * the only version of this that is trivially findable by something that is NOT
 * looking for us.
 */
export function createRecoverySocketDir(): string {
  const dir = join("/tmp", `claudish-recovery-${randomBytes(12).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

/** The socket path inside a directory from `createRecoverySocketDir()`. */
export function recoverySocketPathIn(dir: string): string {
  return join(dir, "r.sock");
}

/** Remove the socket and, if we made it, its private directory. Never throws. */
export function cleanupRecoverySocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* already gone */
  }
  try {
    const dir = dirname(socketPath);
    if (dir.startsWith("/tmp/claudish-recovery-")) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

export async function startRecoverySocketServer(
  opts: RecoverySocketServerOptions
): Promise<RecoverySocketServer> {
  const { socketPath } = opts;
  const tickMs = opts.tickMs ?? FRAME_TICK_MS;
  const clients = new Map<number, { socket: Socket; handle: RecoverySocketClientHandle }>();
  let nextId = 1;
  let closed = false;

  // A stale socket file from a SIGKILLed predecessor makes `listen` fail with
  // EADDRINUSE even though nothing is listening. The directory name is unique
  // per process, so anything already at this path is debris by construction.
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* best effort */
  }

  const server: Server = createServer((socket: Socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    const id = nextId++;
    const handle: RecoverySocketClientHandle = {
      id,
      pid: null,
      send(frame: RecoveryFrame) {
        if (socket.destroyed) return;
        try {
          socket.write(encodeLine(frame));
        } catch {
          /* the pane went away mid-write; the close handler cleans up */
        }
      },
      close() {
        try {
          socket.end();
        } catch {
          /* already gone */
        }
      },
    };
    clients.set(id, { socket, handle });

    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      // Bound the buffer. A client that never sends a newline must not be able
      // to grow the proxy's heap without limit.
      if (buf.length > 64 * 1024) buf = buf.slice(-1024);
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        const cmd = parseCommand(line);
        if (!cmd) continue;
        if (cmd.type === "hello") {
          handle.pid = typeof cmd.pid === "number" ? cmd.pid : null;
          if (cmd.protocol !== RECOVERY_PROTOCOL_VERSION) {
            // Tell it, then drop it. A renderer that cannot read our frames must
            // print one line about version skew rather than paint garbage.
            handle.send({
              v: RECOVERY_PROTOCOL_VERSION,
              type: "closed",
              episodeId: "",
              outcome: "protocol_mismatch",
            });
            handle.close();
            return;
          }
        }
        opts.onCommand(cmd, handle);
      }
    });

    const gone = () => {
      if (!clients.delete(id)) return;
      opts.onDisconnect?.(handle);
    };
    socket.on("error", gone);
    socket.on("close", gone);
    socket.on("end", gone);

    // REPLAY. Before anything else this client could possibly ask for.
    const current = opts.snapshot();
    if (current) handle.send(current);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* the 0700 directory is the real gate; a chmod failure does not open it */
  }

  let ticker: ReturnType<typeof setInterval> | null = null;
  if (tickMs > 0) {
    ticker = setInterval(() => {
      if (closed || clients.size === 0) return;
      const frame = opts.snapshot();
      if (!frame) return;
      for (const { handle } of clients.values()) handle.send(frame);
    }, tickMs);
    // The proxy must still be able to exit. A recovery ticker that holds the
    // event loop open would turn every recovered outage into a hung process.
    ticker.unref?.();
  }

  const onExit = () => {
    cleanupRecoverySocket(socketPath);
  };
  process.on("exit", onExit);

  log(`[Recovery] socket listening at ${socketPath}`);

  return {
    path: socketPath,
    broadcast(frame: RecoveryFrame) {
      if (closed) return;
      for (const { handle } of clients.values()) handle.send(frame);
    },
    clientCount: () => clients.size,
    async close() {
      if (closed) return;
      closed = true;
      if (ticker) clearInterval(ticker);
      for (const { socket } of clients.values()) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.removeListener("exit", onExit);
      cleanupRecoverySocket(socketPath);
    },
  };
}
