/**
 * Behavior-layer configuration: schema, loading, and severity resolution.
 *
 * Validation lives here rather than in profile-config.ts on purpose — that
 * module is deliberately Zod-free because `loadConfig` runs on many lightweight
 * startup paths (see the note at the top of config-schema.ts). Same rule as
 * custom endpoints: validate at the point of consumption, warn and fall back
 * rather than throwing, so a malformed `behavior` block can never stop claudish
 * from starting.
 */

import { z } from "zod";
import { logStderr } from "../logger.js";
import type { BehaviorConfig, Severity } from "./types.js";

const SeveritySchema = z.enum(["off", "warn", "fix"]);

export const BehaviorConfigSchema = z.object({
  preset: z.string().optional(),
  // Separate from `stats.enabled` on purpose — see the note on BehaviorConfig.
  telemetry: z.object({ enabled: z.boolean().optional() }).optional(),
  rules: z.record(z.string(), SeveritySchema).optional(),
  hooks: z.array(z.string()).optional(),
  observer: z
    .object({
      enabled: z.boolean().optional(),
      // "enforce" is deliberately NOT accepted — see the note on BehaviorConfig.
      // Rejecting it is better than accepting it and quietly behaving as
      // "suggest": a user who asks for enforcement should be told it does not
      // exist, not left believing their calls are being gated.
      mode: z.enum(["off", "suggest"]).optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      watchTools: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Parse a raw `behavior` config value. Invalid input warns once and degrades to
 * an empty config (every rule at its own default) rather than failing the run.
 */
export function parseBehaviorConfig(raw: unknown): BehaviorConfig {
  if (raw === undefined || raw === null) return {};
  const result = BehaviorConfigSchema.safeParse(raw);
  if (!result.success) {
    logStderr(
      `[behavior] Ignoring invalid "behavior" config: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the effective severity for a rule.
 *
 * Precedence: exact id → longest matching glob → the rule's own default. Longest
 * glob wins so a user can broadly disable a namespace and re-enable one member:
 *
 *   { "plan-mode/*": "off", "plan-mode/plan-file-path": "fix" }
 */
export function resolveSeverity(
  ruleId: string,
  defaultSeverity: Severity,
  config: BehaviorConfig,
  modelId?: string
): Severity {
  const rules = config.rules;
  if (!rules) return defaultSeverity;

  // Model-scoped keys beat unscoped ones. Nothing transfers between models — a
  // rule proven on one is a hypothesis on the next — so a user must be able to
  // arm a rule for the model that needs it without arming it for every model:
  //
  //   { "plan-mode/*": "warn", "gpt-5.6-*:plan-mode/plan-file-path": "fix" }
  //
  // Pass 1 considers only `model:rule` keys, pass 2 only unscoped keys.
  if (modelId) {
    const scoped = bestMatch(rules, ruleId, modelId);
    if (scoped) return scoped;
  }
  return bestMatch(rules, ruleId, undefined) ?? defaultSeverity;
}

/**
 * Best matching severity within one scope tier.
 *
 * Specificity wins: an exact match beats a glob, and a longer glob beats a
 * shorter one, so `{"plan-mode/*":"off","plan-mode/plan-file-path":"fix"}`
 * re-enables the single rule.
 */
function bestMatch(
  rules: Record<string, Severity>,
  ruleId: string,
  modelId: string | undefined
): Severity | null {
  let best: { score: number; severity: Severity } | null = null;

  for (const [key, severity] of Object.entries(rules)) {
    const { model: keyModel, rule: keyRule } = parseRuleKey(key);
    if (!scopeMatches(keyModel, modelId)) continue;
    if (!globMatches(keyRule, ruleId)) continue;
    const score = specificity(keyRule);
    if (!best || score > best.score) best = { score, severity };
  }

  return best ? best.severity : null;
}

/**
 * Split a config key into its optional model scope and its rule pattern.
 *
 * A `:` only introduces a model scope when it precedes the rule namespace. Rule
 * ids themselves never contain one, but HOOK ids look like `hook:file/rule` —
 * an unanchored split would silently mis-read every hook rule as model-scoped.
 */
function parseRuleKey(key: string): { model?: string; rule: string } {
  const sep = key.indexOf(":");
  if (sep <= 0 || key.startsWith("hook:")) return { rule: key };
  return { model: key.slice(0, sep), rule: key.slice(sep + 1) };
}

/** Scoped keys match only in the scoped pass, unscoped keys only in the unscoped pass. */
function scopeMatches(keyModel: string | undefined, modelId: string | undefined): boolean {
  if (modelId === undefined) return keyModel === undefined;
  return keyModel !== undefined && globMatches(keyModel, modelId);
}

/** Exact beats glob; among globs, more literal characters wins. */
function specificity(pattern: string): number {
  return pattern.includes("*") ? pattern.replace(/\*/g, "").length : Number.MAX_SAFE_INTEGER;
}

/** `*` matches any run of characters, including `/`. Anchored at both ends. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
