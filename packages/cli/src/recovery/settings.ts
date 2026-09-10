/**
 * The two recovery switches, and the ONE place the tier-1 deadline is derived.
 *
 * Precedence for both switches, identical to the shape `cli.ts` already
 * implements for `debug`:
 *
 *   CLI flag  >  environment  >  project `.claudish.json`  >  global config  >  true
 *
 * `{}` at any scope means "no opinion" and falls through to the next one —
 * which is why both fields are objects rather than bare booleans.
 */

import { ENV } from "../config.js";
import { log } from "../logger.js";
import { readRecoveryEnabled, readRecoveryUi } from "../profile-config.js";

/** Flag layer. Set once by `cli.ts`'s arg loop; undefined means "not given". */
interface RecoveryFlagOverrides {
  recovery?: boolean;
  recoveryUi?: boolean;
}

let flagOverrides: RecoveryFlagOverrides = {};

/** Called by `cli.ts` when `--recovery` / `--no-recovery[-ui]` is parsed. */
export function setRecoveryFlagOverrides(overrides: RecoveryFlagOverrides): void {
  flagOverrides = { ...flagOverrides, ...overrides };
}

/** Tests and long-lived hosts (`serve`) that must not inherit a stale flag. */
export function resetRecoveryFlagOverrides(): void {
  flagOverrides = {};
}

/** `1`/`true` → true, `0`/`false` → false, anything else → undefined. */
function parseEnvBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/**
 * Is the retry ladder allowed to run at all? Default true.
 *
 * The one row of the status table that reads this answers today's immediate
 * 400 — so turning it off restores pre-recovery behaviour exactly, which is
 * what makes it a safe CI switch rather than a feature toggle.
 */
export function resolveRecoveryEnabled(): boolean {
  if (flagOverrides.recovery !== undefined) return flagOverrides.recovery;
  const env = parseEnvBool(process.env[ENV.CLAUDISH_RECOVERY]);
  if (env !== undefined) return env;
  const scoped = readRecoveryEnabled();
  if (scoped !== undefined) return scoped;
  return true;
}

/**
 * May claudish own a surface on which a recovery episode's reason is legible?
 * Default true.
 *
 * NOTHING READS THIS YET, and that is expected. It exists now for two reasons.
 * The first is that the status decision it will gate — whether an exhausted
 * episode may answer a RETRYABLE status instead of an inline error — is a later
 * phase, and landing the switch early means that phase changes one branch
 * rather than four files. The second is the CLAUDE.md invariant it trips: a new
 * `ClaudishProfileConfig` field that is not in `loadConfig`'s allowlist AND
 * does not have a scoped reader survives on disk until the first global save
 * and is then dropped, silently. That trap has caught this codebase twice, so
 * the field is landed with its round-trip test the moment it is defined rather
 * than the moment it is first consumed.
 *
 * It is a question about the USER'S CONFIGURATION and about nothing else. It
 * must never be conflated with "can this process open a pane right now", which
 * is a launch-order fact that is false in every unwrapped launch, in `-p`, in
 * `serve` and in the whole test suite.
 */
export function resolveRecoveryUi(): boolean {
  if (flagOverrides.recoveryUi !== undefined) return flagOverrides.recoveryUi;
  const env = parseEnvBool(process.env[ENV.CLAUDISH_RECOVERY_UI]);
  if (env !== undefined) return env;
  const scoped = readRecoveryUi();
  if (scoped !== undefined) return scoped;
  return true;
}

// ─── The deadline ────────────────────────────────────────────────────────────

/**
 * Claude Code's own default per-request timeout, MEASURED — not assumed.
 *
 * Six replications at 359.4 / 360.1 / 360.1 / 360.1 / 360.1 / 360.1 s against a
 * custom base URL, and it was then PROVED to be this variable rather than a
 * fixed watchdog by setting `API_TIMEOUT_MS=20000` and observing six aborts at
 * exactly 20.000 s.
 */
export const DEFAULT_API_TIMEOUT_MS = 360_000;

