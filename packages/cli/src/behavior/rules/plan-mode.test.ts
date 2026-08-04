import { describe, expect, it } from "bun:test";
import type { BehaviorContext, ToolCallContext } from "../types.js";
import { planFilePathRule } from "./plan-mode.js";

const assignedPath = "/workspace/.custom-plans/assigned-session.md";
const planDir = "/workspace/.custom-plans";

function requestContext(overrides: Partial<BehaviorContext> = {}): BehaviorContext {
  return {
    modelId: "gpt-5.6-codex",
    providerName: "openai-codex",
    isNativeAnthropic: false,
    claudeRequest: { messages: [] },
    claudeTools: [{ name: "ExitPlanMode", description: "Exit plan mode" }],
    tools: [],
    messages: [],
    systemText: "",
    harness: {
      planModeActive: true,
      planFilePath: assignedPath,
      planDir,
    },
    ...overrides,
  };
}

function toolCallContext(args: Record<string, unknown>): ToolCallContext {
  return {
    modelId: "gpt-5.6-codex",
    toolName: "Write",
    args,
    rawArgs: JSON.stringify(args),
    harness: {
      planModeActive: true,
      planFilePath: assignedPath,
      planDir,
    },
  };
}

describe("planFilePathRule.onRequest", () => {
  it("returns no actions when plan mode is inactive", () => {
    const ctx = requestContext({ harness: { planModeActive: false } });

    expect(planFilePathRule.onRequest!(ctx)).toEqual([]);
  });

  it("returns no actions when ExitPlanMode is not offered", () => {
    const ctx = requestContext({
      claudeTools: [{ name: "Write", description: "Write a file" }],
      tools: [{ type: "function", function: { name: "Edit", description: "Edit a file" } }],
    });

    expect(planFilePathRule.onRequest!(ctx)).toEqual([]);
  });

  it("appends the exact assigned path to the ExitPlanMode description", () => {
    const actions = planFilePathRule.onRequest!(requestContext());

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("rewriteToolDescription");
    if (actions[0].type !== "rewriteToolDescription") {
      throw new Error("expected rewriteToolDescription action");
    }
    expect(actions[0].tool).toBe("ExitPlanMode");
    expect(actions[0].append).toContain(
      `Your plan MUST be written to exactly this path:\n${assignedPath}`
    );
  });
});

describe("planFilePathRule.onToolCall", () => {
  it("redirects an invented filename inside the assigned plan directory", () => {
    const actions = planFilePathRule.onToolCall!(
      toolCallContext({ file_path: `${planDir}/invented-name.md`, content: "# Plan" })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("repairToolArgs");
    if (actions[0].type !== "repairToolArgs") {
      throw new Error("expected repairToolArgs action");
    }
    expect(actions[0].args).toEqual({ file_path: assignedPath, content: "# Plan" });
  });

  it("does not touch a normal project file outside the plan directory", () => {
    const actions = planFilePathRule.onToolCall!(
      toolCallContext({ file_path: "/workspace/src/implementation.ts", content: "source" })
    );

    expect(actions).toEqual([]);
  });

  it("does not touch the already-correct assigned path", () => {
    expect(
      planFilePathRule.onToolCall!(
        toolCallContext({ file_path: assignedPath, content: "# Correct plan" })
      )
    ).toEqual([]);
  });

  it("ignores missing and non-string file_path values", () => {
    expect(planFilePathRule.onToolCall!(toolCallContext({ content: "missing" }))).toEqual([]);
    expect(
      planFilePathRule.onToolCall!(toolCallContext({ file_path: 42, content: "number" }))
    ).toEqual([]);
    expect(
      planFilePathRule.onToolCall!(toolCallContext({ file_path: null, content: "null" }))
    ).toEqual([]);
  });
});
