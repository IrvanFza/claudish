import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_SCHEMA_VERSION,
  classifyPath,
  recordDecision,
  toUploadable,
  type JournalEntry,
} from "./journal.js";

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "claudish-behavior-journal-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2026-08-04T00:00:00.000Z",
    model: "gpt-5.6-codex",
    provider: "openai",
    surface: "tool_call",
    decision: "repaired",
    ruleId: "plan-path",
    toolName: "Write",
    argKeys: ["file_path", "content"],
    pathRelation: "same_dir_wrong_name",
    ...overrides,
  };
}

describe("toUploadable", () => {
  it("preserves the non-identifying signal while stripping all local path detail", () => {
    const entry = journalEntry({
      local: {
        observedPath: "/Users/jack/dev/acme/acme-portal/plans/wrong.md",
        expectedPath: "/Users/jack/dev/acme/acme-portal/plans/assigned.md",
        note: "jack wrote wrong.md for the acme portal instead of assigned.md",
      },
    });

    const uploadable = toUploadable(entry);
    const serialized = JSON.stringify(uploadable);

    for (const identifyingFragment of [
      "/Users",
      "jack",
      "acme",
      "acme-portal",
      "wrong.md",
      "assigned.md",
    ]) {
      expect(serialized).not.toContain(identifyingFragment);
    }
    expect(Object.hasOwn(uploadable, "local")).toBe(false);
    expect(serialized).not.toContain('"local"');
    expect(uploadable).toEqual({
      schema: JOURNAL_SCHEMA_VERSION,
      ts: entry.ts,
      model: entry.model,
      provider: entry.provider,
      surface: entry.surface,
      decision: entry.decision,
      ruleId: entry.ruleId,
      toolName: entry.toolName,
      argKeys: entry.argKeys,
      pathRelation: entry.pathRelation,
    });
    expect(uploadable.schema).toBe(JOURNAL_SCHEMA_VERSION);
  });

  it("does not upload fields added to a local entry unless explicitly allowed", () => {
    const entry = {
      ...journalEntry(),
      futureSensitiveField: "top-secret-client-name",
    } as JournalEntry;

    const serialized = JSON.stringify(toUploadable(entry));

    expect(serialized).not.toContain("futureSensitiveField");
    expect(serialized).not.toContain("top-secret-client-name");
  });
});

describe("classifyPath", () => {
  it("classifies every path relationship", () => {
    const cases: Array<{
      observed?: string;
      expected?: string;
      relation: ReturnType<typeof classifyPath>;
    }> = [
      {
        observed: "/tmp/plans/assigned.md",
        expected: "/tmp/plans/assigned.md",
        relation: "as_expected",
      },
      { observed: "wrong.md", expected: "assigned.md", relation: "same_dir_wrong_name" },
      {
        observed: "/tmp/other/wrong.md",
        expected: "/tmp/plans/assigned.md",
        relation: "outside_expected_dir",
      },
      { observed: undefined, expected: "/tmp/plans/assigned.md", relation: "not_applicable" },
      { observed: "/tmp/plans/assigned.md", expected: undefined, relation: "no_expectation" },
    ];

    for (const { observed, expected, relation } of cases) {
      expect(classifyPath(observed, expected)).toBe(relation);
    }
  });
});

describe("recordDecision", () => {
  it("creates parent directories and appends one round-trippable JSON line per call", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "missing", "nested", "journal.jsonl");
      const first = journalEntry();
      const second = journalEntry({
        ts: "2026-08-04T00:00:01.000Z",
        decision: "warned",
        pathRelation: "outside_expected_dir",
      });

      expect(existsSync(join(dir, "missing", "nested"))).toBe(false);
      await recordDecision(first, path);
      await recordDecision(second, path);

      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe("");
      expect(JSON.parse(lines[0])).toEqual(first);
      expect(JSON.parse(lines[1])).toEqual(second);
    });
  });

  it("resolves when the journal path is unwritable", async () => {
    await inTempDir(async (dir) => {
      const parentFile = join(dir, "not-a-directory");
      writeFileSync(parentFile, "block parent directory creation");

      await expect(recordDecision(journalEntry(), join(parentFile, "journal.jsonl"))).resolves.toBeUndefined();
    });
  });

  it("does not append when the existing journal is larger than 32 MB", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "journal.jsonl");
      writeFileSync(path, "seed");
      truncateSync(path, 32 * 1024 * 1024 + 1);
      const sizeBefore = statSync(path).size;

      await recordDecision(journalEntry(), path);

      expect(statSync(path).size).toBe(sizeBefore);
    });
  });
});
