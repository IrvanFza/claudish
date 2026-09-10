import { describe, expect, it } from "bun:test";
import {
  ADVISOR_TOOL_ENV_VAR,
  isAdvisorNativeSession,
  resolveAdvisorToolEnv,
} from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

function config(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return {
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "info",
    quiet: false,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: [],
    noLogs: false,
    diagMode: "auto",
    ...overrides,
  };
}

describe("isAdvisorNativeSession", () => {
  it("is true with advisor enabled and no model or model chain, regardless of monitor", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, monitor: true }))).toBe(true);
    expect(isAdvisorNativeSession(config({ advisor: true, monitor: false }))).toBe(true);
  });

  it("is false when a Claude model is set", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, model: "claude-sonnet-5" }))).toBe(
      false
    );
  });

  it("is false when a non-Claude model is set", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, model: "grok-4.6" }))).toBe(false);
  });

  it("is false when a non-empty model chain is set", () => {
    expect(
      isAdvisorNativeSession(config({ advisor: true, modelChain: ["grok-4.6", "claude-sonnet-5"] }))
    ).toBe(false);
  });

  it("is false when advisor is false or absent, regardless of monitor and other settings", () => {
    expect(
      isAdvisorNativeSession(
        config({ advisor: false, monitor: true, model: "grok-4.6", modelChain: ["fallback"] })
      )
    ).toBe(false);
    expect(
      isAdvisorNativeSession(
        config({ advisor: false, monitor: false, model: "claude-sonnet-5" })
      )
    ).toBe(false);
    expect(isAdvisorNativeSession(config({ monitor: true, modelChain: ["fallback"] }))).toBe(false);
    expect(isAdvisorNativeSession(config({ monitor: false }))).toBe(false);
  });
});

describe("resolveAdvisorToolEnv", () => {
  it("sets the advisor variable to 1 when advisor is on and the parent variable is absent", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: true }), {});

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBe("1");
    expect(result.source).toBe("claudish");
  });

  it("uses a value accepted by Claude Code's strict boolean parser", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: true }), {});

    expect(["1", "true", "yes", "on"]).toContain(result.vars[ADVISOR_TOOL_ENV_VAR]);
  });

  it("preserves an inherited value of 0", () => {
    const parentEnv = { [ADVISOR_TOOL_ENV_VAR]: "0" };
    const result = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect({ ...parentEnv, ...result.vars }[ADVISOR_TOOL_ENV_VAR]).toBe("0");
    expect(result.source).toBe("inherited");
  });

  it("preserves an inherited value of true", () => {
    const parentEnv = { [ADVISOR_TOOL_ENV_VAR]: "true" };
    const result = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect({ ...parentEnv, ...result.vars }[ADVISOR_TOOL_ENV_VAR]).toBe("true");
    expect(result.source).toBe("inherited");
  });

  it("does not add the advisor variable when advisor is off", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: false }), {});

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect(result.source).toBe("off");
  });

  it("exports the Claude Code advisor variable name", () => {
    expect(ADVISOR_TOOL_ENV_VAR).toBe("CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL");
  });
});
