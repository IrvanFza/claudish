import { describe, expect, test } from "bun:test";
import { stripBillingHeader, transformOpenAIToClaude } from "./transform.js";

const CAPTURED_BILLING_HEADER =
  "x-anthropic-billing-header: cc_version=2.1.107.3d9; cc_entrypoint=cli; cch=74943;";
const REAL_SYSTEM_CONTENT = "You are Claude Code, Anthropic's official CLI for Claude.";

function capturedSystem(header = CAPTURED_BILLING_HEADER) {
  return [
    {
      type: "text",
      text: header,
    },
    {
      type: "text",
      text: REAL_SYSTEM_CONTENT,
      cache_control: {
        type: "ephemeral",
      },
    },
  ];
}

describe("billing header removal", () => {
  test("removes a header-only array block without leaving an empty string", () => {
    const { claudeRequest } = transformOpenAIToClaude({
      system: capturedSystem(),
    });

    expect(claudeRequest.system).not.toContain("x-anthropic-billing-header");
    expect(claudeRequest.system).toBe(REAL_SYSTEM_CONTENT);
    expect(claudeRequest.system.split("\n\n")).toEqual([REAL_SYSTEM_CONTENT]);
  });

  test("keeps req.system byte-identical across requests whose only difference is the per-turn cch hash", () => {
    const firstRequest = {
      system: capturedSystem(),
    };
    const secondRequest = {
      system: capturedSystem(CAPTURED_BILLING_HEADER.replace("cch=74943", "cch=74944")),
    };

    const firstSystem = transformOpenAIToClaude(firstRequest).claudeRequest.system;
    const secondSystem = transformOpenAIToClaude(secondRequest).claudeRequest.system;

    expect(firstSystem).toBe(secondSystem);
    expect(new TextEncoder().encode(firstSystem)).toEqual(new TextEncoder().encode(secondSystem));
  });

  test("strips an inline header from a string system while preserving surrounding lines", () => {
    const system = `First system line\n${CAPTURED_BILLING_HEADER}\nLast system line`;

    const { claudeRequest } = transformOpenAIToClaude({ system });

    expect(claudeRequest.system).toBe("First system line\nLast system line");
  });

  test("passes a system with no billing header through completely unchanged", () => {
    const system = "First line\n\nSecond line with punctuation: cc_version=unchanged;\n";

    const { claudeRequest } = transformOpenAIToClaude({ system });

    expect(claudeRequest.system).toBe(system);
  });

  test("strips a header at the end of content with no trailing newline", () => {
    const system = `Stable system content\n${CAPTURED_BILLING_HEADER}`;

    const { claudeRequest } = transformOpenAIToClaude({ system });

    expect(claudeRequest.system).toBe("Stable system content\n");
    expect(claudeRequest.system).not.toContain("x-anthropic-billing-header");
  });

  test("stripBillingHeader returns text with no header unchanged", () => {
    const text = "System content without a billing header.\nPreserve this exactly.\n";

    expect(stripBillingHeader(text)).toBe(text);
  });
});
