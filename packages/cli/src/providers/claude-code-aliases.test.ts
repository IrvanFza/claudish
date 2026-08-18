import { describe, expect, test } from "bun:test";
import { claudeCodeTierAlias } from "./claude-code-aliases.js";

describe("claudeCodeTierAlias", () => {
  test("maps every Claude Code alias to its tier", () => {
    const aliases = [
      ["opus", "opus"],
      ["sonnet", "sonnet"],
      ["haiku", "haiku"],
      ["internal", "opus"],
      ["default", "opus"],
    ] as const;

    for (const [alias, tier] of aliases) {
      expect(claudeCodeTierAlias(alias)).toBe(tier);
    }
  });

  test("ignores case and surrounding whitespace", () => {
    expect(claudeCodeTierAlias(" OPUS ")).toBe("opus");
  });

  test("does not classify concrete model ids as aliases", () => {
    const concreteModelIds = [
      "swe-1.7",
      "some-nonexistent-model-zzz",
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-luna",
      "",
    ];

    // A non-null result here would make `--probe` substitute a DIFFERENT
    // working model and report `live` for a name that 404s when runtime sends it
    // verbatim. In particular, a real id that merely contains a tier word, such
    // as `claude-opus-5`, is still a concrete model id, not an alias.
    for (const modelId of concreteModelIds) {
      expect(claudeCodeTierAlias(modelId)).toBeNull();
    }
  });
});
