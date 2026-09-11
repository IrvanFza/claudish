/**
 * The recovery wire contract — the ONE module both processes import.
 *
 * It has no imports of its own, deliberately. The proxy links it into a Hono
 * request path that has already loaded the whole adapter stack; the pane links
 * it into a process whose entire job is to paint five lines and whose startup
 * cost is on the critical path of a user already having a bad minute. Anything
 * this file imported would be paid for twice, and the second time for nothing.
 *
 * FRAMES ARE FAT ON PURPOSE. Every `episode` frame carries the whole banner —
 * provider, host, endpoint, reason sentence, counters, the next-attempt instant
 * — rather than a delta or an id to look up. The pane has nothing to call back
 * to: there is no request/response direction from renderer to proxy beyond the
 * three commands below, and adding one would mean the banner could be blank
 * while a round trip was in flight. A frame is ~400 bytes at 1 Hz.
 *
 * EVERY TIMESTAMP ON THE WIRE IS EPOCH MS (`Date.now()`). The two processes
 * have different `performance.now()` origins, so a process-ms value would
 * render as an arbitrary number in the pane with no error anywhere. The rule
 * that makes this checkable: a field crossing this boundary is named `…AtMs`
 * and is epoch; a field used in an interval comparison is named `…AtPerf` and
 * never leaves its process.
 */

/**
 * Bumped when a frame or command changes shape incompatibly.
 *
 * Both processes are the same binary in practice, but not always: a
 * `team --grid` launches N claudish processes that may be different builds
 * against one magmux, and a global install can be mid-update. A mismatched
 * client is told so and prints one line, instead of rendering a banner with
 * fields it does not understand.
 */
export const RECOVERY_PROTOCOL_VERSION = 1;

/** The live states. `recovered`/`abandoned` arrive as a `closed` frame instead. */
export type RecoveryFrameState = "attempting" | "waiting" | "handoff";

export interface RecoveryEpisodeFrame {
  v: number;
  type: "episode";
  episodeId: string;
  state: RecoveryFrameState;
  /** DISPLAY ONLY — the highest tier any waiter in this episode has reached. */
  tier: 1 | 2;
  providerDisplayName: string;
  /** `chatgpt.com` — the host alone, for the banner's first line. */
  host: string;
  /** The endpoint that actually failed; the AUTH host on an auth-path failure. */
  endpoint: string;
  kind: "dns" | "refused" | "unreachable";
  code: string | null;
  loopback: boolean;
  /** `buildConnectionErrorMessage(...)` verbatim — the SAME sentence the inline 400 carries. */
  reason: string;
  attempts: number;
  clientRetries: number;
  /** EPOCH ms. */
  startedAtMs: number;
  /** EPOCH ms, or null while an attempt is actually in flight. */
  nextAttemptAtMs: number | null;
  lastOutcome: string;
  waiters: number;
  /** How many OTHER live episodes exist, so the banner can say `+N more`. */
  otherEpisodes: number;
}

export type RecoveryClosedOutcome =
  | "recovered"
  | "handoff"
  | "client_gone"
  | "gave_up"
  | "grace_expired"
  | "shutdown"
  | "protocol_mismatch";

export interface RecoveryClosedFrame {
  v: number;
  type: "closed";
  episodeId: string;
  outcome: RecoveryClosedOutcome;
}

export type RecoveryFrame = RecoveryEpisodeFrame | RecoveryClosedFrame;

/** Version negotiation only. It grants NOTHING — see `ack`. */
export interface RecoveryHelloCommand {
  v: number;
  type: "hello";
  protocol: number;
  pid: number;
}

/**
 * The lease heartbeat, and the single most consequential message in the
 * protocol.
 *
 * It is sent AFTER PAINTING, and then once per heartbeat interval for as long
 * as the renderer is still painting THIS `episodeId` — whether or not a frame
 * arrived in the meantime. It is not a frame receipt. Renewing the lease from
 * frame arrivals ties the renderer's apparent liveness to the PROXY's emission
 * cadence, and a connect against an unreachable host takes 20–75 s (measured:
 * `192.0.2.1` = 75 005 ms) during which the proxy has nothing new to say. The
 * lease would then be invalid at exhaustion for exactly the failure class this
 * feature exists for, with a live, painted banner on screen.
 */
