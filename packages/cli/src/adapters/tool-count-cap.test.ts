/**
 * Regression: per-API tool-count cap.
 *
 * OpenAI's Chat Completions API hard-caps the `tools` array at 128; exceeding it
 * fails the whole request with HTTP 400 "Invalid 'tools': array too long". A cap
 * existed in v6.4.5 (commit 498a2ed) but was deleted in the Firebase-migration
 * commit 3edc60f, which left a false "enforced by the transport" comment — no
 * transport ever implemented it, so every OpenAI run with >128 tools failed.
 *
 * The cap is now a per-format hook (`getMaxToolCount()`) enforced by
 * ComposedHandler via a head-slice. These tests pin the hook values; the
 * ComposedHandler head-slice is exercised by the live `oai@` path.
 */

import { describe, expect, test } from "bun:test";
import { CodexAPIFormat } from "./codex-api-format.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";

describe("getMaxToolCount — per-API tool-count cap", () => {
  test("OpenAI Chat Completions caps tools at 128", () => {
    expect(new OpenAIAPIFormat("gpt-4o").getMaxToolCount()).toBe(128);
  });

  test("Codex (Responses API) is NOT capped here (separate class)", () => {
    // Codex is a distinct format; the 128 cap is scoped to OpenAIAPIFormat only.
    expect(new CodexAPIFormat("gpt-5-codex").getMaxToolCount()).toBeNull();
  });

  test("other formats inherit the no-cap default (null)", () => {
    expect(new GeminiAPIFormat("gemini-2.0-flash").getMaxToolCount()).toBeNull();
  });

  test("head-slice semantics: slicing to the cap keeps the first N tools", () => {
    // Mirrors the ComposedHandler slice: built-in tools come first and survive,
    // tail-most MCP tools are dropped.
    const cap = new OpenAIAPIFormat("gpt-4o").getMaxToolCount();
    const tools = Array.from({ length: 165 }, (_, i) => ({ name: `tool_${i}` }));
    const sliced = cap && tools.length > cap ? tools.slice(0, cap) : tools;
    expect(sliced).toHaveLength(128);
    expect(sliced[0]?.name).toBe("tool_0"); // first (built-in) preserved
    expect(sliced[127]?.name).toBe("tool_127"); // tail dropped at the cap
  });
});
