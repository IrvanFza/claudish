/**
 * Detects Claude Code harness state from an in-flight request.
 *
 * Every string Claude Code emits that we match on lives HERE, not in the rules.
 * These anchors are upstream prompt text: they can change without notice on any
 * CC release, so keeping them in one file makes a break one edit to fix rather
 * than a hunt through every rule.
 *
 * Anchors verified against the Claude Code 2.1.220 binary.
 */

import type { HarnessFacts } from "./types.js";

/**
 * Plan-file path anchors, in the three forms CC emits.
 *
 * The path is always taken FROM the reminder. It is never reconstructed from a
 * default directory, because CC exposes a `planDir` setting ("Custom directory
 * for plan files, relative to project root. If not set, defaults to
 * ~/.claude/plans/") — assuming the default would silently misfire for anyone
 * who changed it, which is precisely the class of bug this layer exists to stop.
 */
const PLAN_PATH_PATTERNS: RegExp[] = [
  /You should create your plan at\s+(\S+?\.md)/,
  /A plan file already exists at\s+(\S+?\.md)/,
  /Read-only except plan file\s*\(([^)]+\.md)\)/,
];

/**
 * Cheap pre-test, so the anchor regexes are not run over every message of a
 * 180K-token conversation.
 *
 * MUST be a superset of the anchors above. An earlier version listed only
 * "plan file" / "Plan mode is active", which does not appear in the
 * "You should create your plan at …" anchor — so that anchor was short-circuited
 * away and never evaluated. It only worked in practice because Claude Code
 * happens to emit "No plan file exists yet." in the same block. Any new anchor
 * must have a matching alternative here.
 */
const PLAN_MODE_HINT = /plan file|create your plan at|Plan mode is active|Plan mode still active/i;

/** Collect the text of a message/system entry, whatever shape it arrived in. */
function textOf(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      if (typeof part === "string") out += part;
      else if (typeof part?.text === "string") out += part.text;
      else if (typeof part?.content === "string") out += part.content;
    }
    return out;
  }
  if (typeof value?.text === "string") return value.text;
  return "";
}

function matchPlanPath(text: string): string | undefined {
  if (!PLAN_MODE_HINT.test(text)) return undefined;
  for (const re of PLAN_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * Extract harness facts from a normalized Claude-format request.
 *
 * Scans the system prompt, then walks messages from the END backwards. The
 * plan-mode reminder is re-injected on the most recent turn, so the backwards
 * walk finds it in the first message or two on a live request — which matters
 * when the conversation is the ~180K tokens where this bug actually bites.
 */
export function detectHarnessFacts(claudeRequest: any): HarnessFacts {
  const facts: HarnessFacts = { planModeActive: false };

  let planPath = matchPlanPath(textOf(claudeRequest?.system));

  if (!planPath && Array.isArray(claudeRequest?.messages)) {
    const messages = claudeRequest.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      planPath = matchPlanPath(textOf(messages[i]?.content));
      if (planPath) break;
    }
  }

  if (planPath) {
    facts.planModeActive = true;
    facts.planFilePath = planPath;
    const slash = planPath.lastIndexOf("/");
    if (slash > 0) facts.planDir = planPath.slice(0, slash);
  }

  return facts;
}
