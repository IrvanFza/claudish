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
  config: BehaviorConfig
): Severity {
  const rules = config.rules;
  if (!rules) return defaultSeverity;

  const exact = rules[ruleId];
  if (exact) return exact;

  let best: { len: number; severity: Severity } | null = null;
  for (const [pattern, severity] of Object.entries(rules)) {
    if (!pattern.includes("*")) continue;
    if (!globMatches(pattern, ruleId)) continue;
    const len = pattern.replace(/\*/g, "").length;
    if (!best || len > best.len) best = { len, severity };
  }
  return best ? best.severity : defaultSeverity;
}

/** `*` matches any run of characters, including `/`. Anchored at both ends. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
