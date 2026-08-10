import { describe, expect, test } from "bun:test";
import {
  ACTIVE_WINDOW_MS,
  type SessionRow,
  isActive,
  sessionLabel,
  slugForPath,
} from "./session-discovery.js";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-id",
    file: "/not/read/by-these-tests/session-id.jsonl",
    mtimeMs: 0,
    sizeBytes: 1,
    ...overrides,
  };
}

describe("session discovery pure helpers", () => {
  test("slugForPath replaces both slashes and dots without collapsing them", () => {
    expect(slugForPath("/a/b")).toBe("-a-b");
    expect(slugForPath("/Users/x/.claude/worktrees/y")).toBe("-Users-x--claude-worktrees-y");
  });

  test("isActive respects the explicit recency-window boundary", () => {
    const now = 1_000_000;

    expect(isActive(row({ mtimeMs: now - ACTIVE_WINDOW_MS + 1 }), now)).toBe(true);
    expect(isActive(row({ mtimeMs: now - ACTIVE_WINDOW_MS - 1 }), now)).toBe(false);
  });

  test("sessionLabel prefers title, then first prompt, then id", () => {
    expect(
      sessionLabel(row({ title: "Generated title", firstPrompt: "Opening prompt", id: "fallback" }))
    ).toBe("Generated title");
    expect(sessionLabel(row({ firstPrompt: "Opening prompt", id: "fallback" }))).toBe(
      "Opening prompt"
    );
    expect(sessionLabel(row({ id: "fallback" }))).toBe("fallback");
  });
});
