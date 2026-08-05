import { describe, expect, it } from "bun:test";
import { BehaviorEngine } from "./engine.js";
import { planFilePathRule } from "./rules/plan-mode.js";
import type { BehaviorRule } from "./types.js";

function makeRule(overrides: Partial<BehaviorRule> & Pick<BehaviorRule, "id">): BehaviorRule {
  return {
    description: overrides.id,
    defaultSeverity: "fix",
    appliesTo: () => true,
    ...overrides,
  };
}

function startSession(engine: BehaviorEngine, isNativeAnthropic = false) {
  return engine.startSession({
    modelId: "gpt-5.6-codex",
    providerName: "openai-codex",
    isNativeAnthropic,
  });
}

function planRequest(path: string): any {
  return {
    system: `Plan mode is active. You should create your plan at ${path}`,
    messages: [],
  };
}

describe("BehaviorEngine rule isolation", () => {
  it("returns a no-op session for native Anthropic models", () => {
    const rule = makeRule({ id: "test/native-noop" });
    const session = startSession(new BehaviorEngine({}, [rule]), true);

    expect(session.isNoop).toBe(true);
    expect(session.interceptsTool("Write")).toBe(false);
  });

  it("isolates an appliesTo exception and still runs another rule", () => {
    const broken = makeRule({
      id: "test/broken-applies",
      appliesTo: () => {
        throw new Error("appliesTo exploded");
      },
    });
    const healthy = makeRule({
      id: "test/healthy-applies",
      onRequest: () => [{ type: "injectSystemNote", text: "healthy rule ran" }],
    });
    const session = startSession(new BehaviorEngine({}, [broken, healthy]));
    const request = { system: "base", messages: [] };

    expect(() => session.applyRequest(request, [], [], [])).not.toThrow();
    expect(request.system).toBe("base\n\nhealthy rule ran");
  });

  it("isolates an onRequest exception and still runs another rule", () => {
    const broken = makeRule({
      id: "test/broken-request",
      onRequest: () => {
        throw new Error("onRequest exploded");
      },
    });
    const healthy = makeRule({
      id: "test/healthy-request",
      onRequest: () => [{ type: "injectSystemNote", text: "healthy rule ran" }],
    });
    const session = startSession(new BehaviorEngine({}, [broken, healthy]));
    const request = { system: "base", messages: [] };

    expect(() => session.applyRequest(request, [], [], [])).not.toThrow();
    expect(request.system).toBe("base\n\nhealthy rule ran");
  });

  it("isolates an onToolCall exception and still applies another repair", () => {
    const broken = makeRule({
      id: "test/broken-tool-call",
      interceptsTools: ["Write"],
      onToolCall: () => {
        throw new Error("onToolCall exploded");
      },
    });
    const healthy = makeRule({
      id: "test/healthy-tool-call",
      interceptsTools: ["Write"],
      onToolCall: (ctx) => [
        {
          type: "repairToolArgs",
          args: { ...ctx.args, file_path: "/tmp/repaired.md" },
          reason: "test repair",
        },
      ],
    });
    const session = startSession(new BehaviorEngine({}, [broken, healthy]));
    session.applyRequest({ messages: [] }, [], [], []);

    const repaired = session.repairToolCall(
      "Write",
      JSON.stringify({ file_path: "/tmp/original.md", content: "plan" })
    );

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!)).toEqual({ file_path: "/tmp/repaired.md", content: "plan" });
  });
});

