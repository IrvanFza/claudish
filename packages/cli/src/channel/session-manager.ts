// ─── SessionManager ──────────────────────────────────────────────────────────
//
// Lifecycle owner for channel sessions. Each session is one `claudish` child
// spawned over plain pipes, driven by BIDIRECTIONAL stream-json:
//
//   parent ──{"type":"user",…}──▶ proc.stdin ─inherit─▶ claude's fd 0
//   parent ◀── NDJSON frames ──── proc.stdout ◀─inherit─ claude's fd 1
//
// There is no relay code in between. `claudish` is spawned WITHOUT `--stdin`, so
// nothing in it consumes fd 0, and it spawns `claude` with `stdio: "inherit"` —
// which means the pipe this file creates lands directly on the grandchild.
// Verified end to end on 2026-08-22 against claude 2.1.239 (see
// ai-docs/sessions/dev-feature-stream-json-*/probes/probe-argv.ts).
//
// What that buys, in order of how badly it was needed:
//   * progress that is real — the child declares its state instead of us
//     regex-matching TUI glyphs it never prints (see stream-json-reducer.ts)
//   * `send_input` that works — it has never worked before; the bytes used to
//     land in an already-satisfied stdin drain
//   * a terminal state that has to be earned — `result.terminal_reason` plus
//     `classifyRunOutput`, instead of "exit code 0 means success"
//   * real tokens and cost — `CLAUDISH_TOKEN_FILE` points the child's own token
//     tracker at this session's directory

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ENV } from "../config.js";
import { UPSTREAM_ERROR_LOG_ENV } from "../handlers/shared/upstream-error-capture.js";
import { KILL_PROCESS_GROUP, signalProcessTree, terminateChildTree } from "../process-tree.js";
import { redactSecrets } from "../redact.js";
import { transcriptPathFor } from "../session/session-discovery.js";
import { resolveClaudishSpawn } from "../spawn-claudish.js";
import {
  DRAIN_TIMEOUT_MS,
  STDOUT_TAIL_LIMIT,
  classifyRunOutput,
  meaningfulStderr,
} from "../team-orchestrator.js";
import { readTokenStatsAt } from "../team-stats.js";
import { ScrollbackBuffer } from "./scrollback-buffer.js";
import { type ResultSummary, StreamJsonReducer } from "./stream-json-reducer.js";
import type {
  ChannelEvent,
  SessionCreateOptions,
  SessionInfo,
  SessionManagerOptions,
  SessionStatus,
} from "./types.js";

/** One semantic frame, as `get_diagnostics` returns it. */
export interface DiagnosticEvent {
  /** When the frame was observed, ISO-8601. */
  at: string;
  /** `type[:subtype]` from the frame, or null for a line that carried no type. */
  label: string | null;
  /** The frame, redacted and truncated to `EVENT_PREVIEW_CHARS`. */
  preview: string;
  /** True when `preview` is a prefix rather than the whole frame. */
  truncated: boolean;
}

/** What `get_diagnostics` returns. Every field is reachable without a filesystem read. */
export interface SessionDiagnostics {
  sessionId: string;
  status: SessionStatus;
  /** The model as the caller asked for it. */
  model: string;
  /** The pinned `provider@model` the child was spawned with, or null. */
  spawnModel: string | null;
  exitCode: number | null;
  terminalReason: string | null;
  elapsedSeconds: number;
  /** The session's own timeout, for reading `elapsedSeconds` against. */
  timeoutSeconds: number;
  /** Bytes of recovered assistant PROSE. Zero on a session that produced no answer. */
  outputBytes: number;
  turnsCompleted: number;
  tokensUsed: number;
  costUsd: number;
  toolCallCount: number;
  /** Redacted, bounded stderr. See `stderrForDiagnostics` for which rule produced it. */
  stderrTail: string;
  /** True when benign boilerplate was dropped (success path only). */
  stderrFiltered: boolean;
  /** True when the in-memory stderr buffer dropped a middle section. */
  stderrTruncated: boolean;
  /** Illegal transitions and unparseable lines the reducer recorded. */
  anomalies: readonly string[];
  /** The tail of the semantic-frame ring, oldest → newest. */
  recentEvents: readonly DiagnosticEvent[];
  /** How many frames the ring holds (it caps at `EVENT_RING_SIZE`). */
  eventsTotal: number;
  /** Raw JSONL records from the child proxy's upstream-error capture, newest last. */
  upstreamErrors: readonly string[];
  claudeSessionId: string | null;
  transcriptPath: string | null;
  sessionDir: string;
  eventLogPath: string;
  upstreamErrorLogPath: string;
}

