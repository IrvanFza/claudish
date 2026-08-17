import { type ChildProcess, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type SpawnPlan, prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { KILL_PROCESS_GROUP, signalProcessTree, terminateChildTree } from "./process-tree.js";
import { redactSecrets } from "./redact.js";
import { resolveClaudishSpawn } from "./spawn-claudish.js";
import {
  readTokenStats,
  renderTeamStatsCompact,
  statsDir,
  tokenFileFor,
  writeStatusFile,
} from "./team-stats.js";
import { createAssistantTextCapture } from "./team-stream-capture.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamManifest {
  created: string;
  models: Record<string, { model: string; assignedAt: string }>;
  shuffleOrder: string[];
}

/**
 * Why a run is being reported as unusable.
 *
 * Exit code alone is a bad success oracle here: `claude -p` exits 0 on API
 * errors and on background-task termination just as it does on real success.
 * Classifying the failure means the caller never has to infer it from byte counts.
 */
export type FailureReason =
  | "nonzero_exit"
  | "timeout"
  | "api_error"
  | "background_task_ceiling"
  | "empty_output"
  | "shape_mismatch";

/**
 * How a child's answer is read off its stdout. See TeamRunOptions.captureMode.
 */
export type TeamCaptureMode = "stream-json" | "print";

/** Escape hatch, so `"print"` is reachable without editing a call site. */
export const TEAM_CAPTURE_ENV_VAR = "CLAUDISH_TEAM_CAPTURE";

/**
 * Resolve the capture mode: explicit option wins, then the env var, then
 * recovery-on by default.
 *
 * Only the exact string `"print"` opts out. Garbage resolves to the default
 * rather than throwing — a typo in an env var must not fail a whole team run,
 * and the safe direction is the one that keeps more of the answer.
 */
export function resolveCaptureMode(
  explicit: TeamCaptureMode | undefined,
  env: NodeJS.ProcessEnv = process.env
): TeamCaptureMode {
  if (explicit) return explicit;
  return env[TEAM_CAPTURE_ENV_VAR]?.trim().toLowerCase() === "print" ? "print" : "stream-json";
}

export interface ModelError {
  /** Model ID that failed (anonymized id used in the report). */
  model: string;
  /** The command that was run. */
  command: string;
  /** Failure classification. */
  reason: FailureReason;
  /** One-line human-readable explanation of `reason`. */
  detail: string;
  /** Tail of the captured stderr, if any. */
  stderrSnippet?: string;
  /** Tail of the captured stdout — the failure signal often lands here, not on stderr. */
  stdoutSnippet?: string;
  /** Path to the full error log file. */
  errorLogPath: string;
  /** Working directory the child ran in. */
  workDir: string;
}

/**
 * EMPTY = the child exited 0 but its stdout is not a usable answer (an API
 * error, a truncated preamble, or fewer than `minOutputBytes`). Distinct from
 * FAILED so callers can tell "the process broke" from "the process lied".
 */
export type ModelState = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "EMPTY";

export interface ModelStatus {
  state: ModelState;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  outputSize: number;
  /** Populated on FAILED/TIMEOUT/EMPTY with details for the failure report. */
  error?: ModelError;
}

export interface TeamStatus {
  startedAt: string;
  models: Record<string, ModelStatus>;
}

export interface TeamRunOptions {
  timeout?: number; // seconds, default 300
  claudeFlags?: string[]; // extra flags passed to child claudish
  onStatusChange?: (id: string, status: ModelStatus) => void;
  /**
   * Opt-in stub threshold: below this many stdout bytes an exit-0 run is
   * recorded EMPTY. Default 0 (off) — see DEFAULT_MIN_OUTPUT_BYTES for why.
   * Whitespace-only output is caught regardless of this setting.
   */
  minOutputBytes?: number;
  /**
   * Opt-in SHAPE contract: a JS regex source string the response must match, or
   * the run is recorded EMPTY with reason `shape_mismatch`.
   *
   * This is the only signal that catches a child which answered correctly and
   * then took one more turn. `claude -p` prints ONLY the final assistant
   * message, so any post-answer turn (a background Task completing, a
   * notification arriving) silently replaces the answer with an epilogue —
   * exit 0, no API error, real non-whitespace prose. Measured: two models
   * turned 7,743 and 4,737 output tokens into 250 B and 396 B of "the review
   * above stands", and both were reported `succeeded`.
   *
   * Byte counts cannot separate that from a legitimately short answer (a
   * measured 96 B reply is valid — see DEFAULT_MIN_OUTPUT_BYTES). A caller that
   * mandated an output shape, however, KNOWS what a complete answer looks like:
   * `team`'s prompts require a fenced ```vote block, so "```vote" is a precise
   * oracle where length is a guess.
   *
   * Matched against the FULL response, not the bounded tail.
   */
  requirePattern?: string;
  /**
   * How a child's answer is captured off its stdout. Default `"stream-json"`.
   *
   * - `"stream-json"` — children run under `--output-format stream-json` and
   *   the orchestrator concatenates every assistant text block. A child that
   *   answers and then takes one more turn keeps its answer.
   * - `"print"` — the pre-v7.50 raw pipe: whatever `claude -p` prints, which is
   *   ONLY the final assistant message. Kept as an escape hatch for diagnosing
   *   a capture problem by comparing the two, and reachable without a code
   *   change via `CLAUDISH_TEAM_CAPTURE=print`.
   *
   * `requirePattern` is worth keeping ON under `"stream-json"`: recovery fixes
   * answers that were LOST, not answers the model never shaped correctly.
   */
  captureMode?: TeamCaptureMode;
  /**
   * Called on a timer with a rendered, colourless progress block, and once more
   * when the run settles. Used to push live status somewhere a human can see it
   * (MCP channel notification, terminal, log).
   *
   * `phase` MUST be honoured by consumers that model session lifecycle: without
   * a terminal `"settled"` frame, a watcher sees only "running" forever and
   * never observes the run close.
   */
  onProgress?: (update: {
    rendered: string;
    phase: "running" | "settled";
    /** True when no model produced usable output. */
    allFailed: boolean;
  }) => void;
  /**
   * Max seconds between `onProgress` calls when NOTHING has changed. Default 60.
   *
   * This is a heartbeat, not a poll rate. Each frame renders as its own new line
   * in the client, so a fixed 5s tick on a 15-minute run would print ~180 lines of
   * near-identical text. Frames are emitted when a model's STATE changes (finishes,
   * fails, produces output); this interval only bounds how long a quiet run can go
   * without proving it is still alive.
   *
   * `status.txt` is rewritten on every internal poll regardless — it is a file, so
   * frequency costs nothing there.
   */
  heartbeatSeconds?: number;
  /** Spawn-plan factory seam for hermetic call-site tests. */
  spawnPlanner?: (models: (string | undefined)[]) => Promise<SpawnPlan>;
  /**
   * Extend the deadline for a model that is DEMONSTRABLY still working, rather
   * than killing it mid-answer. Default true.
   *
   * Why this is on by default. In `--quiet` print mode a child emits its answer
   * only at the very end, so a deadline that fires mid-generation destroys
   * 100% of the work — there is no partial result to keep. That is not
   * hypothetical: in session team-20260815-115227 grok-4.6 was killed at 900s
   * holding 0 B, having already spent $0.15 and 111k tokens, and finished a
   * complete 40,699 B answer 375s later. Terminating it correctly (which we now
   * do) would have destroyed that answer outright.
   *
   * So the deadline stops meaning "kill here" and starts meaning "here is where
   * I start checking whether this is still worth it". Progress is read from
   * `stats/<id>.json`, which the child's token tracker rewrites on every token
   * — real evidence of work, not a liveness ping.
   *
   * The cost is real and bounded: a run can take up to `timeout +
   * maxGraceSeconds` and bill for it. Set false for a hard wall-clock ceiling.
   */
  graceExtension?: boolean;
  /**
   * Cap on total extension per model, in seconds. Default: the run's `timeout`,
   * i.e. a model can take at most twice its deadline. Ignored when
   * `graceExtension` is false.
   */
  maxGraceSeconds?: number;
  /**
   * How long a model may show no measurable progress before it is considered
   * stalled and terminated despite `graceExtension`. Default 90.
   */
  stallSeconds?: number;
}

