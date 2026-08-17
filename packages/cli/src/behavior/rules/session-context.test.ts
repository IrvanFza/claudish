import { describe, expect, it } from "bun:test";
import {
  SESSION_CONTEXT_RULES,
  hasInjectedSessionContext,
  noHarnessEchoRule,
} from "./session-context.js";

const MARKER = "SessionStart hook additional context";

function requestContext(systemText = "", messages: unknown[] = [], isNativeAnthropic = false) {
  const context = {
    systemText,
    messages,
    modelId: "m",
    providerName: "p",
    isNativeAnthropic,
  };

  // biome-ignore lint/suspicious/noExplicitAny: This rule reads only the literal fields above.
  return context as any;
}

describe("hasInjectedSessionContext", () => {
  it("detects the marker in system text", () => {
    expect(hasInjectedSessionContext(MARKER, [])).toBe(true);
  });

  it("detects the marker in the first message's string content", () => {
    expect(hasInjectedSessionContext("", [{ content: MARKER }])).toBe(true);
  });

  it("detects the marker in a text content block in the first message", () => {
    const messages = [{ content: [{ type: "text", text: MARKER }] }];

    expect(hasInjectedSessionContext("", messages)).toBe(true);
  });

  it("returns false for ordinary and empty input", () => {
    expect(hasInjectedSessionContext("You are a helpful assistant.", [])).toBe(false);
    expect(hasInjectedSessionContext("", [])).toBe(false);
  });

  it("does not scan later messages", () => {
    // Only messages[0] is scanned so the model's own earlier echo cannot re-arm the rule.
    expect(
      hasInjectedSessionContext("", [
        { content: "An ordinary first message." },
        { content: MARKER },
      ])
    ).toBe(false);
  });

  it("matches upper- and lower-case marker variants", () => {
    expect(hasInjectedSessionContext("SESSIONSTART HOOK ADDITIONAL CONTEXT", [])).toBe(true);
    expect(hasInjectedSessionContext("sessionstart hook additional context", [])).toBe(true);
  });
});

describe("noHarnessEchoRule", () => {
  it("applies only to foreign models", () => {
    expect(noHarnessEchoRule.appliesTo(requestContext("", [], true))).toBe(false);
    expect(noHarnessEchoRule.appliesTo(requestContext("", [], false))).toBe(true);
  });

  it("injects exactly one system note when context is present", () => {
    const actions = noHarnessEchoRule.onRequest!(requestContext(MARKER));

    expect(actions).toEqual([{ type: "injectSystemNote", text: expect.any(String) }]);
  });

  it("returns no actions when context is absent", () => {
    expect(noHarnessEchoRule.onRequest!(requestContext("An ordinary system prompt."))).toEqual([]);
  });
});

describe("SESSION_CONTEXT_RULES", () => {
  it("contains noHarnessEchoRule", () => {
    expect(SESSION_CONTEXT_RULES).toContain(noHarnessEchoRule);
  });
});
