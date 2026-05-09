/**
 * Shared types for the TUI components and hooks. Extracted from App.tsx to
 * avoid circular imports back into the root component.
 */

export type Tab = "providers" | "profiles" | "routing" | "privacy";

export type Mode =
  | "browse"
  | "input_key"
  | "input_endpoint"
  | "add_routing_pattern"
  | "add_routing_chain"
  | "pick_routing_scope"
  | "new_profile"
  | "pick_profile_scope"
  | "pick_provider_prefix"
  | "edit_profile_opus"
  | "edit_profile_sonnet"
  | "edit_profile_haiku"
  | "edit_profile_subagent";

/**
 * Routing scope. Promoted to types.ts so RoutingContent and App.tsx
 * agree on the shape and we don't carry two copies.
 */
export type RoutingScope = "global" | "project";

/**
 * A single row in the merged routing rules table. Each row carries enough
 * information for the render layer to pick the right marker AND for the
 * keyboard handlers to route `e`/`d` to the correct config layer.
 *
 * `kind` priority for marker rendering: project (▴) > override (★) > user (•)
 * > default (·). The fields `overridesDefault` and `overridesGlobal` capture
 * the shadowing relationship for accurate status messages on `d`.
 */
export interface MergedRule {
  kind: "default" | "global" | "project";
  pattern: string;
  chain: string[];
  /** True when a user rule (global or project) shadows a built-in default. */
  overridesDefault: boolean;
  /** True only for project rules that shadow a same-pattern global rule. */
  overridesGlobal: boolean;
}

export type ProbeMode = "idle" | "input" | "running" | "done";

export interface ProbeEntry {
  provider: string;
  displayName: string;
  status: "pending" | "testing" | "success" | "failed" | "skipped" | "no_key";
  error?: string;
  ms?: number;
  hasKey?: boolean;
  reason?: string;
}

export interface TestResult {
  status: "testing" | "valid" | "failed";
  error?: string;
  ms?: number;
}

export type TestResultsMap = Record<string, TestResult>;