export interface TeamJudgeOptions {
  judges?: string[]; // models to use as judges (default: same models as runners)
  claudeFlags?: string[];
}

export interface VoteResult {
  judgeId: string;
  responseId: string;
  verdict: "APPROVE" | "REJECT" | "ABSTAIN";
  confidence: number;
  summary: string;
  keyIssues: string[];
}

export interface TeamVerdict {
  responses: Record<
    string,
    {
      approvals: number;
      rejections: number;
      abstentions: number;
      score: number; // approvals / (approvals + rejections)
    }
  >;
  ranking: string[]; // response IDs sorted by score descending
  votes: VoteResult[];
}

// ─── Output Classification ────────────────────────────────────────────────────

/**
 * How many trailing stdout bytes we retain per child for diagnosis. Bounded so a
 * 30 KB answer isn't buffered twice; exported-by-const so `classifyRunOutput`
 * knows when the tail it was handed is the complete output.
 */
export const STDOUT_TAIL_LIMIT = 4000;

/** Claude Code prints API failures into its stdout and still exits 0. */
const API_ERROR_RE = /\[API Error:\s*([^\]]{0,300})\]/i;

/**
 * Claude Code's print-mode background-task ceiling. When it fires, the turn is
 * terminated, whatever text was already emitted is flushed, and the exit code
 * is 0 — so the run looks successful while carrying only a partial answer.
 */
const BG_CEILING_RE = /Background tasks still running after (\d+)s; terminating/i;

/**
 * Stub threshold, OFF by default.
 *
 * An earlier default of 200 produced a 2/2 false-positive rate the first time it
 * met real short answers: two correct one-sentence replies (141 B and 96 B) were
 * both recorded EMPTY. Re-checking the three real failures that motivated the
 * threshold, none of them actually needs it — the 1-byte "\n" is whitespace-only,
 * and the 98-byte API error and 195-byte preamble are both caught by their
 * markers. So the byte threshold earned no unique detections while rejecting
 * valid output.
 *
 * Callers who KNOW their answers should be long (a multi-KB review) can opt in
 * via `minOutputBytes`. Whitespace-only output is always caught regardless.
 */
export const DEFAULT_MIN_OUTPUT_BYTES = 0;

/**
 * How long to wait, after a child is confirmed dead, for its stdout pipe to
 * close so the response file on disk is final.
 *
 * Bounded: the pipe can only stay open while some descendant still holds the
 * write end, and after a group SIGKILL that should be nobody. This exists so a
 * pathological case degrades into a slightly-stale read rather than a hang.
 */
export const DRAIN_TIMEOUT_MS = 10_000;

/** Default cadence of deadline re-checks once a run is in grace. */
export const GRACE_INTERVAL_MS = 60_000;

/** Default: no measurable progress for this long ⇒ stalled, terminate. */
export const DEFAULT_STALL_SECONDS = 90;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never hold the event loop open on a timer alone.
    t.unref?.();
  });

/* Process-tree termination lives in ./process-tree.ts — shared with the channel
   session manager, which had the identical orphaning bug in `cancel_session`. */

/**
 * Decide whether an exit-0 run actually produced an answer.
 * Returns null when the output looks usable.
 */
export function classifyRunOutput(opts: {
  outputSize: number;
  stdoutTail: string;
  stderr: string;
  minOutputBytes: number;
  /** Caller's shape contract (regex source). See TeamRunOptions.requirePattern. */
  requirePattern?: string;
  /**
   * The complete stdout, when the caller could read it back off disk.
   *
   * `stdoutTail` holds only the LAST STDOUT_TAIL_LIMIT bytes, so matching a
   * pattern against it would silently fail for any contract whose marker sits
   * near the START of a long answer. Falls back to the tail when absent, which
   * is exact whenever the tail IS the whole output.
   */
  fullOutput?: string;
  /**
   * How the answer was captured. Only changes the `shape_mismatch` EXPLANATION,
   * never the verdict: under `"print"` a missing marker is most likely an
   * answer that was discarded, while under `"stream-json"` every assistant
   * message was kept, so the model genuinely did not produce one. Pointing the
   * caller at the wrong one of those costs a wasted investigation.
   */
  captureMode?: TeamCaptureMode;
}): { reason: FailureReason; detail: string } | null {
  const {
    outputSize,
    stdoutTail,
    stderr,
    minOutputBytes,
    requirePattern,
    fullOutput,
    captureMode = "print",
  } = opts;

  const apiError = API_ERROR_RE.exec(stdoutTail);
  if (apiError) {
    return {
      reason: "api_error",
      detail: `Child exited 0 but stdout carries an API error: ${apiError[1]?.trim() || "unknown"}`,
    };
  }

  const bgCeiling = BG_CEILING_RE.exec(stderr);
  if (bgCeiling) {
    return {
      reason: "background_task_ceiling",
      detail:
        `Claude Code terminated the turn after ${bgCeiling[1]}s waiting on background tasks, ` +
        "flushing only partial output. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 in the child " +
        "environment to wait indefinitely, or tell the model not to spawn background work.",
    };
  }

  // Nothing but whitespace is never a real answer, at any threshold. This is
  // what actually catches the observed 1-byte "\n" run.
  //
  // Guarded on outputSize: `stdoutTail` holds only the LAST STDOUT_TAIL_LIMIT
  // bytes, so a large answer that happens to end in padding would otherwise be
  // misread as empty. Only trust the tail when it IS the whole output.
  const tailIsWholeOutput = outputSize <= STDOUT_TAIL_LIMIT;
  if (outputSize === 0 || (tailIsWholeOutput && stdoutTail.trim().length === 0)) {
    return {
      reason: "empty_output",
      detail: `Child exited 0 but produced no non-whitespace output (${outputSize} B).`,
    };
  }

  // Opt-in stub threshold. Off by default — see DEFAULT_MIN_OUTPUT_BYTES.
  if (minOutputBytes > 0 && outputSize < minOutputBytes) {
    return {
      reason: "empty_output",
      detail:
        `Child exited 0 but produced only ${outputSize} B of stdout ` +
        `(caller required at least ${minOutputBytes} B).`,
    };
  }

  // Shape contract, checked LAST: the structural failures above are cheaper and
  // give better detail, and a run that hit one of them would fail this too —
  // reporting "no ```vote block" for what is really an API error would send the
  // caller after the wrong problem.
  if (requirePattern) {
    const haystack = fullOutput ?? stdoutTail;
    let re: RegExp | null = null;
    try {
      re = new RegExp(requirePattern);
    } catch {
      // An unusable pattern must never fail a run that may be perfectly good.
      // runModels validates up front so the caller hears about it before any
      // model is spawned; this branch only guards a direct call.
      re = null;
    }
    if (re && !re.test(haystack)) {
      const cause =
        captureMode === "stream-json"
          ? "Every assistant message this child produced was captured and concatenated, " +
            "so this is not the print-mode dropout: the model genuinely never emitted the " +
            "required shape. Re-prompt it, or relax the contract."
          : "This is the signature of a child that answered and then took one more turn: " +
            "`claude -p` prints only the FINAL assistant message, so a background task " +
            "completing (or any late notification) replaces the real answer with an " +
            "epilogue about it. The answer was generated, it just was not the last thing " +
            "said — re-run with the default stream-json capture to keep it.";
      return {
        reason: "shape_mismatch",
        detail:
          `Child exited 0 with ${outputSize} B, but the response does not match the ` +
          `required pattern /${requirePattern}/. ${cause}`,
      };
    }
  }

  return null;
}

