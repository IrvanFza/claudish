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
  | "new_profile"
  | "pick_profile_scope"
  | "pick_provider_prefix"
  | "edit_profile_opus"
  | "edit_profile_sonnet"
  | "edit_profile_haiku"
  | "edit_profile_subagent";

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
