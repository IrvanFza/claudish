import { describe, it, expect } from "bun:test";
import { detectHarnessFacts } from "./harness.js";

describe("detectHarnessFacts", () => {
  const anchorCases = [
    [
      "You should create your plan at /workspace/.team/plans/assigned-alpha.md before exiting.",
      "/workspace/.team/plans/assigned-alpha.md",
    ],
    [
      "A plan file already exists at /tmp/custom-plan-root/assigned-beta.md and should be updated.",
      "/tmp/custom-plan-root/assigned-beta.md",
    ],
    [
      "Read-only except plan file (/opt/project/private-plans/assigned-gamma.md)",
      "/opt/project/private-plans/assigned-gamma.md",
    ],
  ] as const;

  for (const [reminder, expectedPath] of anchorCases) {
    it(`extracts the assigned path from ${reminder.split(" at ")[0]}`, () => {
      const facts = detectHarnessFacts({ system: reminder, messages: [] });

      expect(facts.planModeActive).toBe(true);
      expect(facts.planFilePath).toBe(expectedPath);
      expect(facts.planDir).toBe(expectedPath.slice(0, expectedPath.lastIndexOf("/")));
    });
  }

  it("honours a non-default plan directory instead of inferring ~/.claude/plans", () => {
    const assignedPath = "/workspace/repo/.custom/approval-plans/session-42.md";
    const facts = detectHarnessFacts({
      system: `Plan mode is active. You should create your plan at ${assignedPath}`,
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: assignedPath,
      planDir: "/workspace/repo/.custom/approval-plans",
    });
  });

  it("returns inactive facts for ordinary text without a plan anchor", () => {
    const facts = detectHarnessFacts({
      system: "Write a project plan and save useful Markdown documentation.",
      messages: [{ role: "user", content: "Please review docs/plan.md." }],
    });

    expect(facts).toEqual({ planModeActive: false });
  });

  it("finds the latest reminder by scanning a long message array backwards", () => {
    const olderPath = "/tmp/old-plans/old.md";
    const latestPath = "/tmp/latest-plans/current.md";
    const messages = [
      { role: "user", content: `You should create your plan at ${olderPath}` },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `ordinary conversation turn ${index}`,
      })),
      {
        role: "user",
        content: `Plan mode still active. A plan file already exists at ${latestPath}`,
      },
    ];

    const facts = detectHarnessFacts({ messages });

    expect(facts.planFilePath).toBe(latestPath);
    expect(facts.planDir).toBe("/tmp/latest-plans");
  });

  it("reads a string system prompt", () => {
    const path = "/tmp/string-system/plan.md";

    expect(detectHarnessFacts({ system: `You should create your plan at ${path}` })).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/string-system",
    });
  });

  it("reads text blocks from an array system prompt", () => {
    const path = "/tmp/block-system/plan.md";
    const facts = detectHarnessFacts({
      system: [
        { type: "text", text: "Plan mode is active. " },
        { type: "text", text: `Read-only except plan file (${path})` },
      ],
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/block-system",
    });
  });
});