/**
 * We never derive a hold longer than this from the environment, however
 * generous `API_TIMEOUT_MS` is. It stops the constant from tracking one Claude
 * Code version's undocumented default, and it keeps the hold inside the range
 * where the other ceilings in this system (Bun's `idleTimeout`, lifted per
 * request but only on the recovery path) were reasoned about.
 */
export const CLIENT_CEILING_CLAMP_MS = 300_000;

/**
 * Reserve subtracted from the client's ceiling: the unclamped first attempt's
 * tail, the response write, and the gap between the client starting its clock
 * and our handler starting ours. Losing this race means the client aborts a
 * request we were about to answer, so the margin is deliberately generous.
 */
export const DEADLINE_MARGIN_MS = 30_000;

/**
 * Below this much budget, recovery is not worth attempting — but we clamp UP to
 * it rather than disabling, because a client that aborts is handled correctly
 * (the waiter leaves within a millisecond of `c.req.raw.signal` firing) whereas
 * a silently-skipped ladder is the failure this floor exists to make visible.
 *
 * WHY 15 s specifically, rather than a round number. The ladder's first rung is
 * 5 s and no attempt is started with less than `MIN_ATTEMPT_SLOT_MS` (3 s) of
 * budget left, so the smallest deadline that buys even ONE retry beyond the
 * unchanged first attempt is 5 + 3 = 8 s. 15 s buys that retry with room for
 * the attempt itself to take a few seconds, and stops one rung short of the
 * second (5 + 10 + 3 = 18 s). Anything under 8 s would make the ladder a pure
 * delay in front of the same 400 — machinery that runs, logs and recovers
 * nothing, which is worse than not running.
 */
export const TIER1_DEADLINE_FLOOR_MS = 15_000;

/**
 * The tier-1 hold, DERIVED from the environment on every request.
 *
 *   max(FLOOR, min(API_TIMEOUT_MS ?? 360_000, 300_000) − 30_000)
 *
 * At the default this is 270 000 ms. It is not hardcoded, and that is the point:
 * `API_TIMEOUT_MS` is a user-settable knob that sets the client's ceiling
 * exactly, so a machine with `API_TIMEOUT_MS=60000` running against a hardcoded
 * 270 s hold would end EVERY episode in `client_gone` — the feature doing
 * nothing at all, silently, forever, with nothing printed anywhere.
 *
 * A 270 s hold is not racing an impatient client. Claude Code's retry budget
 * was measured to be a COUNT (~11 attempts), not a duration: on the hung-upstream
 * path it was still retrying after 40 minutes and six full 360 s attempts. One
 * tier-1 hold spends well under one of those attempts.
 */
export function resolveTier1DeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.API_TIMEOUT_MS];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const clientCeiling =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, CLIENT_CEILING_CLAMP_MS)
      : CLIENT_CEILING_CLAMP_MS;
  const derived = clientCeiling - DEADLINE_MARGIN_MS;
  return Math.max(TIER1_DEADLINE_FLOOR_MS, derived);
}

/** The value `resolveTier1DeadlineMs` returns with nothing set. */
export const DEFAULT_TIER1_DEADLINE_MS = CLIENT_CEILING_CLAMP_MS - DEADLINE_MARGIN_MS;

let deadlineNoticeLogged = false;

/**
 * Announce a deadline the environment shortened, ONCE per process.
 *
 * A shortened budget is not an error and must not read as one, but it must not
 * be mysterious either: the whole point of deriving the number is that the user
 * can see it. Emitted from inside the recovery path, so a healthy run prints
 * nothing.
 */
export function logDeadlineIfShortened(deadlineMs: number): void {
  if (deadlineNoticeLogged) return;
  if (deadlineMs >= DEFAULT_TIER1_DEADLINE_MS) return;
  deadlineNoticeLogged = true;
  const raw = process.env[ENV.API_TIMEOUT_MS];
  log(
    `[Recovery] tier-1 hold shortened to ${Math.round(deadlineMs / 1000)}s ` +
      `(API_TIMEOUT_MS=${raw ?? "unset"}; default would be ${Math.round(DEFAULT_TIER1_DEADLINE_MS / 1000)}s)`
  );
}

/** Tests only — the notice latch is process state. */
export function resetDeadlineNotice(): void {
  deadlineNoticeLogged = false;
}
