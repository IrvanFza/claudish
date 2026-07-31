import { describe, it, expect } from "bun:test";
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
});