/**
 * stderr lines that every healthy child emits, and which say nothing about the
 * run's outcome.
 *
 * `unrecognized_model` is Claude Code telling itself it does not know the model
 * name claudish routed — which is the NORMAL case for a proxied model and is
 * emitted by runs that exit 0 with a perfect answer. In session
 * team-20260815-115227 all four successful models produced an ~80 B
 * `errors/NN.log` containing nothing else, so the run looked like it had four
 * errors it did not have, and a reader scanning for real failures had to open
 * each one to find out.
 *
 * Deliberately anchored on Claude Code's own `[claude-code:...]` tag rather than
 * on the model name, so it cannot accidentally swallow a provider's message.
 */
const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [/^\s*\[claude-code:unrecognized_model\]/];

/**
 * The part of stderr that is worth persisting — everything that is not known
 * boilerplate. Empty means "nothing happened worth a log file".
 *
 * NOTE this filters only what decides whether to WRITE a success-path log. A
 * genuine failure still persists the RAW stderr through `persistErrorLog`,
 * because in that case even the boilerplate is context for whoever is reading.
 */
export function meaningfulStderr(stderr: string): string {
  if (!stderr) return "";
  return stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((re) => re.test(line)))
    .join("\n")
    .trim();
}

/**
 * Write the full diagnostic log for a run.
 *
 * Always called on failure, so `errorLogPath` in the status report is never a
 * dangling reference — including for timeouts, whose stderr used to be dropped.
 *
 * Credentials are stripped BEFORE the bytes hit disk. Provider stderr routinely
 * echoes key material, and the team result card now names this path for the agent
 * to read — so an unredacted log is a credential handed straight into an agent's
 * context. Redacting at write time is the only point that covers every reader
 * (the agent, a human, `report_error`, a future consumer).
 */
function persistErrorLog(
  errorLogPath: string,
  header: string,
  stderr: string,
  stdoutTail: string
): void {
  const parts = [`=== ${redactSecrets(header)} ===`, ""];
  parts.push("--- stderr ---", stderr.trim() ? redactSecrets(stderr) : "(empty)", "");
  parts.push(
    "--- stdout (tail) ---",
    stdoutTail.trim() ? redactSecrets(stdoutTail) : "(empty)",
    ""
  );
  try {
    writeFileSync(errorLogPath, parts.join("\n"), "utf-8");
  } catch {
    // Diagnostics are best-effort — never let logging failure mask the real error.
  }
}

// ─── Path Validation ──────────────────────────────────────────────────────────

/**
 * Validate that sessionPath is within cwd (prevents path traversal in MCP tools).
 * Returns the resolved absolute path.
 */
export function validateSessionPath(sessionPath: string): string {
  const resolved = resolve(sessionPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
    throw new Error(`Session path must be within current directory: ${sessionPath}`);
  }
  return resolved;
}

// ─── Sentinel Model Validation ───────────────────────────────────────────────

/**
 * Model names that are semantic directives for the calling agent, not real
 * external model IDs. These must never be passed to claudish child processes.
 */
const SENTINEL_MODELS = new Set([
  "internal", // means "use a local Claude Code Task agent"
  "default", // means "use whatever Claude Code is configured with"
  "opus", // Claude tier selector — calling agent should handle
  "sonnet", // Claude tier selector — calling agent should handle
  "haiku", // Claude tier selector — calling agent should handle
]);

/**
 * Check if a model ID is a sentinel or native Anthropic model.
 * These cannot be run as external claudish processes.
 */
function isSentinelModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (SENTINEL_MODELS.has(lower)) return true;
  if (lower.startsWith("claude-")) return true;
  return false;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Setup a new team session.
 * Creates directory structure, writes input.md, generates a shuffled manifest.
 */