describe("BehaviorSession request actions", () => {
  it("warn severity leaves request data untouched while fix severity mutates it", () => {
    const rule = makeRule({
      id: "test/rewrite-description",
      onRequest: () => [
        { type: "rewriteToolDescription", tool: "ExitPlanMode", append: " [assigned path]" },
      ],
    });

    const warnClaudeTools = [{ name: "ExitPlanMode", description: "original" }];
    const warnTools = [
      { type: "function", function: { name: "ExitPlanMode", description: "converted" } },
    ];
    const warnSession = startSession(
      new BehaviorEngine({ rules: { "test/rewrite-description": "warn" } }, [rule])
    );
    warnSession.applyRequest({ messages: [] }, warnClaudeTools, warnTools, []);

    expect(warnClaudeTools[0].description).toBe("original");
    expect(warnTools[0].function.description).toBe("converted");

    const fixClaudeTools = [{ name: "ExitPlanMode", description: "original" }];
    const fixTools = [
      { type: "function", function: { name: "ExitPlanMode", description: "converted" } },
    ];
    const fixSession = startSession(new BehaviorEngine({}, [rule]));
    fixSession.applyRequest({ messages: [] }, fixClaudeTools, fixTools, []);

    expect(fixClaudeTools[0].description).toBe("original [assigned path]");
    expect(fixTools[0].function.description).toBe("converted [assigned path]");
  });

  it("rewrites both Claude-format and converted tool descriptions", () => {
    const rule = makeRule({
      id: "test/both-tool-formats",
      onRequest: () => [
        { type: "rewriteToolDescription", tool: "TargetTool", append: " appended" },
      ],
    });
    const claudeTools = [
      { name: "TargetTool", description: "claude" },
      { name: "OtherTool", description: "other" },
    ];
    const tools = [
      { type: "function", function: { name: "TargetTool", description: "converted" } },
      { type: "function", function: { name: "OtherTool", description: "other" } },
    ];

    startSession(new BehaviorEngine({}, [rule])).applyRequest(
      { messages: [] },
      claudeTools,
      tools,
      []
    );

    expect(claudeTools.map((tool) => tool.description)).toEqual(["claude appended", "other"]);
    expect(tools.map((tool) => tool.function.description)).toEqual(["converted appended", "other"]);
  });

  it("appends a system note to a string system prompt", () => {
    const rule = makeRule({
      id: "test/string-system-note",
      onRequest: () => [{ type: "injectSystemNote", text: "important note" }],
    });
    const request = { system: "existing system", messages: [] };

    startSession(new BehaviorEngine({}, [rule])).applyRequest(request, [], [], []);

    expect(request.system).toBe("existing system\n\nimportant note");
  });

  it("appends a text block to an array system prompt", () => {
    const rule = makeRule({
      id: "test/array-system-note",
      onRequest: () => [{ type: "injectSystemNote", text: "important note" }],
    });
    const request = {
      system: [{ type: "text", text: "existing system" }],
      messages: [],
    };

    startSession(new BehaviorEngine({}, [rule])).applyRequest(request, [], [], []);

    expect(request.system).toEqual([
      { type: "text", text: "existing system" },
      { type: "text", text: "important note" },
    ]);
  });

  it("creates a system prompt when none was present", () => {
    const rule = makeRule({
      id: "test/absent-system-note",
      onRequest: () => [{ type: "injectSystemNote", text: "important note" }],
    });
    const request: any = { messages: [] };

    startSession(new BehaviorEngine({}, [rule])).applyRequest(request, [], [], []);

    expect(request.system).toBe("important note");
  });
});

describe("BehaviorSession tool interception", () => {
  const armingRule = makeRule({
    id: "test/arming",
    interceptsTools: ["Write"],
    armed: (facts) => facts.planModeActive,
  });

  it("arms buffering only after request inspection, for an armed fix rule", () => {
    const beforeRequest = startSession(new BehaviorEngine({}, [armingRule]));
    expect(beforeRequest.interceptsTool("Write")).toBe(false);

    const outsidePlanMode = startSession(new BehaviorEngine({}, [armingRule]));
    outsidePlanMode.applyRequest({ system: "ordinary request", messages: [] }, [], [], []);
    expect(outsidePlanMode.interceptsTool("Write")).toBe(false);

    const armedFalse = makeRule({
      ...armingRule,
      id: "test/arming-false",
      armed: () => false,
    });
    const explicitlyUnarmed = startSession(new BehaviorEngine({}, [armedFalse]));
    explicitlyUnarmed.applyRequest(planRequest("/tmp/plans/assigned.md"), [], [], []);
    expect(explicitlyUnarmed.interceptsTool("Write")).toBe(false);

    const armedFix = startSession(new BehaviorEngine({}, [armingRule]));
    armedFix.applyRequest(planRequest("/tmp/plans/assigned.md"), [], [], []);
    expect(armedFix.interceptsTool("Write")).toBe(true);

    const warnOnly = startSession(
      new BehaviorEngine({ rules: { "test/arming": "warn" } }, [armingRule])
    );
    warnOnly.applyRequest(planRequest("/tmp/plans/assigned.md"), [], [], []);
    expect(warnOnly.interceptsTool("Write")).toBe(false);
  });

  it("keeps harness facts independent across concurrent sessions", () => {
    const engine = new BehaviorEngine({}, [planFilePathRule]);
    const first = startSession(engine);
    const second = startSession(engine);
    const firstPath = "/tmp/session-one-plans/assigned-one.md";
    const secondPath = "/tmp/session-two-plans/assigned-two.md";

    first.applyRequest(planRequest(firstPath), [], [], []);
    second.applyRequest(planRequest(secondPath), [], [], []);

    const firstRepair = first.repairToolCall(
      "Write",
      JSON.stringify({ file_path: "/tmp/session-one-plans/invented.md" })
    );
    const secondRepair = second.repairToolCall(
      "Write",
      JSON.stringify({ file_path: "/tmp/session-two-plans/invented.md" })
    );

    expect(first.harness.planFilePath).toBe(firstPath);
    expect(second.harness.planFilePath).toBe(secondPath);
    expect(JSON.parse(firstRepair!).file_path).toBe(firstPath);
    expect(JSON.parse(secondRepair!).file_path).toBe(secondPath);
  });

  it("returns null for malformed JSON and when no rule changes the arguments", () => {
    const passiveRule = makeRule({
      id: "test/passive-tool-call",
      interceptsTools: ["Write"],
      onToolCall: () => [],
    });
    const session = startSession(new BehaviorEngine({}, [passiveRule]));
    session.applyRequest({ messages: [] }, [], [], []);

    expect(session.repairToolCall("Write", "{not valid json")).toBeNull();
    expect(
      session.repairToolCall("Write", JSON.stringify({ file_path: "/tmp/file.md" }))
    ).toBeNull();
  });
});