interface SessionEntry {
  info: SessionInfo;
  process: ChildProcess;
  /** Recovered assistant PROSE, one line per entry. What `get_output` returns. */
  scrollback: ScrollbackBuffer;
  reducer: StreamJsonReducer;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  killHandle: ReturnType<typeof setTimeout> | null;
  /** Bounds how long finalisation waits for the stdio pipes after `exit`. */
  drainHandle: ReturnType<typeof setTimeout> | null;
  /** Removes a terminal session from the map once its retention window is up. */
  evictHandle: ReturnType<typeof setTimeout> | null;
  /**
   * Head + tail of the child's stderr, bounded (see `boundStderr`).
   *
   * A chatty child used to grow this string without limit for the entire life
   * of the MCP server, and the sessions holding it were never evicted.
   */
  stderr: string;
  /** True once `stderr` has been truncated, so the record says so. */
  stderrTruncated: boolean;
  /** Statefully decodes stdout/stderr so a multi-byte char may span chunks. */
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  outputLogStream: ReturnType<typeof createWriteStream> | null;
  sessionDir: string;
  eventLogPath: string;
  /** Bytes already written to `events.jsonl`; the log stops at EVENT_LOG_LIMIT. */
  eventLogBytes: number;
  /**
   * `<sessionDir>/upstream-errors.jsonl` — where the child proxy's own
   * `captureUpstreamError` writes non-ok upstream bodies. See `createSession`.
   */
  upstreamErrorLogPath: string;
  /**
   * The last `EVENT_RING_SIZE` semantic frames, redacted and truncated.
   *
   * `events.jsonl` holds all of them, but it is capped at 4 MB and lives on
   * disk, and the whole point of Phase 3 is that a diagnosis must not require
   * reading the filesystem by hand. This is the in-API tail.
   */
  eventRing: DiagnosticEvent[];
  /** The directory the child was spawned in, before any realpath resolution. */
  cwd: string;
  /**
   * The `cwd + uuid` the current `info.transcriptPath` was derived from.
   *
   * `transcriptPathFor` does a `realpathSync`, and the refresh runs on every
   * `list_sessions` / `get_output` / `get_session`; this makes the syscall
   * happen only when one of its two inputs actually changed.
   */
  transcriptKey: string;
  /** The caller's timeout for this session, in seconds. Reported by getDiagnostics. */
  timeoutSeconds: number;
  /** Bytes and tail of recovered prose — the inputs `classifyRunOutput` measures. */
  proseBytes: number;
  proseTail: string;
  /**
   * Exit facts, recorded on `exit` and consumed by `finalize`.
   *
   * These are two different moments: `exit` fires BEFORE the stdout pipe
   * closes, so the verdict cannot be reached here. See `finalize`.
   */
  pendingExit: { code: number | null; signal: string | null; at: string } | null;
  openPipes: number;
  /** Finalisation runs exactly once, from whichever path gets there first. */
  finalized: boolean;
  /**
   * Close stdin on the first terminal `result`.
   *
   * True when `create_session` supplied a prompt (one-shot intent), false once
   * `send_input` is called (the caller has taken over). Without this a session
   * would never end on its own: stdin stays open by design, so the child sits
   * idle after answering until the hard timeout fires and the run is reported
   * as a failure it did not have.
   */
  autoCloseOnResult: boolean;
  stdinClosed: boolean;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_SCROLLBACK = 2000;
const DEFAULT_TIMEOUT = 600;
const MAX_TIMEOUT = 3600;
const KILL_GRACE_MS = 5000;

/**
 * How long a terminal session stays readable before it is dropped from the map.
 *
 * `maxSessions` bounds only ACTIVE sessions, so without this a long-lived MCP
 * server accumulates every finished session forever — each holding a 2 000-line
 * scrollback, a reducer and a stderr buffer. Long enough that an agent which
 * polls, gets `completed`, and then calls `get_output`/`get_diagnostics` always
 * finds the session; the artifacts on disk outlive it either way.
 */
const TERMINAL_RETENTION_MS = 30 * 60_000;

/** Hard ceiling on retained terminal sessions, whatever the retention window says. */
const MAX_TERMINAL_SESSIONS = 50;

/**
 * Cap on the in-memory stderr buffer: this many bytes of HEAD plus the same of TAIL.
 *
 * Both ends, not just a tail: the diagnostic that motivated all of this — the
 * 81-byte `[claude-code:unrecognized_model]` line — is emitted at STARTUP, so a
 * pure tail buffer is exactly the shape that would have lost it, while the
 * death rattle that explains a late failure only exists at the end.
 */
const STDERR_SIDE_LIMIT = 32 * 1024;

/**
 * Cap on `events.jsonl`. ~1.3 MB is a long real session (measured), so this is
 * roughly 3× the worst observed case and still bounded on a pathological stream.
 */
const EVENT_LOG_LIMIT = 4 * 1024 * 1024;

/**
 * How many semantic frames `get_diagnostics` can hand back, and how much of each.
 *
 * Bounded on both axes because this ring is held per session for the whole
 * retention window: 200 × 800 chars is ~160 KB at worst, ~8 MB across the
 * 50-session ceiling, and a single `tool_result` frame can be megabytes on its
 * own. A prefix is enough to identify a frame; `events.jsonl` has the whole of
 * it and `get_diagnostics` names that path.
 */
const EVENT_RING_SIZE = 200;
const EVENT_PREVIEW_CHARS = 800;

/** Default number of ring events returned when the caller names no limit. */
const DEFAULT_EVENT_LIMIT = 40;

/**
 * Bytes of `upstream-errors.jsonl` read back for diagnostics.
 *
 * Each record is bounded at ~2 KB by `MAX_CAPTURED_BODY_BYTES`, so this is the
 * last ~30 upstream failures — far more than any diagnosis needs, and a hard
 * bound on a file the child appends to on every failed request.
 */
const UPSTREAM_ERROR_TAIL_BYTES = 64 * 1024;

const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];

/**
 * The argv a channel child is spawned with.
 *
 * ORDER IS LOAD-BEARING, in two independent ways.
 *
 * 1. `--verbose` BEFORE `--quiet`. claudish consumes `--verbose`/`-v` as its OWN
 *    log-verbosity flag (cli.ts:344, it sets quiet=false) and SEPARATELY forwards
 *    a copy to the child `claude` (cli.ts:674), which hard-errors on
 *    `--print --output-format stream-json` without it. Putting `--verbose` first
 *    gets the forward while letting `--quiet` win claudish's own verbosity.
 *    Reversed, every child narrates itself onto stderr. Same rule, same reason,
 *    as team-orchestrator.ts:818-825.
 *
 * 2. `-p` must be followed by another FLAG. Unknown flags pass through to
 *    `claude` with their value, and the value rule is "the next token, if it does
 *    not start with `-`" (cli.ts:647). `-p` takes no value, so a non-flag after
 *    it would be swallowed. It also must be present at all: without it and
 *    without `--stdin`, cli.ts:667 sees no positional prompt and launches the
 *    interactive picker.
 *
 * `--session-id <uuid>` is last of the base args on purpose: it consumes exactly
 * one token, so whatever the caller appends afterwards is parsed fresh.
 */
export function buildChannelSpawnArgs(opts: {
  model: string;
  claudeSessionId: string;
  claudishFlags?: readonly string[];
}): string[] {
  return [
    "--model",
    opts.model,
    "-y",
    "--verbose",
    "--quiet",
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--replay-user-messages",
    "--session-id",
    opts.claudeSessionId,
    ...(opts.claudishFlags ?? []),
  ];
}

/**
 * Every other SPELLING claudish's own parser accepts for a flag the transport
 * sets. Sourced from `cli.ts`'s arg loop, not guessed:
 *
 *   `--model` / `-m`           cli.ts:263
 *   `--auto-approve` / `-y`    cli.ts:310
 *   `--quiet` / `-q`           cli.ts:338
 *   `--verbose` / `-v`         cli.ts:340
 *
 * `-v` is the one that mattered. The guard was built to stop a caller's
 * `--verbose` landing after our `--quiet` and flipping claudish's own log
 * verbosity (every child then narrates onto stderr) — and `-v` walked straight
 * past it into exactly that regression. `-p` is `claude`'s short `--print`; it
 * is not a claudish flag, so it is listed the other way round.
 */
const RESERVED_FLAG_ALIASES: Record<string, readonly string[]> = {
  "--model": ["-m"],
  "-y": ["--auto-approve"],
  "--quiet": ["-q"],
  "--verbose": ["-v"],
  "-p": ["--print"],
};

/**
 * Flags the transport does not pass but cannot survive.
 *
 * `--stdin` makes claudish consume fd 0 and wait for EOF, while this manager
 * holds stdin open waiting for a `result` — a circular wait that ends only at
 * the timeout.
 */
const TRANSPORT_BREAKING_FLAGS: readonly string[] = ["--stdin"];