export function setupSession(sessionPath: string, models: string[], input?: string): TeamManifest {
  if (models.length === 0) {
    throw new Error("At least one model is required");
  }

  // Reject re-use of existing session directory to prevent overwriting results
  if (existsSync(join(sessionPath, "manifest.json"))) {
    throw new Error(
      `Session already exists at ${sessionPath}. Use a new directory path or delete the existing session first.`
    );
  }

  // Reject sentinel model names that should be handled by the calling agent
  const sentinels = models.filter(isSentinelModel);
  if (sentinels.length > 0) {
    throw new Error(
      `Invalid model(s) for team run: ${sentinels.join(", ")}. These are Claude Code agent selectors, not external model IDs. Use real external models (e.g., "gemini-2.0-flash", "gpt-4o", "or@deepseek/deepseek-r1"). For Claude models, use a Task agent instead of the team tool.`
    );
  }

  // Create directories
  mkdirSync(join(sessionPath, "work"), { recursive: true });
  mkdirSync(join(sessionPath, "errors"), { recursive: true });

  // Write input.md if provided, otherwise require it to already exist
  if (input !== undefined) {
    writeFileSync(join(sessionPath, "input.md"), input, "utf-8");
  } else if (!existsSync(join(sessionPath, "input.md"))) {
    throw new Error(`No input.md found at ${sessionPath} and no input provided`);
  }

  // Generate zero-padded numeric IDs to support >26 models: 01, 02, ..., 99
  const ids = models.map((_, i) => String(i + 1).padStart(2, "0"));
  const shuffled = fisherYatesShuffle([...ids]);

  // Build manifest — shuffled[i] is the anonymous ID for models[i]
  const now = new Date().toISOString();
  const manifest: TeamManifest = {
    created: now,
    models: {},
    shuffleOrder: shuffled,
  };

  for (let i = 0; i < models.length; i++) {
    const anonId = shuffled[i];
    manifest.models[anonId] = {
      model: models[i],
      assignedAt: now,
    };
    mkdirSync(join(sessionPath, "work", anonId), { recursive: true });
  }

  writeFileSync(join(sessionPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  // Initialize status.json with all models in PENDING state
  const status: TeamStatus = {
    startedAt: now,
    models: Object.fromEntries(
      Object.keys(manifest.models).map((id) => [
        id,
        {
          state: "PENDING" as const,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          outputSize: 0,
        },
      ])
    ),
  };
  writeFileSync(join(sessionPath, "status.json"), JSON.stringify(status, null, 2), "utf-8");

  return manifest;
}

/**
 * Fail fast on an unusable shape contract. Deliberately called BEFORE the
 * manifest read and the spawn loop: a bad regex discovered after N children
 * have run would either waste the whole run or, worse, be swallowed and
 * silently enforce nothing — which is the exact class of quiet failure this
 * option exists to remove.
 */
function assertValidRequirePattern(pattern: string | undefined): void {
  if (pattern === undefined) return;
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `Invalid requirePattern /${pattern}/: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Read the response back only when a shape contract needs the whole text —
 * otherwise this is pure cost on the happy path. Callers invoke this from
 * `finish`, which runs on the outputStream's "close", so the file is complete.
 *
 * Returns undefined when the read is unnecessary OR fails; the caller then
 * falls back to the tail, and a contract checked against less text can only
 * produce a false FAILURE, never a false success, with the detail string
 * naming the pattern either way.
 */
function readFullOutputIfNeeded(opts: {
  crashed: boolean;
  requirePattern: string | undefined;
  outputSize: number;
  outputPath: string;
}): string | undefined {
  const { crashed, requirePattern, outputSize, outputPath } = opts;
  if (crashed || !requirePattern || outputSize <= STDOUT_TAIL_LIMIT) return undefined;
  try {
    return readFileSync(outputPath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Run all models in parallel.
 * Each model reads input.md and writes response-{ID}.md.
 * Returns when all models complete or timeout.
 */
export async function runModels(
  sessionPath: string,
  opts: TeamRunOptions = {}
): Promise<TeamStatus> {
  const timeoutMs = (opts.timeout ?? 300) * 1000;

  assertValidRequirePattern(opts.requirePattern);

  const manifest: TeamManifest = JSON.parse(
    readFileSync(join(sessionPath, "manifest.json"), "utf-8")
  );
  const statusPath = join(sessionPath, "status.json");

  const inputPath = join(sessionPath, "input.md");
  const inputContent = readFileSync(inputPath, "utf-8");

  // Resolve every model's credential AND its route HERE, before the spawn loop
  // below fires N children at once. Each child would otherwise open its own
  // 1Password SDK client, and the desktop app authorizes exactly one of them and
  // denies the rest ("Denied authorization for SDK client") — silently losing
  // whichever models depend on 1Password rather than a shell env var. Resolving
  // in the parent write-throughs the keys into process.env, which the children
  // inherit, and the returned plan pins each bare name to an explicit
  // "provider@model" spec so the child never re-walks the chain (which is how a
  // hydrated child still reached 1Password). See auth/credentials/prehydrate.ts
  // for the measured repro.
  const spawnPlan = await (opts.spawnPlanner ?? prehydrateCredentialsForSpawn)(
    Object.values(manifest.models).map((m) => m.model)
  );

  // In-memory status cache to eliminate read-modify-write races
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));

  function updateModelStatus(id: string, update: Partial<ModelStatus>): void {
    statusCache.models[id] = { ...statusCache.models[id], ...update };
    writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
  }

  const minOutputBytes = opts.minOutputBytes ?? DEFAULT_MIN_OUTPUT_BYTES;
  const requirePattern = opts.requirePattern;
  const captureMode = resolveCaptureMode(opts.captureMode);

  /**
   * Re-judge a timed-out model once its stdout pipe has closed and the response
   * file is therefore final.
   *
   * A TIMEOUT is a statement about the CLOCK, not about the output. Those are
   * separate facts and the run reported only the first: a model killed at the
   * deadline was recorded `outputSize: 0` forever, even when a complete answer
   * landed microseconds later. Anything downstream that trusted the run's own
   * summary — the judging phase, a human, an orchestrating agent — discarded
   * real work.
   *
   * If the child did produce a usable answer, record it as COMPLETED and say
   * plainly that it arrived past the deadline. The file is on disk either way;
   * this only decides whether the run ADMITS to having it.
   */
  function reconcileTimedOutOutput(
    id: string,
    finalBytes: number,
    stdoutTail: string,
    stderr: string
  ): void {
    const current = statusCache.models[id];
    if (!current || current.state !== "TIMEOUT") return;
    if (finalBytes <= current.outputSize) return; // nothing new arrived

    const degraded = classifyRunOutput({
      outputSize: finalBytes,
      stdoutTail,
      stderr,
      minOutputBytes,
    });

    if (degraded) {
      // More bytes, but still not an answer (an API error, a preamble). Keep
      // TIMEOUT and just correct the byte count so the report is not a lie.
      updateModelStatus(id, { outputSize: finalBytes });
      return;
    }

    updateModelStatus(id, {
      state: "COMPLETED",
      outputSize: finalBytes,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    const note =
      `Recovered after the deadline: the child flushed ${finalBytes} B while shutting down, ` +
      "so its answer is complete and is being counted. The run still exceeded its timeout.";
    const rt = runtimes.get(id);
    if (rt) persistErrorLog(rt.errorLogPath, `RECOVERED: ${note}`, stderr, stdoutTail);
    opts.onStatusChange?.(id, statusCache.models[id]);
  }

  // Each child writes its token/cost stats here (one file per model).
  mkdirSync(statsDir(sessionPath), { recursive: true });

  const processes: Map<string, ChildProcess> = new Map();

  /**
   * Per-model diagnostic handles, readable from OUTSIDE the spawn closure.
   * The timeout handler lives outside that closure and previously had no way to
   * reach the child's stderr — which is why timed-out runs reported nothing.
   */
  interface ModelRuntime {
    command: string;
    errorLogPath: string;
    getStderr: () => string;
    getStdoutTail: () => string;
    getByteCount: () => number;
    /**
     * Drain any partially-received line into the byte count, tail, and response
     * file. A no-op under `"print"` capture, which counts raw bytes as they
     * arrive.
     *
     * Required by the TIMEOUT path. The stream-json capture holds an unterminated
     * line back until its newline arrives, so a child that wrote a partial line
     * and then hung would be reported as 0 B — destroying the one diagnostic the
     * timeout handler exists to provide. Deliberately does NOT close the write
     * stream: that would fire `finish()` while the status is still RUNNING and
     * race the run to COMPLETED.
     */
    flushPartial: () => void;
  }
  const runtimes: Map<string, ModelRuntime> = new Map();

  // SIGINT handler: kill all child processes on Ctrl+C.
  //
  // This is now LOAD-BEARING rather than a convenience. Children are spawned
  // detached, so they are no longer in the terminal's foreground process group
  // and Ctrl+C does not reach them on its own. Signal each group directly.
  //
  // Synchronous by necessity — `process.exit` runs immediately after, so there
  // is no opportunity to await a SIGKILL escalation. SIGTERM to the group is
  // enough here because the launcher now forwards it (see bin/claudish.cjs).
  const sigintHandler = () => {
    for (const [, proc] of processes) {
      signalProcessTree(proc, "SIGTERM");
    }
    process.exit(1);
  };
  process.on("SIGINT", sigintHandler);

  const completionPromises: Promise<void>[] = [];

  for (const [anonId, entry] of Object.entries(manifest.models)) {
    const outputPath = join(sessionPath, `response-${anonId}.md`);
    const errorLogPath = join(sessionPath, "errors", `${anonId}.log`);

    // Spawn with the parent-resolved explicit spec when there is one, so the
    // child skips routing entirely and finds its key in the inherited env.
    // ABSENT from the map is not an error — it means "spawn it bare", which is
    // exactly the pre-pinning behaviour. The manifest keeps `entry.model` (the
    // user's string) as the run's identity; only argv changes.
    const spawnModel = spawnPlan.pinned.get(entry.model) ?? entry.model;

    // CRITICAL FIX: do NOT use -p flag (-p means --profile in claudish)
    // --stdin triggers non-interactive single-shot mode
    //
    // ORDER IS LOAD-BEARING when recovery is on. claudish consumes --verbose as
    // its OWN log-verbosity flag (it sets quiet=false) and separately forwards a
    // copy to the child `claude`, which hard-errors on
    // `--print --output-format stream-json` without it. Putting --verbose BEFORE
    // --quiet gets the forward while letting --quiet win claudish's own
    // verbosity — reversed, every child would narrate itself onto stderr.
    // `--output-format stream-json` is an unknown flag to claudish and passes
    // through to `claude` with its value.
    const args = [
      "--model",
      spawnModel,
      "-y",
      "--stdin",
      ...(captureMode === "stream-json"
        ? ["--verbose", "--quiet", "--output-format", "stream-json"]
        : ["--quiet"]),
      ...(opts.claudeFlags ?? []),
    ];

    updateModelStatus(anonId, {
      state: "RUNNING",
      startedAt: new Date().toISOString(),
    });

    // See session-manager: resolved so a harness can spawn the tree under test
    // instead of the installed binary. Unset in production → plain "claudish".
    const teamSpawnTarget = resolveClaudishSpawn();
    const proc = spawn(teamSpawnTarget.command, [...teamSpawnTarget.prefixArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Each child leads its OWN process group, so we can signal the whole
      // subtree with `process.kill(-pid)`.
      //
      // `claudish` is a tree, not a process: the bin is a Node launcher that
      // runs the real CLI under Bun, which spawns `claude`, which spawns its
      // own tools and MCP servers. Signalling the direct child alone reaches
      // only the launcher — measured 2026-08-15, both SIGTERM and SIGKILL to
      // the pid left the Bun process alive and still holding the write end of
      // the pipe feeding `response-<id>.md`, which is how a run declared
      // TIMEOUT with 0 B gained a complete 40,699 B answer six minutes later.
      // Only the group kill was clean.
      //
      // Trade-off: a detached child no longer receives the terminal's Ctrl+C
      // (that goes to the foreground group, which the child has just left), so
      // the SIGINT handler below MUST kill the groups explicitly. It also means
      // an orchestrator that dies without running its handlers leaves children
      // behind — the same exposure as before this change, not a new one.
      detached: KILL_PROCESS_GROUP,
      env: {
        ...process.env,
        // Point this child's token tracker at a path WE choose, so its
        // tokens/cost can be attributed back to this model. Without this the
        // child writes to tokens-<its-own-port>.json and nothing links the two.
        CLAUDISH_TOKEN_FILE: tokenFileFor(sessionPath, anonId),
      },
    });

    // Count bytes flowing through stdout for accurate outputSize tracking
    let byteCount = 0;
    // Bounded tail of stdout. Claude Code writes "[API Error: ...]" to stdout
    // and still exits 0, so the failure signal is often here rather than on
    // stderr. Bounded so a 30 KB answer doesn't get buffered twice.
    let stdoutTail = "";

    const outputStream = createWriteStream(outputPath);

    /** See ModelRuntime.flushPartial. Reassigned below when recovery is on. */
    let flushPartial: () => void = () => {};

    if (captureMode === "print") {
      // Legacy path: whatever `claude -p` printed, byte for byte.
      proc.stdout?.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        stdoutTail = (stdoutTail + chunk.toString()).slice(-STDOUT_TAIL_LIMIT);
      });
      // Stream stdout to disk via pipe — no memory buffering
      proc.stdout?.pipe(outputStream);
    } else {
      // Recovery path. The child's stdout is a stream-json event log, so the
      // ANSWER has to be extracted from it rather than piped through.
      //
      // byteCount and stdoutTail are deliberately fed the RECOVERED prose, not
      // the raw JSON. Every downstream consumer — the empty check, the
      // minOutputBytes threshold, the [API Error:] match, the reported
      // outputSize — is asking about the answer, and raw JSON bytes would
      // inflate all of them (an empty answer wrapped in events is still
      // kilobytes). Feeding recovered prose keeps `classifyRunOutput`
      // completely unaware that the wire format changed.
      const capture = createAssistantTextCapture();

      const absorb = (text: string): void => {
        if (text.length === 0) return;
        byteCount += Buffer.byteLength(text);
        stdoutTail = (stdoutTail + text).slice(-STDOUT_TAIL_LIMIT);
        outputStream.write(text);
      };

      proc.stdout?.on("data", (chunk: Buffer) => absorb(capture.write(chunk.toString())));

      // `capture.end()` is idempotent, so the timeout path draining early does
      // not disturb the normal finalisation below.
      flushPartial = () => absorb(capture.end());

      // The write stream is ours to close now that nothing pipes into it, and
      // `finish()` hangs off its "close". Both events are wired because "end"
      // does not fire on a destroyed stream (a killed or timed-out child), and
      // a run that never resolves is worse than one that resolves empty.
      let captureFinalized = false;
      const finalizeCapture = (): void => {
        if (captureFinalized) return;
        captureFinalized = true;
        absorb(capture.end());
        outputStream.end();
      };
      proc.stdout?.on("end", finalizeCapture);
      proc.stdout?.on("close", finalizeCapture);
    }

    // Collect stderr for error logging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const command = `claudish ${args.join(" ")}`;
    runtimes.set(anonId, {
      command,
      errorLogPath,
      getStderr: () => stderr,
      getStdoutTail: () => stdoutTail,
      getByteCount: () => byteCount,
      flushPartial: () => flushPartial(),
    });

    // Pipe input to stdin
    proc.stdin?.write(inputContent);
    proc.stdin?.end();

    const completionPromise = new Promise<void>((resolve) => {
      let exitCode: number | null = null;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        // The timeout handler may have fired between proc "exit" and
        // outputStream "close". Don't clobber TIMEOUT — but do RECONCILE.
        //
        // Reaching here means the stdout pipe has closed, so `response-<id>.md`
        // is final and `byteCount` is its true size. A child killed at the
        // deadline can still have flushed a complete answer in the window
        // between the signal and the pipe closing, and the old code threw that
        // away: it recorded whatever byte count existed at KILL time (0 B for a
        // `--quiet` child, which emits only at the end) and never looked again.
        // The judging phase then scored a real answer as an empty submission.
        if (statusCache.models[anonId].state === "TIMEOUT") {
          resolved = true;
          reconcileTimedOutOutput(anonId, byteCount, stdoutTail, stderr);
          resolve();
          return;
        }
        resolved = true;

        const outputSize = byteCount;

        // A non-zero exit is an outright failure. A zero exit still has to earn
        // it: `claude -p` exits 0 on API errors and on background-task
        // termination, so exit code alone would file both as success.
        const crashed = exitCode !== 0;
        const fullOutput = readFullOutputIfNeeded({
          crashed,
          requirePattern,
          outputSize,
          outputPath,
        });
        const degraded = crashed
          ? null
          : classifyRunOutput({
              outputSize,
              stdoutTail,
              stderr,
              minOutputBytes,
              requirePattern,
              fullOutput,
              captureMode,
            });

        const failed = crashed || degraded !== null;
        const state: ModelState = crashed ? "FAILED" : degraded ? "EMPTY" : "COMPLETED";

        if (failed) {
          const reason: FailureReason = crashed ? "nonzero_exit" : degraded!.reason;
          const detail = crashed ? `Child exited with code ${exitCode}.` : degraded!.detail;

          persistErrorLog(errorLogPath, `${state}: ${detail}`, stderr, stdoutTail);

          updateModelStatus(anonId, {
            state,
            exitCode: exitCode ?? 1,
            completedAt: new Date().toISOString(),
            outputSize,
            error: {
              model: anonId,
              command,
              reason,
              detail,
              // Redacted: these land in status.json on disk and are read back
              // by anything inspecting the run.
              stderrSnippet: stderr ? redactSecrets(stderr).slice(-2000) : undefined,
              stdoutSnippet: stdoutTail ? redactSecrets(stdoutTail).slice(-2000) : undefined,
              errorLogPath,
              workDir: sessionPath,
            },
          });
        } else {
          updateModelStatus(anonId, {
            state,
            exitCode: exitCode ?? 0,
            completedAt: new Date().toISOString(),
            outputSize,
            error: undefined,
          });
        }

        opts.onStatusChange?.(anonId, statusCache.models[anonId]);
        resolve();
      };

      // "close" always fires after the stream ends or errors — single resolution point
      outputStream.on("close", finish);

      proc.on("exit", (code) => {
        const timedOut = statusCache.models[anonId]?.state === "TIMEOUT";

        // On TIMEOUT this handler must NOT settle the promise. "exit" fires
        // BEFORE the stdout pipe closes, and an answer flushed during shutdown
        // is still in flight at this moment — resolving here marked the run
        // finished with the byte count from KILL time and made the later
        // "close" a no-op, which is how a complete answer was reported as 0 B
        // and judged as an empty submission. Let "close" drive finish(), which
        // re-measures. `runModels` bounds the wait, so a pipe that never closes
        // degrades to a stale read rather than a hang.
        //
        // Still guard the error log: persistErrorLog has just written the
        // TIMEOUT diagnostics there and a raw stderr dump would erase them.
        // Only write a log when there is something worth reading. Every healthy
        // child emits Claude Code's `unrecognized_model` line — normal for a
        // proxied model — and writing it produced an `errors/NN.log` for runs
        // that had no error at all, which is exactly the noise that hides a real
        // one. `finish()` still writes the full log on any genuine failure.
        if (!timedOut && meaningfulStderr(stderr)) {
          // Redacted like every other persistence point — provider stderr can
          // echo key material and this file is read by agents.
          writeFileSync(errorLogPath, redactSecrets(stderr), "utf-8");
        }

        exitCode = code;
        // If the stream already closed before exit fired, finish immediately
        if (outputStream.destroyed) {
          finish();
        }
        // Otherwise wait for outputStream "close" to call finish()
      });
    });

    processes.set(anonId, proc);
    completionPromises.push(completionPromise);
  }

  // ── Live progress ─────────────────────────────────────────────────────────
  // Children in --quiet print mode emit nothing until they finish, so without a
  // poll there is no signal at all between "started" and "done".
  //
  // Two different cadences, deliberately:
  //   · status.txt   — rewritten every poll. It is a file; frequency is free.
  //   · onProgress   — only when the run's state actually CHANGES, plus a slow
  //                    heartbeat. Each frame renders as its own new line in the
  //                    client, so a fixed short tick would bury the transcript
  //                    in near-identical rows (a 15-min run at 5s = ~180 lines).
  const runStartedMs = Date.now();
  const POLL_MS = 2000;
  const heartbeatMs = (opts.heartbeatSeconds ?? 60) * 1000;

  let lastSignature = "";
  let lastEmitMs = 0;

  /**
   * What "changed" means for emission purposes.
   *
   * EXCLUDES elapsed time — otherwise every poll differs and the dedupe never
   * suppresses anything.
   *
   * EXCLUDES raw token counts too. Tokens tick continuously while a model
   * streams, so keying on them re-creates the spam this dedupe exists to stop.
   * Token totals still ride along on whatever frame does get emitted, and the
   * heartbeat guarantees they refresh on a quiet run.
   */
  const stateSignature = (): string =>
    Object.entries(statusCache.models)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, m]) => `${id}:${m.state}:${m.outputSize}`)
      .join("|");

  const emitProgress = (phase: "running" | "settled" = "running"): void => {
    const elapsedSeconds = (Date.now() - runStartedMs) / 1000;
    writeStatusFile(sessionPath, manifest, statusCache, { elapsedSeconds });
    if (!opts.onProgress) return;

    const signature = stateSignature();
    const changed = signature !== lastSignature;
    const heartbeatDue = Date.now() - lastEmitMs >= heartbeatMs;
    // A settled run must always emit — it is the terminal frame.
    if (phase !== "settled" && !changed && !heartbeatDue) return;

    lastSignature = signature;
    lastEmitMs = Date.now();

    try {
      const models = Object.values(statusCache.models);
      opts.onProgress({
        rendered: renderTeamStatsCompact(sessionPath, manifest, statusCache, { elapsedSeconds }),
        phase,
        allFailed: models.length > 0 && models.every((m) => m.state !== "COMPLETED"),
      });
    } catch {
      // A progress consumer must never be able to fail the run.
    }
  };

  emitProgress(); // one immediately, so status.txt exists from the start
  const progressHandle = setInterval(() => emitProgress("running"), POLL_MS);
  // Don't hold the event loop open on the ticker alone.
  progressHandle.unref?.();

  // ── Deadline enforcement ──────────────────────────────────────────────────
  //
  // Three things happen here that used to be one, and conflating them is what
  // lost a paid-for answer:
  //
  //   1. DECIDE whether the deadline should actually end this model. A child
  //      that is demonstrably still working gets bounded extra time instead of
  //      being killed mid-answer — in --quiet mode a mid-generation kill
  //      destroys 100% of the work, since nothing is emitted until the end.
  //   2. TERMINATE for real. `proc.kill()` reaches only the launcher; the tree
  //      below it survives and keeps the response pipe open. Kill the group and
  //      escalate to SIGKILL.
  //   3. WAIT for the pipe to close before returning, so `response-<id>.md` is
  //      final when the judging phase reads it. Previously `runModels` returned
  //      the instant the deadline fired, and judging read a file that a very
  //      much alive child was still writing.

  const graceEnabled = opts.graceExtension ?? true;
  const maxGraceMs = Math.max(0, (opts.maxGraceSeconds ?? timeoutMs / 1000) * 1000);
  const stallMs = Math.max(0, (opts.stallSeconds ?? DEFAULT_STALL_SECONDS) * 1000);

  /**
   * Milliseconds since this model last did measurable work, or `null` when
   * there is NO evidence either way.
   *
   * Read from `stats/<id>.json`, which the child's own token tracker rewrites.
   * Every one of those writes is driven by token usage — there is no periodic
   * heartbeat — so `updated_at` moving means tokens actually flowed. That is
   * what proved the grok-4.6 run was working rather than hung at the moment it
   * was killed.
   *
   * `null` is deliberately NOT treated as progress. Grace is granted on
   * positive evidence only; absence of evidence buys a model nothing, or a
   * child that never writes a stats file would earn an extension for doing
   * nothing at all.
   */
  const idleMsFor = (id: string): number | null => {
    const s = readTokenStats(sessionPath, id);
    if (!s || typeof s.updated_at !== "number" || s.updated_at <= 0) return null;
    return Math.max(0, Date.now() - s.updated_at);
  };

  /**
   * When each model first entered grace. Grace is accounted in REAL elapsed
   * time, not in nominal steps: the watcher re-checks far more often than it
   * extends, so counting "one 60s grant per round" would consume a 60s budget
   * in a handful of seconds and terminate a model that had barely been given
   * anything.
   */
  const graceStartedAt = new Map<string, number>();
  const graceUsedMs = (id: string, now: number): number => {
    const start = graceStartedAt.get(id);
    return start === undefined ? 0 : Math.max(0, now - start);
  };

  const runningIds = (): string[] =>
    [...processes.keys()].filter((id) => statusCache.models[id]?.state === "RUNNING");

  /** Terminate one model's tree and record the TIMEOUT verdict. */
  const timeoutModel = async (id: string, why: string): Promise<void> => {
    const proc = processes.get(id);
    if (!proc || statusCache.models[id]?.state !== "RUNNING") return;

    // Capture diagnostics BEFORE the status flips to TIMEOUT — the exit handler
    // reconciles rather than re-reports, so this is the only chance to persist
    // what the child said.
    const rt = runtimes.get(id);
    // Drain a half-received line first, or everything below reports 0 B for a
    // child that was mid-sentence when the clock ran out.
    rt?.flushPartial();
    const stderr = rt?.getStderr() ?? "";
    const stdoutTail = rt?.getStdoutTail() ?? "";
    const bytes = rt?.getByteCount() ?? 0;
    const grace = graceUsedMs(id, Date.now());
    const detail =
      `Killed by the orchestrator after ${(timeoutMs + grace) / 1000}s ` +
      `(deadline ${timeoutMs / 1000}s${grace ? ` + ${grace / 1000}s grace` : ""}) ` +
      `with ${bytes} B of stdout — ${why}. ` +
      "That figure counts the ANSWER, not the wire format, so 0 B means the child had " +
      `not produced an assistant message yet — "did not finish", not "produced nothing".`;

    if (rt) persistErrorLog(rt.errorLogPath, `TIMEOUT: ${detail}`, stderr, stdoutTail);

    updateModelStatus(id, {
      state: "TIMEOUT",
      completedAt: new Date().toISOString(),
      outputSize: bytes,
      error: rt
        ? {
            model: id,
            command: rt.command,
            reason: "timeout",
            detail,
            stderrSnippet: stderr ? redactSecrets(stderr).slice(-2000) : undefined,
            stdoutSnippet: stdoutTail ? redactSecrets(stdoutTail).slice(-2000) : undefined,
            errorLogPath: rt.errorLogPath,
            workDir: sessionPath,
          }
        : undefined,
    });
    opts.onStatusChange?.(id, statusCache.models[id]);

    // Enforce it. A model reported dead must actually be dead — otherwise it
    // keeps billing and keeps writing into a session the run considers closed.
    const stopped = await terminateChildTree(proc);
    if (!stopped) {
      persistErrorLog(
        rt?.errorLogPath ?? join(sessionPath, "errors", `${id}.log`),
        "TIMEOUT: child survived SIGKILL — it may still be running and billing",
        stderr,
        stdoutTail
      );
    }
  };

  const allDone = Promise.all(completionPromises);
  let settled = false;
  void allDone.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  const deadlineWatcher = (async (): Promise<void> => {
    await delay(timeoutMs);

    for (;;) {
      if (settled) return;
      const running = runningIds();
      if (running.length === 0) return;

      const extended: string[] = [];
      const now = Date.now();

      for (const id of running) {
        const idleMs = idleMsFor(id);
        const usedGrace = graceUsedMs(id, now);

        if (!graceEnabled) {
          await timeoutModel(id, "deadline reached (grace extension disabled)");
        } else if (usedGrace >= maxGraceMs) {
          await timeoutModel(
            id,
            `grace exhausted after ${Math.round(usedGrace / 1000)}s of extra time`
          );
        } else if (idleMs === null) {
          await timeoutModel(id, "deadline reached with no measurable progress to extend for");
        } else if (idleMs >= stallMs) {
          await timeoutModel(id, `no measurable progress for ${Math.round(idleMs / 1000)}s`);
        } else {
          if (!graceStartedAt.has(id)) graceStartedAt.set(id, now);
          extended.push(id);
        }
      }

      if (extended.length === 0) return;

      // Say so. A run that silently costs twice its deadline is worse than one
      // that ends early, so every extension is visible in status.txt and in the
      // progress stream.
      emitProgress("running");
      await delay(Math.min(GRACE_INTERVAL_MS, Math.max(1_000, stallMs)));
    }
  })().catch(() => {
    // The watcher keeps running after `allDone` wins the race below, so a late
    // status/log write into a session directory the caller has already torn
    // down must not surface as an unhandled rejection and fail the process.
    // Nothing here can change the outcome of a run that has already settled.
  });

  await Promise.race([allDone, deadlineWatcher]);

  // If the watcher won, children were just terminated. Give their stdout pipes
  // a bounded moment to close so `response-<id>.md` is final — that close is
  // what triggers reconciliation of any answer flushed during shutdown.
  if (!settled) await Promise.race([allDone, delay(DRAIN_TIMEOUT_MS)]);

  clearInterval(progressHandle);
  // Terminal frame. Without this a status-tracking consumer never sees the run
  // close — every frame would read "running", including the last one.
  emitProgress("settled");

  // Remove SIGINT handler after we're done
  process.off("SIGINT", sigintHandler);

  return statusCache;
}

/**
 * Judge existing responses blindly.
 * Reads response-*.md files, sends to judge models, collects votes, aggregates verdict.
 */
export async function judgeResponses(
  sessionPath: string,
  opts: TeamJudgeOptions = {}
): Promise<TeamVerdict> {
  // Collect all response files in sorted order
  const responseFiles = readdirSync(sessionPath)
    .filter((f) => f.startsWith("response-") && f.endsWith(".md"))
    .sort();

  if (responseFiles.length < 2) {
    throw new Error(`Need at least 2 responses to judge, found ${responseFiles.length}`);
  }

  const responses: Record<string, string> = {};
  for (const file of responseFiles) {
    const id = file.replace(/^response-/, "").replace(/\.md$/, "");
    responses[id] = readFileSync(join(sessionPath, file), "utf-8");
  }

  // Build and save judge prompt
  const input = readFileSync(join(sessionPath, "input.md"), "utf-8");
  const judgePrompt = buildJudgePrompt(input, responses);
  writeFileSync(join(sessionPath, "judge-prompt.md"), judgePrompt, "utf-8");

  // Determine judge models (default: same models that produced responses)
  const judgeModels = opts.judges ?? getDefaultJudgeModels(sessionPath);

  // Run judges in a sub-session under sessionPath/judging/
  const judgePath = join(sessionPath, "judging");
  mkdirSync(judgePath, { recursive: true });

  setupSession(judgePath, judgeModels, judgePrompt);
  await runModels(judgePath, { claudeFlags: opts.claudeFlags });

  // Parse votes from judge outputs
  const votes = parseJudgeVotes(judgePath, Object.keys(responses));

  // Aggregate votes into a verdict
  const verdict = aggregateVerdict(votes, Object.keys(responses));

  // Write verdict.md (reveals model names since judging is complete)
  writeFileSync(join(sessionPath, "verdict.md"), formatVerdict(verdict, sessionPath), "utf-8");

  return verdict;
}

/**
 * Get current status of a team session.
 */
export function getStatus(sessionPath: string): TeamStatus {
  return JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf-8"));
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

export function fisherYatesShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getDefaultJudgeModels(sessionPath: string): string[] {
  const manifest: TeamManifest = JSON.parse(
    readFileSync(join(sessionPath, "manifest.json"), "utf-8")
  );
  return Object.values(manifest.models).map((e) => e.model);
}

export function buildJudgePrompt(input: string, responses: Record<string, string>): string {
  const ids = Object.keys(responses).sort();
  let prompt = "## Blind Evaluation Task\n\n";
  prompt += "### Original Task\n\n";
  prompt += `${input}\n\n`;
  prompt += "---\n\n";
  prompt += "### Responses to Evaluate\n\n";
  prompt +=
    "Evaluate each response independently. You do not know which model produced which response.\n\n";

  for (const id of ids) {
    prompt += `#### Response ${id}\n\n`;
    prompt += `${responses[id]}\n\n`;
    prompt += "---\n\n";
  }

  prompt += "### Your Assignment\n\n";
  prompt += `For EACH of the ${ids.length} responses above, provide a vote block in this exact format:\n\n`;
  prompt += "```vote\n";
  prompt += "RESPONSE: [ID]\n";
  prompt += "VERDICT: [APPROVE|REJECT|ABSTAIN]\n";
  prompt += "CONFIDENCE: [1-10]\n";
  prompt += "SUMMARY: [One sentence]\n";
  prompt += "KEY_ISSUES: [Comma-separated issues, or None]\n";
  prompt += "```\n\n";
  prompt += `Provide exactly ${ids.length} vote blocks, one per response. Be decisive and analytical.\n`;

  return prompt;
}

export function parseJudgeVotes(judgePath: string, responseIds: string[]): VoteResult[] {
  const votes: VoteResult[] = [];
  const responseFiles = readdirSync(judgePath)
    .filter((f) => f.startsWith("response-") && f.endsWith(".md"))
    .sort();

  for (const file of responseFiles) {
    const judgeId = file.replace(/^response-/, "").replace(/\.md$/, "");
    let content: string;
    try {
      content = readFileSync(join(judgePath, file), "utf-8");
    } catch {
      continue;
    }

    // Parse ```vote ... ``` blocks
    const votePattern = /```vote\s*\n([\s\S]*?)\n\s*```/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((match = votePattern.exec(content)) !== null) {
      const block = match[1];
      const responseMatch = block.match(/RESPONSE:\s*(\S+)/);
      const verdictMatch = block.match(/VERDICT:\s*(APPROVE|REJECT|ABSTAIN)/);
      const confidenceMatch = block.match(/CONFIDENCE:\s*(\d+)/);
      const summaryMatch = block.match(/SUMMARY:\s*(.+)/);
      const keyIssuesMatch = block.match(/KEY_ISSUES:\s*(.+)/);

      const responseId = responseMatch?.[1];
      const verdict = verdictMatch?.[1];

      if (!responseId || !verdict) continue;
      // Only record votes for IDs we expect
      if (!responseIds.includes(responseId)) continue;

      votes.push({
        judgeId,
        responseId,
        verdict: verdict as "APPROVE" | "REJECT" | "ABSTAIN",
        confidence: Number.parseInt(confidenceMatch?.[1] ?? "5", 10),
        summary: summaryMatch?.[1]?.trim() ?? "",
        keyIssues:
          keyIssuesMatch?.[1]
            ?.split(",")
            .map((s) => s.trim())
            .filter((s) => s.toLowerCase() !== "none" && s.length > 0) ?? [],
      });
    }
  }

  return votes;
}

export function aggregateVerdict(votes: VoteResult[], responseIds: string[]): TeamVerdict {
  const responses: TeamVerdict["responses"] = {};

  for (const id of responseIds) {
    const votesForResponse = votes.filter((v) => v.responseId === id);
    const approvals = votesForResponse.filter((v) => v.verdict === "APPROVE").length;
    const rejections = votesForResponse.filter((v) => v.verdict === "REJECT").length;
    const abstentions = votesForResponse.filter((v) => v.verdict === "ABSTAIN").length;
    const total = approvals + rejections;

    responses[id] = {
      approvals,
      rejections,
      abstentions,
      score: total > 0 ? approvals / total : 0,
    };
  }

  const ranking = Object.entries(responses)
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([id]) => id);

  return { responses, ranking, votes };
}

