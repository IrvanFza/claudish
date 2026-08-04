import { describe, expect, it } from "bun:test";
import { parseBehaviorConfig, resolveSeverity } from "./config.js";

describe("parseBehaviorConfig", () => {
  it("degrades invalid config to an empty object without throwing", () => {
    let parsed: ReturnType<typeof parseBehaviorConfig> | undefined;

    expect(() => {
      parsed = parseBehaviorConfig({
        rules: { "plan-mode/plan-file-path": "rewrite-everything" },
        observer: { timeoutMs: -1 },
      });
    }).not.toThrow();
    expect(parsed).toEqual({});
  });
});

describe("resolveSeverity", () => {
  it("prefers an exact rule id over a matching glob", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", {
        rules: {
          "plan-mode/*": "off",
          "plan-mode/plan-file-path": "fix",
        },
      })
    ).toBe("fix");
  });

  it("uses the longest matching glob", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", {
        rules: {
          "*": "off",
          "plan-*": "warn",
          "plan-mode/plan-*": "fix",
        },
      })
    ).toBe("fix");
  });

  it("allows a specific rule to be re-enabled inside a disabled namespace", () => {
    const config = {
      rules: {
        "plan-mode/*": "off" as const,
        "plan-mode/plan-file-path": "fix" as const,
      },
    };

    expect(resolveSeverity("plan-mode/other-rule", "warn", config)).toBe("off");
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", config)).toBe("fix");
  });

  it("falls back to the rule's default severity when unconfigured", () => {
    expect(resolveSeverity("plan-mode/plan-file-path", "fix", {})).toBe("fix");
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", {
        rules: { "other-namespace/*": "off" },
      })
    ).toBe("warn");
  });

  it("uses an unscoped key when no model-scoped key matches", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          rules: {
            "plan-mode/plan-file-path": "fix",
            "other-model:plan-mode/plan-file-path": "off",
          },
        },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("lets a matching model-scoped key beat an unscoped key", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          rules: {
            "plan-mode/plan-file-path": "off",
            "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
          },
        },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("does not apply a model-scoped key to a different model", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          rules: {
            "plan-mode/plan-file-path": "warn",
            "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
          },
        },
        "gpt-5.6-codex"
      )
    ).toBe("warn");
  });

  it("matches model globs", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        { rules: { "gpt-5.6-*:plan-mode/plan-file-path": "fix" } },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("prefers an exact rule id over a rule glob in both scope tiers", () => {
    const unscoped = {
      rules: {
        "plan-mode/*": "off" as const,
        "plan-mode/plan-file-path": "fix" as const,
      },
    };
    const scoped = {
      rules: {
        "gpt-5.6-*:plan-mode/*": "off" as const,
        "gpt-5.6-*:plan-mode/plan-file-path": "fix" as const,
      },
    };

    expect(resolveSeverity("plan-mode/plan-file-path", "warn", unscoped, "gpt-5.6-sol")).toBe(
      "fix"
    );
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", scoped, "gpt-5.6-sol")).toBe("fix");
  });

  it("prefers the longer rule glob in both scope tiers", () => {
    const unscoped = {
      rules: {
        "plan-*": "off" as const,
        "plan-mode/plan-*": "fix" as const,
      },
    };
    const scoped = {
      rules: {
        "gpt-5.6-*:plan-*": "off" as const,
        "gpt-5.6-*:plan-mode/plan-*": "fix" as const,
      },
    };

    expect(resolveSeverity("plan-mode/plan-file-path", "warn", unscoped, "gpt-5.6-sol")).toBe(
      "fix"
    );
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", scoped, "gpt-5.6-sol")).toBe("fix");
  });

  it("does not mis-parse a hook rule id as a model scope", () => {
    expect(
      resolveSeverity(
        "hook:my-file/my-rule",
        "warn",
        { rules: { "hook:my-file/my-rule": "fix" } },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("uses unscoped-only behavior when modelId is omitted", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "off", {
        rules: {
          "plan-mode/plan-file-path": "warn",
          "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
        },
      })
    ).toBe("warn");
  });
});
