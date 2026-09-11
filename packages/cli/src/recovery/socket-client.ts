/**
 * The pane half of the recovery link.
 *
 * Shaped after `team-grid.ts`'s `subscribeToMagmux` — the same NDJSON framing,
 * the same tolerance of malformed lines, and above all the same CONNECT-RETRY
 * LOOP, because the socket appears asynchronously relative to the process that
 * dials it. There the race is magmux creating its socket after spawn; here it
 * is the pane starting ~100 ms after `open_pane` while the proxy is still
 * binding, or — in the normal case — long after. Either way a single
 * `connect()` that fails is indistinguishable from a proxy that is not coming,
 * and the difference is the whole user experience.
 */

import { existsSync } from "node:fs";
import { type Socket, connect as netConnect } from "node:net";
import {
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryCommand,
  type RecoveryFrame,
  encodeLine,
  parseFrame,
} from "./types.js";

export interface RecoverySocketClientOptions {
  socketPath: string;
  onFrame: (frame: RecoveryFrame) => void;
  /** The proxy hung up, or was never there. */
  onClose?: () => void;
  /** Total connect attempts before giving up. 40 × 50 ms ≈ 2 s, as in team-grid. */
  attempts?: number;
  retryDelayMs?: number;
}

export interface RecoverySocketClient {
  send(cmd: RecoveryCommand): void;
  close(): void;
  readonly connected: boolean;
}

/**
 * Dial the recovery socket, retrying while it does not yet exist.
 *
 * Resolves null when every attempt failed — the caller decides what to print.
 * It never throws: a pane that crashes on a missing socket replaces a banner
 * with a stack trace in the middle of the user's screen.
 */
export async function connectRecoverySocket(
  opts: RecoverySocketClientOptions
): Promise<RecoverySocketClient | null> {
  const attempts = opts.attempts ?? 40;
  const delay = opts.retryDelayMs ?? 50;
  let socket: Socket | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (existsSync(opts.socketPath)) {
      try {
        socket = await new Promise<Socket>((resolve, reject) => {
          const s = netConnect(opts.socketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch {
        /* not ready yet — the server binds after mkdir, so the file can exist
           for a few microseconds before anything is listening on it */
      }
    }
    await new Promise((r) => setTimeout(r, delay));
  }

  if (!socket) return null;

  const live = socket;
  let open = true;
  let buf = "";

  live.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    if (buf.length > 256 * 1024) buf = buf.slice(-4096);
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      const frame = parseFrame(line);
      if (frame) opts.onFrame(frame);
    }
  });

  const gone = () => {
    if (!open) return;
    open = false;
    opts.onClose?.();
  };
  live.on("error", gone);
  live.on("close", gone);
  live.on("end", gone);

  const client: RecoverySocketClient = {
    get connected() {
      return open;
    },
    send(cmd: RecoveryCommand) {
      if (!open || live.destroyed) return;
      try {
        live.write(encodeLine(cmd));
      } catch {
        /* the proxy went away; `gone` will fire */
      }
    },
    close() {
      open = false;
      try {
        live.end();
      } catch {
        /* already gone */
      }
    },
  };

  client.send({
    v: RECOVERY_PROTOCOL_VERSION,
    type: "hello",
    protocol: RECOVERY_PROTOCOL_VERSION,
    pid: process.pid,
  });

  return client;
}