function formatVerdict(verdict: TeamVerdict, sessionPath: string): string {
  let manifest: TeamManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(sessionPath, "manifest.json"), "utf-8"));
  } catch {
    // If manifest is missing we just won't show model names
  }

  let output = "# Team Verdict\n\n";
  output += "## Ranking\n\n";
  output += "| Rank | Response | Model | Score | Approvals | Rejections | Abstentions |\n";
  output += "|------|----------|-------|-------|-----------|------------|-------------|\n";

  for (let i = 0; i < verdict.ranking.length; i++) {
    const id = verdict.ranking[i];
    const r = verdict.responses[id];
    const modelName = manifest?.models[id]?.model ?? "unknown";
    const scoreStr = `${(r.score * 100).toFixed(0)}%`;
    output += `| ${i + 1} | ${id} | ${modelName} | ${scoreStr} | ${r.approvals} | ${r.rejections} | ${r.abstentions} |\n`;
  }

  output += "\n## Individual Votes\n\n";
  for (const vote of verdict.votes) {
    const issueStr = vote.keyIssues.length > 0 ? ` Issues: ${vote.keyIssues.join(", ")}.` : "";
    output += `- **Judge ${vote.judgeId}** -> Response ${vote.responseId}: **${vote.verdict}** (${vote.confidence}/10) — ${vote.summary}${issueStr}\n`;
  }

  return output;
}