/**
 * Flags the transport owns. A caller-supplied duplicate is REJECTED, not merged.
 *
 * DERIVED from `buildChannelSpawnArgs` rather than hand-listed, because the
 * hand-listed version drifted the moment it existed: it had `--verbose` but not
 * `-v`, and no `--model` at all, so the two most consequential collisions were
 * both accepted. Anything added to the spawn argv is now reserved automatically.
 *
 * `create_session`'s `claude_flags` are appended verbatim after the base args,
 * and the shared builder that produces them dedupes `--agent` against itself and
 * nothing else — it knows nothing about any one spawn site's base args. Claude
 * Code's precedence for a duplicate is UNMEASURED.
 *
 * Deliberately local rather than in the shared builder: the reserved set is a
 * property of THIS transport (team reserves fewer), and a shared denylist would
 * be wrong for both.
 */
const RESERVED_CHILD_FLAGS: readonly string[] = (() => {
  const reserved = new Set<string>(TRANSPORT_BREAKING_FLAGS);
  for (const token of buildChannelSpawnArgs({ model: "MODEL", claudeSessionId: "SESSION-ID" })) {
    if (!token.startsWith("-")) continue;
    reserved.add(token);
    for (const alias of RESERVED_FLAG_ALIASES[token] ?? []) reserved.add(alias);
  }
  return [...reserved];
})();

/**
 * Reject caller flags that collide with the transport's own.
 *
 * Loud on purpose. Silently appending the duplicate is the failure mode this
 * codebase keeps paying for — the effect shows up three layers away as garbled
 * output or a dropped answer, with nothing pointing back at the flag.
 *
 * The match is EXACT-TOKEN, never a prefix. `--print-argv`, `--model-opus`,
 * `--model-sonnet`, `--agents` (custom agent DEFINITIONS, unrelated to
 * `--agent`) are all real flags that a `startsWith` guard would eat. The
 * neighbouring `buildChildClaudeFlags` shipped both halves of that mistake at
 * once — too narrow on `--agent=value`, too wide on `--agents`.
 */
export function assertNoReservedFlags(flags: readonly string[] | undefined): void {
  if (!flags?.length) return;
  for (const flag of flags) {
    // Tolerate `--flag=value`; the collision is on the flag, not the spelling.
    // Long form only — `-v=x` is not a spelling claudish's parser accepts.
    const name =
      flag.startsWith("--") && flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
    if (RESERVED_CHILD_FLAGS.includes(name)) {
      throw new Error(
        `flag "${name}" is set by the channel transport and cannot be overridden. ` +
          "Channel sessions run the child over bidirectional stream-json; " +
          `${RESERVED_CHILD_FLAGS.join(", ")} are all part of that wire contract.`
      );
    }
  }
}

/**
 * Decode one stdio chunk, holding any partial multi-byte sequence for the next.
 *
 * A `data` chunk ends at the pipe's read boundary, which lands mid-codepoint
 * often enough to matter on any non-ASCII answer. `StringDecoder` keeps the
 * dangling bytes; `Buffer.toString` replaces them with U+FFFD. Strings are
 * passed through because a test can `emit("data", "…")` directly, and
 * `StringDecoder.write` only accepts a Buffer.
 */
function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

/**
 * The last `maxBytes` of a JSONL file, split into whole lines.
 *
 * A positioned tail read, never a whole-file read: `upstream-errors.jsonl` is
 * written by the CHILD on every failed request, so its size is not ours to
 * bound. A first partial line is dropped rather than returned mangled.
 *
 * Returns `[]` for a file that does not exist — which is the normal case, and
 * means the session had no non-ok upstream response.
 */
