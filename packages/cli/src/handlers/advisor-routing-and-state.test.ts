import { afterEach, describe, expect, it } from "bun:test";
import {
  ADVISOR_STUB_PATHS,
  _debug_resetTrackedAdvisorIds,
  advisorRouteFor,
  findPendingAdvisorToolResults,
  getAdvisorCall,
  markAdvisorCallConsumed,
  recordAdvisorEventsFromResponseBody,
  rewriteAdvisorToolResults,
} from "./native-handler-advisor.js";

const cfg = { enabled: true, logPath: undefined };

function recordAdvisorCall(toolUseId: string, sessionId?: string): void {
  recordAdvisorEventsFromResponseBody(
    cfg,
    {
      content: [{ type: "tool_use", name: "advisor", id: toolUseId, input: {} }],
    },
    sessionId
  );
}

function advisorResultPayload(toolUseId: string): Record<string, unknown> {
  return {
    messages: [
      { role: "user", content: "Review this design." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "advisor", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
          },
        ],
      },
    ],
  };
}

function resultBlock(payload: Record<string, unknown>): any {
  return ((payload.messages as any[])[2].content as any[])[0];
}

afterEach(() => {
  _debug_resetTrackedAdvisorIds();
});

describe("advisorRouteFor", () => {
  it("routes OpenAI, Google, OpenRouter, and Anthropic models with provider credentials", () => {
    const openai = advisorRouteFor("gpt-5.6-sol", "panel");
    const google = advisorRouteFor("gemini-3.8-flash", "panel");
    const openrouter = advisorRouteFor("grok-4.6", "panel");
    const anthropic = advisorRouteFor("haiku", "collector");

    expect(openai.kind).toBe("openai");
    expect(openai.host).toBe("api.openai.com");
    expect(google.kind).toBe("google");
    expect(openrouter.kind).toBe("openrouter");
    expect(typeof openrouter.wireModel).toBe("string");
    expect(openrouter.wireModel).toContain("grok-4.6");
    expect(openrouter.wireModel).not.toContain("{");
    expect(openrouter.wireModel).not.toContain("resolvedId");
    expect(anthropic.kind).toBe("anthropic");

    expect(openai.credential).toBe("openai");
    expect(google.credential).toBe("google");
    expect(openrouter.credential).toBe("openrouter");
    expect(new Set([openai.credential, google.credential, openrouter.credential]).size).toBe(3);
  });
});

describe("session-keyed pending advisor state", () => {
  it("isolates calls by session and retains consumed entries", () => {
    const sessionId = "advisor-state-session-s1-001";
    const otherSessionId = "advisor-state-session-s2-001";
    const toolUseId = "toolu_advisor_state_001";

    recordAdvisorCall(toolUseId, sessionId);

    expect(getAdvisorCall(toolUseId, sessionId)?.toolUseId).toBe(toolUseId);
    expect(getAdvisorCall(toolUseId, otherSessionId)).toBeUndefined();

    const delivered = { text: "Retained advisor result", isError: false };
    expect(markAdvisorCallConsumed(toolUseId, delivered, sessionId)).toBe(true);
    expect(getAdvisorCall(toolUseId, sessionId)?.result).toEqual(delivered);
  });

  it("adopts a no-session call into the first known session", () => {
    const firstSessionId = "advisor-adopt-session-s1-002";
    const secondSessionId = "advisor-adopt-session-s2-002";
    const toolUseId = "toolu_advisor_adopt_002";

    recordAdvisorCall(toolUseId);
    const payload = advisorResultPayload(toolUseId);

    expect(findPendingAdvisorToolResults(payload, firstSessionId)).toEqual([toolUseId]);
    expect(
      markAdvisorCallConsumed(
        toolUseId,
        { text: "Adopted advisor result", isError: false },
        firstSessionId
      )
    ).toBe(true);
    expect(getAdvisorCall(toolUseId, firstSessionId)?.sessionKey).toBe(firstSessionId);
    expect(findPendingAdvisorToolResults(payload, secondSessionId)).toEqual([]);
  });
});

describe("rewriteAdvisorToolResults", () => {
  it("propagates an AdvisorToolResult error flag and text", () => {
    const sessionId = "advisor-rewrite-error-session-003";
    const toolUseId = "toolu_advisor_rewrite_error_003";
    recordAdvisorCall(toolUseId, sessionId);
    const payload = advisorResultPayload(toolUseId);

    expect(
      rewriteAdvisorToolResults(
        payload,
        () => ({ text: "Advisor upstream failed", isError: true }),
        sessionId
      )
    ).toEqual([toolUseId]);
    expect(resultBlock(payload).is_error).toBe(true);
    expect(resultBlock(payload).content).toEqual([
      { type: "text", text: "Advisor upstream failed" },
    ]);
  });

  it("clears the error flag for a backward-compatible string replacement", () => {
    const sessionId = "advisor-rewrite-string-session-004";
    const toolUseId = "toolu_advisor_rewrite_string_004";
    recordAdvisorCall(toolUseId, sessionId);
    const payload = advisorResultPayload(toolUseId);

    expect(rewriteAdvisorToolResults(payload, () => "Plain advisor text", sessionId)).toEqual([
      toolUseId,
    ]);
    expect(resultBlock(payload).is_error).toBe(false);
    expect(resultBlock(payload).content).toEqual([{ type: "text", text: "Plain advisor text" }]);
  });

  it("leaves an unrecorded tool_result unchanged", () => {
    const sessionId = "advisor-rewrite-unknown-session-005";
    const toolUseId = "toolu_advisor_rewrite_unknown_005";
    const payload = advisorResultPayload(toolUseId);
    const before = structuredClone(resultBlock(payload));

    expect(rewriteAdvisorToolResults(payload, () => "Must not be used", sessionId)).toEqual([]);
    expect(resultBlock(payload)).toEqual(before);
  });
});

describe("ADVISOR_STUB_PATHS", () => {
  it("names each distinct stub path from S1 through S10", () => {
    const values: string[] = Object.values(ADVISOR_STUB_PATHS);

    expect(values).toHaveLength(10);
    expect(new Set(values).size).toBe(10);
    expect([...values].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: 10 }, (_, index) => `S${index + 1}`)
    );
  });
});
