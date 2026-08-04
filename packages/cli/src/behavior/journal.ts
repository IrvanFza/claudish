/**
 * Behavior decision journal.
 *
 * Records what the supervisor SAW and what it DECIDED, so the decisions can be
 * analysed later and turned into deterministic rules. This is the input to the
 * dream session (see MTL-77).
 *
 * ## Two payloads, on purpose
 *
 * A LOCAL record keeps full detail — real paths, real values-shapes. It lives on
 * the user's own machine alongside the debug log, and a local analysis pass
 * genuinely needs it: "the model wrote to <this> instead of <that>" is the whole
 * signal, and stripping it leaves nothing to learn from.
 *
 * An UPLOADABLE record carries no paths at all. Not sanitized paths — none. The
 * existing `sanitizeForReport()` masks the home directory but keeps the rest, so
 * `/Users/***\/dev/acme/acme-portal/...` still names a client. For aggregate
 * analysis the literal path is not needed anyway: what matters is the CATEGORY
 * of what happened ("wrote inside the plan dir but not to the assigned file"),
 * which is non-identifying and just as useful across many users.
 *
 * This mirrors the two-level rule already established in redact.ts:
 * `redactSecrets` for text staying on the machine, `sanitizeForReport` for text
 * leaving it — this module just takes it further, because a behavior record is
 * structural data rather than prose.
 *
 * ## Consent
 *
 * Local journalling is always on and needs no consent: it is the user's own data
 * on their own disk, exactly like `logs/`. Upload is a SEPARATE opt-in
 * (`behavior.telemetry.enabled`) and deliberately does NOT ride on the existing
 * `stats.enabled` consent — that consent was given for usage statistics, and
 * silently reusing it to ship behavioural records would be consent laundering.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../logger.js";

/** Bump when the uploadable shape changes, so consumers can version-gate. */
export const JOURNAL_SCHEMA_VERSION = 1;

/** Which supervision surface produced this decision. */
export type Surface = "request" | "tool_call" | "model_output" | "sequence";

/** What the supervisor did. */
export type Decision =
  | "ignored" // no rule matched
  | "matched" // a rule matched and applied
  | "warned" // a rule matched but severity was warn
  | "repaired" // arguments were rewritten
  | "novel"; // nothing matched and the observer was consulted

/**
 * How a file path related to the one the harness expected.
 *
 * This is the uploadable stand-in for the path itself — it preserves the entire
 * signal the plan-mode rule keys off, while carrying no user data.
 */
export type PathRelation =
  | "as_expected"
  | "same_dir_wrong_name"
  | "outside_expected_dir"
  | "no_expectation"
  | "not_applicable";

export interface JournalEntry {
  ts: string;
  model: string;
  provider: string;
  surface: Surface;
  decision: Decision;
  ruleId?: string;
  toolName?: string;
  /** Argument KEYS only — never values. */
  argKeys?: string[];
  pathRelation?: PathRelation;
  /** Full local detail. Stripped from anything uploaded. */
  local?: {
    observedPath?: string;
    expectedPath?: string;
    note?: string;
  };
}

/** The subset that may leave the machine. Constructed by omission, not by masking. */
export interface UploadableEntry {
  schema: number;
  ts: string;
  model: string;
  provider: string;
  surface: Surface;
  decision: Decision;
  ruleId?: string;
  toolName?: string;
  argKeys?: string[];
  pathRelation?: PathRelation;
}

/**
 * Project a journal entry to its uploadable form.
 *
 * Deliberately an ALLOW-list: new fields added to JournalEntry do not leak by
 * default, they have to be added here explicitly. A deny-list would ship the
 * next contributor's new field to the cloud by accident.
 */
export function toUploadable(entry: JournalEntry): UploadableEntry {
  return {
    schema: JOURNAL_SCHEMA_VERSION,
    ts: entry.ts,
    model: entry.model,
    provider: entry.provider,
    surface: entry.surface,
    decision: entry.decision,
    ruleId: entry.ruleId,
    toolName: entry.toolName,
    argKeys: entry.argKeys,
    pathRelation: entry.pathRelation,
  };
}

/** Classify an observed path against the expected one, without keeping either. */
export function classifyPath(observed?: string, expected?: string): PathRelation {
  if (!observed) return "not_applicable";
  if (!expected) return "no_expectation";
  if (observed === expected) return "as_expected";
  const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  return dirOf(observed) === dirOf(expected) ? "same_dir_wrong_name" : "outside_expected_dir";
}

export function journalPath(): string {
  return join(homedir(), ".claudish", "behavior-journal.jsonl");
}

/**
 * Size ceiling. The journal is append-only and a busy user generates entries on
 * every tool call, so it needs a bound or it grows without limit. At the cap we
 * stop writing rather than rotate: silently discarding the OLDEST records would
 * throw away exactly the history the dream session wants, and a loud stop is
 * easier to notice than a quiet truncation.
 */
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
let capWarned = false;

/**
 * Append one decision. Never throws, never awaited by the request path.
 */
export async function recordDecision(entry: JournalEntry, path = journalPath()): Promise<void> {
  try {
    const size = await stat(path).then(
      (s) => s.size,
      () => 0
    );
    if (size > MAX_JOURNAL_BYTES) {
      if (!capWarned) {
        capWarned = true;
        log(
          `[behavior:journal] ${path} exceeded ${Math.round(MAX_JOURNAL_BYTES / 1e6)}MB — ` +
            "no longer recording. Archive or delete it to resume."
        );
      }
      return;
    }
    if (size === 0) await mkdir(dirname(path), { recursive: true }).catch(() => {});
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // Journalling is diagnostic. It must never affect the user's request.
    log(`[behavior:journal] could not record: ${err}`);
  }
}