function readTailLines(path: string, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return [];
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString("utf-8").split("\n");
    // A read that began mid-file almost certainly began mid-line.
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    // Absent (the common case), unreadable, or racing a write. Diagnostics are
    // never load-bearing.
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** One turn, in the shape `--input-format stream-json` accepts. Measured, not guessed. */
export function userFrame(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private maxSessions: number;
  private scrollbackCapacity: number;
  private sessionsDir: string;
  private stallSeconds: number | undefined;
  private terminalRetentionMs: number;
  private onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  private sigintHandler: (() => void) | null = null;

  constructor(options?: SessionManagerOptions) {
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.scrollbackCapacity = options?.scrollbackCapacity ?? DEFAULT_SCROLLBACK;
    this.terminalRetentionMs = options?.terminalRetentionMs ?? TERMINAL_RETENTION_MS;
    this.sessionsDir =
      options?.sessionsDir ??
      process.env.CLAUDISH_SESSIONS_DIR ??
      join(homedir(), ".claudish", "sessions");
    this.stallSeconds = options?.stallSeconds;
    this.onStateChange = options?.onStateChange;
  }

  /** Create and start a new session. Returns the session ID. */
  createSession(opts: SessionCreateOptions): string {
    if (this.activeSessions >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }
    assertNoReservedFlags(opts.claudishFlags);

    const sessionId = randomUUID().slice(0, 8);
    // Minted here rather than discovered later: it is the child's transcript
    // filename under ~/.claude/projects/<slug>/, so knowing it BEFORE spawn
    // removes the cwd+mtime guessing a post-hoc search would need.
    const claudeSessionId = randomUUID();
    const timeout = Math.min(opts.timeoutSeconds ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const startedAt = new Date().toISOString();

    const sessionDir = join(this.sessionsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    if (opts.prompt) {
      writeFileSync(join(sessionDir, "prompt.md"), opts.prompt, "utf-8");
    }

    // `spawnModel` is the parent-resolved explicit "provider@model" spec when
    // routing was pinned; absent means spawn the caller's string. `info.model`
    // below deliberately keeps `opts.model` — the pin is argv-only.
    const args = buildChannelSpawnArgs({
      model: opts.spawnModel ?? opts.model,
      claudeSessionId,
      claudishFlags: opts.claudishFlags,
    });

    const tokenFile = join(sessionDir, "tokens.json");
    const eventLogPath = join(sessionDir, "events.jsonl");
    const upstreamErrorLogPath = join(sessionDir, "upstream-errors.jsonl");
    const cwd = opts.cwd ?? process.cwd();

    // Resolved rather than hardcoded so a test harness can point child spawns at
    // the tree under test — without it the suite exercises whatever claudish is
    // INSTALLED. Unset in production, where the result is exactly "claudish".
    const spawnTarget = resolveClaudishSpawn();
    const proc = spawn(spawnTarget.command, [...spawnTarget.prefixArgs, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Own process group, so cancel/timeout can signal the whole subtree.
      // `claudish` is a launcher → Bun CLI → `claude` → tools chain, and
      // signalling the pid we hold reaches only the launcher; the rest is
      // orphaned and keeps running (and billing). See process-tree.ts for the
      // measurement. This is what made `cancel_session`'s documented
      // "SIGTERM, then SIGKILL after 5 seconds" not actually stop the work.
      detached: KILL_PROCESS_GROUP,
      env: {
        ...process.env,
        // Point this child's token tracker at a path WE own. claudish IS the
        // proxy, so it sees every request and response: tokens, cost and tool
        // counts come from here rather than from parsing anything the child
        // prints. Without this line the child wrote to tokens-<its-own-port>.json
        // and nothing linked the two — which is why `tokensUsed` was hardcoded 0.
        [ENV.CLAUDISH_TOKEN_FILE]: tokenFile,
        // Un-no-op `captureUpstreamError` (handlers/composed-handler.ts).
        //
        // That capture is opt-in and this env var was never set for a channel
        // child, so it was a guaranteed no-op for every session here. Its own
        // comment says what that costs: `log()` only persists under `--debug`,
        // so the upstream body that distinguishes a retryable rate limit from a
        // hard quota wall is gone the moment it has been classified — and a
        // failure that already happened cannot be re-run with a flag. On the
        // two 900-second silent successes this is very likely the file that
        // would have ended the investigation.
        //
        // Set UNCONDITIONALLY, overriding any inherited value: the records carry
        // no session id, so a shared path interleaves up to 20 concurrent
        // sessions into one unattributable file — and `get_diagnostics`
        // publishes this exact path as the session's own.
        [UPSTREAM_ERROR_LOG_ENV]: upstreamErrorLogPath,
      },
    });

    const scrollback = new ScrollbackBuffer(this.scrollbackCapacity);
    const outputLogStream = createWriteStream(join(sessionDir, "output.log"));

    const entry: SessionEntry = {
      info: {
        sessionId,
        model: opts.model,
        spawnModel: opts.spawnModel ?? null,
        status: "starting",
        pid: proc.pid ?? null,
        startedAt,
        completedAt: null,
        exitCode: null,
        turnsCompleted: 0,
        tokensUsed: 0,
        elapsedSeconds: 0,
        costUsd: 0,
        toolCallCount: 0,
        terminalReason: null,
        claudeSessionId,
        // Derived from the spawn cwd now, and re-derived from the child's own
        // `system:init.cwd` if that turns out to differ. See refreshTranscriptPath.
        transcriptPath: transcriptPathFor(cwd, claudeSessionId),
      },
      process: proc,
      scrollback,
      // Assigned immediately below; the reducer's callback needs `entry`.
      reducer: undefined as unknown as StreamJsonReducer,
      timeoutHandle: null,
      killHandle: null,
      drainHandle: null,
      evictHandle: null,
      stderr: "",
      stderrTruncated: false,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      outputLogStream,
      sessionDir,
      eventLogPath,
      eventLogBytes: 0,
      upstreamErrorLogPath,
      eventRing: [],
      cwd,
      transcriptKey: `${cwd} ${claudeSessionId}`,
      timeoutSeconds: timeout,
      proseBytes: 0,
      proseTail: "",
      pendingExit: null,
      // stdout + stderr. Decremented on each pipe's `close`; finalisation waits
      // for zero (bounded) rather than trusting `exit`.
      openPipes: (proc.stdout ? 1 : 0) + (proc.stderr ? 1 : 0),
      finalized: false,
      autoCloseOnResult: Boolean(opts.prompt),
      stdinClosed: false,
    };

    entry.reducer = new StreamJsonReducer({
      sessionId,
      stallSeconds: this.stallSeconds,
      callback: (sid, data) => {
        const current = this.sessions.get(sid);
        if (!current) return;

        // One value, for the record and the wire alike. These used to diverge:
        // the timeout recorded `"timeout"` and emitted `"failed"`, because
        // EVENT_TO_TASK_STATUS had no `"timeout"` key and fell through to
        // `?? "working"` — reporting a dead session as alive. That key exists
        // now, so `ChannelEventType === SessionStatus` and the override is gone.
        current.info.status = data.newState;
        current.info.elapsedSeconds = this.getElapsed(current.info.startedAt);

        this.onStateChange?.(sid, {
          type: data.newState,
          model: current.info.model,
          content: data.content ?? "",
          elapsedSeconds: current.info.elapsedSeconds,
          createdAt: current.info.startedAt,
          extraMeta: {
            ...(data.toolName ? { tool: data.toolName } : {}),
            ...(data.toolCount ? { tool_count: String(data.toolCount) } : {}),
            ...(data.stalled ? { stalled: "true" } : {}),
          },
        });
      },
      onResult: (summary) => this.handleResult(sessionId, summary),
      onSemanticLine: (line, label) => this.recordEvent(entry, line, label),
    });

    this.sessions.set(sessionId, entry);

    // stdout → reducer → prose → scrollback + output.log.
    //
    // The RAW NDJSON deliberately does not reach either: `get_output` returns
    // prose (that is a wire-compatibility requirement), and the delta frames
    // would evict all 2 000 scrollback lines within seconds. The structured
    // record lives in events.jsonl.
    //
    // Decoded through a StringDecoder, NOT `chunk.toString()`: a `data` chunk
    // ends wherever the pipe's read boundary fell, which can be mid-codepoint.
    // `toString` turns those dangling bytes into U+FFFD before the reducer's
    // line reassembly ever sees them, so any CJK character or emoji straddling
    // a read boundary was permanently mangled in the answer an agent reads.
    // The decoder holds the partial sequence until the rest of it arrives.
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      const prose = entry.reducer.feed(decodeChunk(entry.stdoutDecoder, chunk));
      if (!prose) return;
      this.recordProse(entry, prose);
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      this.recordStderr(entry, decodeChunk(entry.stderrDecoder, chunk));
    });

    // `close` on each pipe is what finalisation actually waits for — see
    // `finalize`. Registered before the exit handler so the ordering is
    // explicit: whichever fires last does the work.
    proc.stdout?.on("close", () => this.onPipeClosed(sessionId));
    proc.stderr?.on("close", () => this.onPipeClosed(sessionId));

    // Without this, the first write to a child that has already exited raises an
    // unhandled 'error' on the stream and takes the whole MCP server with it —
    // and stdin now stays open across the session's entire life, so the window
    // is no longer a single write at startup.
    proc.stdin?.on("error", () => {
      entry.stdinClosed = true;
    });

    // The prompt is the opening frame, not a positional argument. stdin stays
    // OPEN: that is what makes `send_input` real, and closing it here is what
    // used to make a promptless session hang until the timeout.
    if (opts.prompt) {
      this.writeFrame(entry, opts.prompt);
    }

    proc.on("exit", (code, signal) => this.handleExit(sessionId, code, signal));

    // A spawn that never happened. This used to settle the reducer and stop —
    // leaking the output.log fd and both timers, and (because `exit` does not
    // follow a spawn `error`) writing no meta.json at all, so a session that
    // failed to start left NO on-disk record. Route it through the same
    // finalisation as every other ending.
    proc.on("error", (err) => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      current.pendingExit = { code: null, signal: null, at: new Date().toISOString() };
      current.info.completedAt = current.pendingExit.at;
      current.reducer.settle("failed", { content: `Spawn error: ${err.message}` });
      this.recordNote(current, `\n[claudish] spawn error: ${err.message}\n`);
      // Nothing to drain: the pipes of a process that never ran are already done.
      this.finalize(sessionId);
    });

    entry.timeoutHandle = setTimeout(() => {
      // `proc.killed` only means "a signal was SENT", so it is not a liveness
      // test — a child that ignored SIGTERM reads as killed while still
      // running. The exit/signal codes are the ones that mean "it is gone".
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      signalProcessTree(proc, "SIGTERM");
      entry.killHandle = setTimeout(() => {
        try {
          signalProcessTree(proc, "SIGKILL");
        } catch {
          // Process may already be gone
        }
      }, KILL_GRACE_MS);
      entry.killHandle.unref?.();

      entry.info.completedAt = new Date().toISOString();
      // `"timeout"` in the record AND on the wire. It used to be laundered into
      // `"failed"` because EVENT_TO_TASK_STATUS could not project it; now it can
      // (→ `failed`, SEP-1686's nearest member), so a consumer watching only the
      // channel can finally tell "ran out of time" from "errored".
      entry.reducer.settle("timeout", { content: `Timeout after ${timeout}s` });
    }, timeout * 1000);
    entry.timeoutHandle.unref?.();

    this.setupSigint();

    return sessionId;
  }

  /**
   * Send a turn to a running session.
   *
   * Writes a stream-json `user` frame — the same shape `create_session`'s prompt
   * takes. Under the old `--stdin` topology this wrote raw text into a drain the
   * child had already finished reading, so it silently did nothing; this is the
   * first version that reaches the model.
   */
  sendInput(sessionId: string, text: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (TERMINAL_STATUSES.includes(entry.info.status)) return false;
    if (entry.stdinClosed) return false;

    // The caller is driving now, so stop deciding when the session is finished.
    entry.autoCloseOnResult = false;
    return this.writeFrame(entry, text);
  }

  /** Get a session's recovered prose. */
  getOutput(
    sessionId: string,
    tailLines?: number
  ): {
    sessionId: string;
    status: SessionStatus;
    output: string;
    totalLines: number;
    turnsCompleted: number;
    tokensUsed: number;
    elapsedSeconds: number;
  } {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
    this.refreshAccounting(entry);

    const lines = entry.scrollback.getLines(tailLines);
    return {
      sessionId,
      status: entry.info.status,
      output: lines.join("\n"),
      totalLines: entry.scrollback.totalLines,
      turnsCompleted: entry.info.turnsCompleted,
      tokensUsed: entry.info.tokensUsed,
      elapsedSeconds: entry.info.elapsedSeconds,
    };
  }

  /**
   * Everything a post-mortem needs, from the API rather than the filesystem.
   *
   * This method is the whole point of Phase 3. The two 15-minute silent
   * successes produced exactly one diagnostic between them — an 81-byte
   * `[claude-code:unrecognized_model]` line in `stderr.log` — and NO MCP tool
   * returned it. Diagnosing them meant reading `~/.claudish/sessions/<id>/` by
   * hand, which an agent consuming the MCP interface has no reason to know
   * exists. A failure that has already happened cannot be re-run with `--debug`,
   * so everything here is captured unconditionally, during the run.
   */
  getDiagnostics(sessionId: string, eventLimit = DEFAULT_EVENT_LIMIT): SessionDiagnostics {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    this.refreshAccounting(entry);
    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);

    const limit = Math.max(0, Math.min(Math.trunc(eventLimit) || 0, EVENT_RING_SIZE));

    return {
      sessionId,
      status: entry.info.status,
      // The resolved chain, both halves. `model` is what the caller asked for
      // and is never rewritten; `spawnModel` is the pinned `provider@model` the
      // child was actually spawned with. Which provider served the request was
      // invisible from every tool before this, and it is the first thing a
      // routing failure needs.
      model: entry.info.model,
      spawnModel: entry.info.spawnModel,
      exitCode: entry.info.exitCode,
      terminalReason: entry.info.terminalReason,
      elapsedSeconds: entry.info.elapsedSeconds,
      timeoutSeconds: entry.timeoutSeconds,
      /** Recovered assistant PROSE, not raw stream bytes — see `recordProse`. */
      outputBytes: entry.proseBytes,
      turnsCompleted: entry.info.turnsCompleted,
      tokensUsed: entry.info.tokensUsed,
      costUsd: entry.info.costUsd,
      toolCallCount: entry.info.toolCallCount,
      ...this.stderrForDiagnostics(entry),
      anomalies: entry.reducer.anomalies,
      recentEvents: limit === 0 ? [] : entry.eventRing.slice(-limit),
      eventsTotal: entry.eventRing.length,
      upstreamErrors: readTailLines(entry.upstreamErrorLogPath, UPSTREAM_ERROR_TAIL_BYTES),
      claudeSessionId: entry.info.claudeSessionId,
      transcriptPath: entry.info.transcriptPath,
      sessionDir: entry.sessionDir,
      eventLogPath: entry.eventLogPath,
      upstreamErrorLogPath: entry.upstreamErrorLogPath,
    };
  }

  /**
   * The stderr an agent should see, and an honest flag saying which rule made it.
   *
   * `meaningfulStderr` deliberately DROPS `[claude-code:unrecognized_model]` as
   * benign boilerplate — normal for any proxied model, and noise on a healthy
   * run. But that single line was the ENTIRE content of the incident this tool
   * exists to explain, so filtering a failure would return an empty string for
   * the one case that motivated the work.
   *
   * team already draws this distinction and states it at
   * `team-orchestrator.ts:447-455`: the filter decides whether to write a
   * SUCCESS-path log, while a genuine failure persists the RAW stderr, because
   * there the boilerplate IS the context. Same rule here — filtered only for a
   * clean `completed`, raw for everything else.
   *
   * Redacted either way. `entry.stderr` is the unredacted in-memory buffer (only
   * the on-disk `stderr.log` was redacted before), so returning it verbatim
   * would hand provider key material straight into an agent's context.
   */
  private stderrForDiagnostics(entry: SessionEntry): {
    stderrTail: string;
    stderrFiltered: boolean;
    stderrTruncated: boolean;
  } {
    const filtered = entry.info.status === "completed";
    const source = filtered ? meaningfulStderr(entry.stderr) : entry.stderr;
    return {
      stderrTail: redactSecrets(source).slice(-STDOUT_TAIL_LIMIT),
      stderrFiltered: filtered,
      stderrTruncated: entry.stderrTruncated,
    };
  }

  /** Cancel a session. */
  cancelSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (TERMINAL_STATUSES.includes(entry.info.status)) return false;

    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (entry.killHandle) clearTimeout(entry.killHandle);

    entry.info.completedAt = new Date().toISOString();
    entry.reducer.settle("cancelled", { content: "Session cancelled" });

    // `killed` is "a signal was sent", not "it is gone" — see the timeout path.
    if (entry.process.exitCode === null && entry.process.signalCode === null) {
      signalProcessTree(entry.process, "SIGTERM");
      entry.killHandle = setTimeout(() => {
        try {
          signalProcessTree(entry.process, "SIGKILL");
        } catch {
          // Process may already be gone
        }
      }, KILL_GRACE_MS);
      entry.killHandle.unref?.();
    }

    return true;
  }

  /** List sessions. */
  listSessions(includeCompleted = false): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const entry of this.sessions.values()) {
      const isTerminal = TERMINAL_STATUSES.includes(entry.info.status);
      if (!includeCompleted && isTerminal) continue;
      if (!isTerminal) {
        entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
        this.refreshAccounting(entry);
      }
      sessions.push({ ...entry.info });
    }
    return sessions;
  }

  /** Get a single session's info. */
  getSession(sessionId: string): SessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
    this.refreshAccounting(entry);
    return { ...entry.info };
  }

  /**
   * Shut down all active sessions.
   *
   * Two things here were wrong in a way that orphaned billed work.
   *
   * 1. Liveness was `!proc.killed`. `signalProcessTree` sets `killed` the moment
   *    a signal is SENT, so a child that ignored SIGTERM — the only kind that
   *    needs escalating — read as already dead and was skipped entirely.
   * 2. The old code then cleared `entry.killHandle`, which is the pending
   *    SIGKILL a `cancelSession` five seconds earlier had scheduled. Cancelling
   *    the only escalation and skipping the kill left the detached process
   *    GROUP running: it keeps working, keeps billing, and nothing is left
   *    holding a handle to it.
   *
   * `terminateChildTree` is the escalation that replaces both: SIGTERM to the
   * group, wait, SIGKILL to the group, wait. The pending `killHandle` is only
   * cleared once that has actually run.
   */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [sessionId, entry] of this.sessions) {
      // Every session's timers, whether or not its process is still alive.
      // Before this there were ZERO dispose() call sites and every session
      // leaked its timers for the life of the server.
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
      if (entry.drainHandle) clearTimeout(entry.drainHandle);
      entry.drainHandle = null;
      if (entry.evictHandle) clearTimeout(entry.evictHandle);
      entry.evictHandle = null;

      const alive = entry.process.exitCode === null && entry.process.signalCode === null;
      if (alive) {
        // Record the verdict BEFORE disposing, or the exit that follows finds a
        // disposed reducer, settles nothing, and writes a meta.json still
        // claiming the session was running.
        entry.info.completedAt ??= new Date().toISOString();
        entry.reducer.settle("cancelled", { content: "Server shut down" });
        promises.push(
          terminateChildTree(entry.process, KILL_GRACE_MS).then(() => {
            if (entry.killHandle) clearTimeout(entry.killHandle);
            entry.killHandle = null;
            // Writes meta.json and disposes. Idempotent: the child's own exit
            // may have raced us here.
            this.finalize(sessionId);
          })
        );
        continue;
      }

      if (entry.killHandle) {
        clearTimeout(entry.killHandle);
        entry.killHandle = null;
      }
      entry.reducer.dispose();
    }
    await Promise.all(promises);
    this.cleanupSigint();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /** Append recovered prose to the scrollback, the tail, and output.log. */
  private recordProse(entry: SessionEntry, prose: string): void {
    entry.proseBytes += Buffer.byteLength(prose, "utf-8");
    entry.proseTail = (entry.proseTail + prose).slice(-STDOUT_TAIL_LIMIT);
    this.appendToOutput(entry, prose);
  }

  /**
   * Append a `[claudish] …` annotation of OUR OWN to the output.
   *
   * Deliberately not `recordProse`: `proseBytes` and `proseTail` are the measured
   * facts about what the CHILD produced. `classifyRunOutput` reads them to decide
   * whether a run had anything to show for itself, and `get_diagnostics` reports
   * `outputBytes` so a reader can see that a "completed" session answered with
   * nothing. Counting our own explanation of a failure as model output makes a
   * 0-byte session report 312 bytes — the diagnostic quietly falsifying the
   * metric it exists to explain. Measured; this is not hypothetical.
   */
  private recordNote(entry: SessionEntry, note: string): void {
    this.appendToOutput(entry, note);
  }

  private appendToOutput(entry: SessionEntry, text: string): void {
    entry.scrollback.append(text);
    entry.outputLogStream?.write(text);
  }

  private writeFrame(entry: SessionEntry, text: string): boolean {
    if (entry.stdinClosed) return false;
    try {
      entry.process.stdin?.write(userFrame(text));
      // A turn is now outstanding, so the PREVIOUS turn's `result` stops
      // counting as evidence that this session finished. See beginTurn().
      entry.reducer.beginTurn();
      return true;
    } catch {
      entry.stdinClosed = true;
      return false;
    }
  }

  /**
   * One semantic frame: into the in-memory ring AND onto `events.jsonl`.
   *
   * Redacted ONCE, here, and the same redacted string is used for both — these
   * frames carry `user` turns and `tool_result` blocks (`.env` contents, command
   * output, provider errors that echo key material), and both destinations are
   * handed to an agent by `get_diagnostics`. Same rule and same reason as team's
   * error log (team-orchestrator.ts:1070).
   */
  private recordEvent(entry: SessionEntry, line: string, label: string | null): void {
    const redacted = redactSecrets(line);
    const truncated = redacted.length > EVENT_PREVIEW_CHARS;

    // The ring is filled even after `events.jsonl` has hit its cap: the last
    // frames before a session died are exactly the ones a post-mortem wants,
    // and a capped FILE must not also blind the API.
    entry.eventRing.push({
      at: new Date().toISOString(),
      label,
      preview: truncated ? redacted.slice(0, EVENT_PREVIEW_CHARS) : redacted,
      truncated,
    });
    if (entry.eventRing.length > EVENT_RING_SIZE) entry.eventRing.shift();

    this.appendEventLog(entry, redacted);
  }

  /**
   * Append one already-redacted frame to `events.jsonl`.
   *
   * Bounded because a long interactive session or one large tool result would
   * otherwise grow the file without limit.
   */
  private appendEventLog(entry: SessionEntry, redactedLine: string): void {
    if (entry.eventLogBytes >= EVENT_LOG_LIMIT) return;
    const payload = `${redactedLine}\n`;
    entry.eventLogBytes += Buffer.byteLength(payload, "utf-8");
    const capped = entry.eventLogBytes >= EVENT_LOG_LIMIT;
    try {
      // Best-effort: a full disk must not take the session down with it.
      appendFileSync(
        entry.eventLogPath,
        capped
          ? `${payload}{"type":"claudish_truncated","limit_bytes":${EVENT_LOG_LIMIT}}\n`
          : payload
      );
    } catch {
      /* diagnostics are never load-bearing */
    }
  }

  /**
   * Accumulate the child's stderr, keeping the HEAD and the TAIL.
   *
   * Unbounded before: `entry.stderr += chunk` for the whole life of a session
   * that was itself never evicted. Keeping both ends rather than a tail is
   * deliberate — startup diagnostics (`[claude-code:unrecognized_model]`) are
   * at the head and the failure that killed a long run is at the end.
   */
  private recordStderr(entry: SessionEntry, chunk: string): void {
    if (!chunk) return;
    const combined = entry.stderr + chunk;
    if (combined.length <= STDERR_SIDE_LIMIT * 2) {
      entry.stderr = combined;
      return;
    }
    entry.stderrTruncated = true;
    entry.stderr =
      combined.slice(0, STDERR_SIDE_LIMIT) +
      `\n[claudish] … stderr truncated to ${STDERR_SIDE_LIMIT} bytes per end …\n` +
      combined.slice(-STDERR_SIDE_LIMIT);
  }

  /**
   * A turn ended. For a one-shot session that is also the end of the session:
   * close stdin, and the child exits 0 on its own (measured — see §3.2 of the
   * design). For an interactive one, stay in `waiting_for_input`.
   */
  private handleResult(sessionId: string, summary: ResultSummary): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.info.turnsCompleted = summary.numTurns || entry.info.turnsCompleted;
    entry.info.terminalReason = summary.terminalReason;

    if (!entry.autoCloseOnResult || entry.stdinClosed) return;
    entry.stdinClosed = true;
    try {
      entry.process.stdin?.end();
    } catch {
      /* the child may already be gone */
    }
  }

  /**
   * The child is gone. Record the FACTS; do not reach a verdict here.
   *
   * `exit` fires BEFORE the stdout pipe closes, and the terminal `result` frame
   * is by construction the LAST line the child writes — so it is precisely the
   * frame still in flight at this moment. Classifying here read `sawResult ===
   * false` on a session that had answered perfectly well and filed it as
   * "exited 0 without ever emitting a terminal `result` frame": a complete,
   * billed run reported as a failure, nondeterministically.
   *
   * `team` already paid for this exact lesson and encoded the fix — see the
   * comment above its own exit handler (team-orchestrator.ts ~1050): "exit
   * fires BEFORE the stdout pipe closes, and an answer flushed during shutdown
   * is still in flight at this moment — resolving here marked the run finished
   * with the byte count from KILL time … which is how a complete answer was
   * reported as 0 B". Same discipline here: `close` on the stdio pipes drives
   * finalisation, bounded by the same `DRAIN_TIMEOUT_MS` so a pipe some
   * descendant still holds degrades into a slightly-late verdict, not a hang.
   */
  private handleExit(sessionId: string, code: number | null, signal: string | null): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.pendingExit) return;

    entry.pendingExit = { code, signal, at: new Date().toISOString() };
    entry.stdinClosed = true;

    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
    if (entry.killHandle) clearTimeout(entry.killHandle);
    entry.killHandle = null;

    if (entry.openPipes <= 0) {
      this.finalize(sessionId);
      return;
    }
    entry.drainHandle = setTimeout(() => this.finalize(sessionId), DRAIN_TIMEOUT_MS);
    entry.drainHandle.unref?.();
  }

  /** One stdio pipe reached EOF. Finalise once both have, and the child is gone. */
  private onPipeClosed(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.openPipes--;
    if (entry.openPipes > 0) return;
    // A pipe can close before `exit` fires; the verdict still needs the code.
    if (!entry.pendingExit) return;
    this.finalize(sessionId);
  }

  /**
   * Reach the verdict, write the artifacts, release the session's resources.
   *
   * Runs exactly once, from whichever of the three paths gets here first: both
   * pipes drained after `exit`, the bounded drain timer, or a spawn `error`.
   */
  private finalize(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finalized) return;
    entry.finalized = true;

    this.clearTimers(entry);

    const { code, signal, at } = entry.pendingExit ?? {
      code: null,
      signal: null,
      at: new Date().toISOString(),
    };
    entry.info.exitCode = code;
    entry.info.completedAt = at;
    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
    entry.stdinClosed = true;

    this.flushDecoders(entry);

    // A timeout or a cancel has ALREADY decided how this session ended. The exit
    // that follows is a consequence of that decision, not a new verdict — and
    // letting it be one is exactly what turned a killed session into a
    // "completed" one. Report the exit; do not re-judge on it.
    const priorVerdict = TERMINAL_STATUSES.includes(entry.info.status) ? entry.info.status : null;
    const verdict = this.classifyExit(entry, code, signal);

    if (priorVerdict) {
      this.recordNote(
        entry,
        `\n[claudish] child exited (code=${code ?? "null"}, signal=${signal ?? "none"}) ` +
          `after the session was already recorded as ${priorVerdict}.\n`
      );
    } else if (verdict.state === "failed") {
      // The explanation goes into the SCROLLBACK, which is the field
      // `get_output` returns. A failed session whose only diagnostic sat in a
      // file nobody could reach is the exact shape of the bug this replaces.
      this.recordNote(entry, `\n[claudish] ${verdict.content}\n`);
    }
    // Absorbing terminal states mean this cannot upgrade a timeout or a cancel
    // that already ran — which is precisely what manufactured the false success.
    entry.reducer.settle(verdict.state, { content: verdict.content });

    this.writeArtifacts(entry);

    entry.reducer.dispose();
    this.scheduleEviction(entry);
    this.cleanupSigint();
  }

  /** Stop every timer a session owns. Safe to call more than once. */
  private clearTimers(entry: SessionEntry): void {
    if (entry.drainHandle) clearTimeout(entry.drainHandle);
    entry.drainHandle = null;
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
    if (entry.killHandle) clearTimeout(entry.killHandle);
    entry.killHandle = null;
  }

  /**
   * Flush whatever the stateful decoders and the reducer are still holding.
   *
   * A chunk that ended mid-codepoint leaves those bytes inside the decoder, and
   * a child killed mid-frame leaves an incomplete line inside the reducer. Both
   * are real answer text.
   */
  private flushDecoders(entry: SessionEntry): void {
    const decodedTail = entry.stdoutDecoder.end();
    if (decodedTail) {
      const prose = entry.reducer.feed(decodedTail);
      if (prose) this.recordProse(entry, prose);
    }
    this.recordStderr(entry, entry.stderrDecoder.end());

    const tail = entry.reducer.end();
    if (tail) this.recordProse(entry, tail);
  }

  /** Close output.log and write the two post-mortem files. */
  private writeArtifacts(entry: SessionEntry): void {
    entry.outputLogStream?.end();
    entry.outputLogStream = null;

    if (entry.stderr) {
      // Redacted before the bytes hit disk: provider stderr routinely echoes
      // key material and `get_diagnostics` hands this file's tail to an agent.
      writeFileSync(join(entry.sessionDir, "stderr.log"), redactSecrets(entry.stderr), "utf-8");
    }

    this.refreshAccounting(entry);
    entry.info.claudeSessionId = entry.reducer.claudeSessionId ?? entry.info.claudeSessionId;
    writeFileSync(
      join(entry.sessionDir, "meta.json"),
      JSON.stringify(entry.info, null, 2),
      "utf-8"
    );
  }

  /**
   * Drop a terminal session from the map after its retention window.
   *
   * `maxSessions` only counts ACTIVE sessions, so nothing used to remove a
   * finished one — there was not a single `sessions.delete` in this file, and a
   * long-lived MCP server grew a scrollback, a reducer and a stderr buffer per
   * session forever. The on-disk artifacts under `sessionDir` are unaffected;
   * this only bounds memory.
   */
  private scheduleEviction(entry: SessionEntry): void {
    if (entry.evictHandle) return;
    entry.evictHandle = setTimeout(() => {
      this.sessions.delete(entry.info.sessionId);
    }, this.terminalRetentionMs);
    // Never a reason for the MCP server to stay alive.
    entry.evictHandle.unref?.();
    this.evictOldestTerminal();
  }

  /** Enforce the hard ceiling, oldest terminal session first. */
  private evictOldestTerminal(): void {
    const terminal = [...this.sessions.values()].filter(
      (candidate) => candidate.finalized && TERMINAL_STATUSES.includes(candidate.info.status)
    );
    if (terminal.length <= MAX_TERMINAL_SESSIONS) return;

    terminal.sort((a, b) => (a.info.completedAt ?? "").localeCompare(b.info.completedAt ?? ""));
    for (const victim of terminal.slice(0, terminal.length - MAX_TERMINAL_SESSIONS)) {
      if (victim.evictHandle) clearTimeout(victim.evictHandle);
      this.sessions.delete(victim.info.sessionId);
    }
  }

  /**
   * Decide how the session ended. Exit 0 has to EARN `completed`.
   *
   * Three independent witnesses, in order of authority:
   *   1. the exit code / signal
   *   2. the child's own `result` frame — `is_error`, `api_error_status`,
   *      `terminal_reason`; and its ABSENCE, which means the child died before
   *      finishing a turn no matter what it exited with
   *   3. `classifyRunOutput`, the same "exit 0 with nothing to show for it"
   *      test `team` applies (empty output, API error text, background-task
   *      ceiling)
   */
  private classifyExit(
    entry: SessionEntry,
    code: number | null,
    signal: string | null
  ): { state: "completed" | "failed"; content: string } {
    const stderrNote = meaningfulStderr(entry.stderr) || entry.stderr.trim();
    const withStderr = (text: string): string =>
      stderrNote ? `${text} stderr: ${stderrNote.slice(-500)}` : text;

    if (signal) {
      return { state: "failed", content: withStderr(`Child terminated by ${signal}.`) };
    }
    if (code !== 0) {
      return {
        state: "failed",
        content: withStderr(`Child exited with code ${code ?? "unknown"}.`),
      };
    }

    if (!entry.reducer.sawResult) {
      return {
        state: "failed",
        content: withStderr(
          "Child exited 0 without ever emitting a terminal `result` frame — it died " +
            "before finishing a turn. This is the signature of a startup failure " +
            "(unroutable model, missing credential) rather than a completed run."
        ),
      };
    }
    if (entry.reducer.resultIsError || entry.reducer.apiErrorStatus !== null) {
      const status = entry.reducer.apiErrorStatus;
      return {
        state: "failed",
        content: withStderr(
          `Child reported an error turn (terminal_reason=${entry.reducer.terminalReason ?? "unknown"}` +
            `${status !== null ? `, api_error_status=${status}` : ""}).`
        ),
      };
    }

    const reason = classifyRunOutput({
      outputSize: entry.proseBytes,
      stdoutTail: entry.proseTail,
      stderr: entry.stderr,
      minOutputBytes: 0,
      captureMode: "stream-json",
    });
    if (reason) {
      return { state: "failed", content: withStderr(`${reason.reason}: ${reason.detail}`) };
    }

    return { state: "completed", content: "" };
  }

  /**
   * Refresh tokens / cost / tool counts from the proxy's own token file.
   *
   * The proxy is the authority here, not the child. `result.total_cost_usd`
   * prices every model at Anthropic's rates, so for a proxied model it is
   * fiction and for a subscription provider it invents spend that will never be
   * billed. The child's `result.usage` is a sound fallback for TOKENS only —
   * used when the token file does not exist yet, or when the run died before its
   * first response.
   */
  private refreshAccounting(entry: SessionEntry): void {
    const stats = readTokenStatsAt(join(entry.sessionDir, "tokens.json"));

    const fileTokens =
      (stats?.total_tokens ?? 0) || (stats?.input_tokens ?? 0) + (stats?.output_tokens ?? 0);
    entry.info.tokensUsed = fileTokens || entry.reducer.tokens;
    entry.info.costUsd = stats?.total_cost ?? 0;

    const fileToolCalls = Array.isArray(stats?.tool_calls)
      ? stats.tool_calls.reduce((sum, t) => sum + (typeof t.count === "number" ? t.count : 0), 0)
      : 0;
    entry.info.toolCallCount = fileToolCalls || entry.reducer.toolUseCount;

    if (entry.reducer.turns > 0) entry.info.turnsCompleted = entry.reducer.turns;
    entry.info.terminalReason = entry.reducer.terminalReason ?? entry.info.terminalReason;
    entry.info.claudeSessionId = entry.reducer.claudeSessionId ?? entry.info.claudeSessionId;
    this.refreshTranscriptPath(entry);
  }

  /**
   * Re-derive the transcript path when the child reports a cwd we did not spawn
   * with, and only then.
   *
   * `system:init.cwd` is the child's own answer and outranks ours: claudish may
   * resolve, normalise or be handed a `work_dir` that is not the directory
   * `claude` ends up in, and the transcript lands under the one `claude` used.
   * Guarded on a CHANGE because `transcriptPathFor` does a `realpathSync`, and
   * this runs on every `list_sessions` / `get_output` / `get_session` call.
   */
  private refreshTranscriptPath(entry: SessionEntry): void {
    const uuid = entry.info.claudeSessionId;
    if (!uuid) {
      entry.info.transcriptPath = null;
      return;
    }
    const cwd = entry.reducer.cwd ?? entry.cwd;
    const key = `${cwd} ${uuid}`;
    if (key === entry.transcriptKey) return;
    entry.transcriptKey = key;
    entry.info.transcriptPath = transcriptPathFor(cwd, uuid);
  }

  private get activeSessions(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (!TERMINAL_STATUSES.includes(entry.info.status)) count++;
    }
    return count;
  }

  private getElapsed(startedAt: string): number {
    return Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  }

  private setupSigint(): void {
    if (this.sigintHandler) return;
    this.sigintHandler = () => {
      this.shutdownAll().catch(() => {});
      process.exit(1);
    };
    process.on("SIGINT", this.sigintHandler);
  }

  private cleanupSigint(): void {
    if (this.activeSessions > 0) return;
    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
  }
}
