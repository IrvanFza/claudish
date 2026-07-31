import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHookRules } from "./hooks.js";

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "claudish-behavior-hooks-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validHookSource(id: string, description: string, severity?: "off" | "warn" | "fix") {
  const severityLine = severity ? `defaultSeverity: "${severity}",` : "";
  return `
export default {
  id: ${JSON.stringify(id)},
  description: ${JSON.stringify(description)},
  ${severityLine}
  appliesTo: () => true,
  onRequest: () => [],
};
`;
}

describe("loadHookRules", () => {
  it("returns an empty array for empty or undefined path lists", async () => {
    expect(await loadHookRules([])).toEqual([]);
    expect(await loadHookRules(undefined)).toEqual([]);
  });

  it("loads a valid hook and namespaces its id with the filename", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "valid-hook.ts");
      writeFileSync(path, validHookSource("custom-rule", "valid rule", "fix"));

      const rules = await loadHookRules([path]);

      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("hook:valid-hook/custom-rule");
      expect(rules[0].description).toBe("valid rule");
      expect(rules[0].defaultSeverity).toBe("fix");
    });
  });

  it("skips a module that exports no valid rule without throwing", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "invalid-hook.ts");
      writeFileSync(path, "export const answer = 42;\n");

      let rules: Awaited<ReturnType<typeof loadHookRules>> | undefined;
      await expect(
        (async () => {
          rules = await loadHookRules([path]);
        })()
      ).resolves.toBeUndefined();
      expect(rules).toEqual([]);
    });
  });

  it("skips a nonexistent hook path without throwing", async () => {
    await inTempDir(async (dir) => {
      const missing = join(dir, "does-not-exist.ts");

      await expect(loadHookRules([missing])).resolves.toEqual([]);
    });
  });

  it("continues loading after one hook fails to import", async () => {
    await inTempDir(async (dir) => {
      const broken = join(dir, "broken.ts");
      const valid = join(dir, "healthy.ts");
      writeFileSync(broken, 'throw new Error("broken hook");\n');
      writeFileSync(valid, validHookSource("survivor", "healthy rule", "fix"));

      const rules = await loadHookRules([broken, valid]);

      expect(rules.map((rule) => rule.id)).toEqual(["hook:healthy/survivor"]);
    });
  });

  it("defaults an omitted severity to warn", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "safe-default.ts");
      writeFileSync(path, validHookSource("no-severity", "safe default"));

      const rules = await loadHookRules([path]);

      expect(rules).toHaveLength(1);
      expect(rules[0].defaultSeverity).toBe("warn");
    });
  });

  it("keeps the first rule when namespaced ids are duplicated", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "duplicates.ts");
      writeFileSync(
        path,
        `
const first = {
  id: "same-id",
  description: "first",
  defaultSeverity: "fix",
  appliesTo: () => true,
};
const second = {
  id: "same-id",
  description: "second",
  defaultSeverity: "off",
  appliesTo: () => true,
};
export default [first, second];
`
      );

      const rules = await loadHookRules([path]);

      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("hook:duplicates/same-id");
      expect(rules[0].description).toBe("first");
      expect(rules[0].defaultSeverity).toBe("fix");
    });
  });
});