export interface RecoveryAckCommand {
  v: number;
  type: "ack";
  episodeId: string;
  /** EPOCH ms of the paint this ack attests to. */
  paintedAt: number;
}

/** `[r]` — collapse the current wait. Ignored unless it names the live episode. */
export interface RecoveryRetryNowCommand {
  v: number;
  type: "retry_now";
  episodeId: string;
}

/** `[q]` — the user said stop. Every live episode gives up and answers inline. */
export interface RecoveryByeCommand {
  v: number;
  type: "bye";
  reason: string;
}

export type RecoveryCommand =
  | RecoveryHelloCommand
  | RecoveryAckCommand
  | RecoveryRetryNowCommand
  | RecoveryByeCommand;

/** One NDJSON line, newline included. */
export function encodeLine(value: RecoveryFrame | RecoveryCommand): string {
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse one NDJSON line into a frame, or null.
 *
 * Null for malformed JSON, for an unknown `type`, and for a `v` this build does
 * not speak — a reader that guesses at an unknown shape is how a version skew
 * becomes a rendering bug instead of a one-line notice.
 */
export function parseFrame(line: string): RecoveryFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== RECOVERY_PROTOCOL_VERSION) return null;
  if (parsed.type === "episode" && typeof parsed.episodeId === "string") {
    return parsed as unknown as RecoveryEpisodeFrame;
  }
  if (parsed.type === "closed" && typeof parsed.episodeId === "string") {
    return parsed as unknown as RecoveryClosedFrame;
  }
  return null;
}

/**
 * Parse one NDJSON line into a command.
 *
 * A `hello` with the WRONG protocol still parses — the server has to be able to
 * tell a mismatched client so, and it cannot do that if the message it needs to
 * answer is the one it drops. Every other command is version-gated.
 */
export function parseCommand(line: string): RecoveryCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type === "hello" && typeof parsed.protocol === "number") {
    return parsed as unknown as RecoveryHelloCommand;
  }
  if (parsed.v !== RECOVERY_PROTOCOL_VERSION) return null;
  if (parsed.type === "ack" && typeof parsed.episodeId === "string") {
    return parsed as unknown as RecoveryAckCommand;
  }
  if (parsed.type === "retry_now" && typeof parsed.episodeId === "string") {
    return parsed as unknown as RecoveryRetryNowCommand;
  }
  if (parsed.type === "bye") {
    return { v: RECOVERY_PROTOCOL_VERSION, type: "bye", reason: String(parsed.reason ?? "") };
  }
  return null;
}

// ─── Timings shared by both processes ────────────────────────────────────────

/**
 * A lease lives this long after the last heartbeat naming its episode.
 *
 * NEVER compare this against a per-attempt connect cap. They measure unrelated
 * things — one the renderer's liveness, the other a network ceiling — and the
 * whole fix for the round-2 CRITICAL is that they are independent.
 */
export const UI_LEASE_MS = 10_000;

/** The pane heartbeats this often while painting. 10× headroom under the lease. */
export const UI_HEARTBEAT_MS = 1_000;

/** The proxy emits an `episode` frame this often in EVERY live state. */
export const FRAME_TICK_MS = 1_000;

/**
 * No frame for this long and the pane says so.
 *
 * Strictly greater than `FRAME_TICK_MS` by enough to survive a scheduler hiccup
 * and a slow paint: the notice means "the proxy is gone", and saying that while
 * a healthy proxy is mid-connect is the symptom the every-live-state tick
 * exists to prevent.
 */
export const PROXY_SILENT_MS = 6_000;

/** Keep the pane up this long after the last episode ends, so it cannot flap. */
export const PANE_LINGER_MS = 30_000;
