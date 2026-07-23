/**
 * `--config <file>` / `CLAUDISH_CONFIG` override — the single authority + its
 * two fundamental guarantees:
 *   1. A run's config comes ENTIRELY from the override file (global + project
 *      both collapse to it), driving loadConfig/loadLocalConfig.
 *   2. Because the override is faithful SUBSTITUTION (not a "disable 1Password"
 *      hack), an override file that names no op:// source makes hasOpSources()
 *      false on its own — so the lazy 1Password gate never opens (no SDK, no
 *      auth prompt). An override file that DOES name an op:// source still
 *      resolves it. This is what the user asked for: run a QA config without
 *      being asked for 1Password access, while a real op config still works.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeGlobalConfigFile,
  activeOpConfigPaths,
  getConfigFileOverride,
  planConfigOverride,
  setConfigFileOverride,
} from "./config-override.js";

describe("config-override authority", () => {
  afterEach(() => setConfigFileOverride(null)); // never leak override across tests

  test("no override → passthrough, byte-for-byte identical behavior", () => {
    expect(getConfigFileOverride()).toBeNull();
    expect(activeGlobalConfigFile("/real/config.json")).toBe("/real/config.json");
    const real = { global: () => "/g", project: () => "/p" };
    // Same object reference → zero behavior change on the normal path.
    expect(activeOpConfigPaths(real)).toBe(real);
  });

  test("override → global becomes the override file, project suppressed", () => {
    setConfigFileOverride("/tmp/qa.json");
    expect(getConfigFileOverride()).toBe("/tmp/qa.json");
    expect(activeGlobalConfigFile("/real/config.json")).toBe("/tmp/qa.json");

    const wrapped = activeOpConfigPaths({ global: () => "/g", project: () => "/p" });
    expect(wrapped.global()).toBe("/tmp/qa.json");
    // Suppressed sentinel: empty string → existsSync() is false everywhere, so
    // no project overlay leaks in under an override.
    expect(wrapped.project()).toBe("");
  });

  test("clearing the override restores passthrough", () => {
    setConfigFileOverride("/tmp/qa.json");
    setConfigFileOverride(null);
    expect(getConfigFileOverride()).toBeNull();
    expect(activeGlobalConfigFile("/real")).toBe("/real");
  });
});

describe("--config override drives profile-config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-cfgov-"));
  });
  afterEach(() => {
    setConfigFileOverride(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadConfig reads the override file; loadLocalConfig returns null", async () => {
    const { loadConfig, loadLocalConfig } = await import("./profile-config.js");
    const file = join(dir, "cfg.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: "1.0.0",
        defaultProvider: "litellm",
        apiKeys: { FOO_API_KEY: "literal-value" },
      })
    );
    setConfigFileOverride(file);

    const cfg = loadConfig();
    expect(cfg.defaultProvider).toBe("litellm");
    expect(cfg.apiKeys?.FOO_API_KEY).toBe("literal-value");
    // Project .claudish.json is fully ignored under an override.
    expect(loadLocalConfig()).toBeNull();
  });

  test("profile-config re-exports the SAME setter (single source of truth)", async () => {
    const pc = await import("./profile-config.js");
    expect(pc.setConfigFileOverride).toBe(setConfigFileOverride);
  });
});

describe("--config override + the 1Password gate (op-source)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-cfgop-"));
    // A stray CLAUDISH_DISABLE_OP would trivially force hasOpSources() false and
    // mask what we're actually asserting — the override doing it on its own.
    delete process.env.CLAUDISH_DISABLE_OP;
  });
  afterEach(async () => {
    setConfigFileOverride(null);
    const { __resetSniffForTests } = await import("./auth/credentials/op-source.js");
    __resetSniffForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("override file with NO op:// source → hasOpSources() false (no SDK, no prompt)", async () => {
    const { hasOpSources, __resetSniffForTests } = await import("./auth/credentials/op-source.js");
    const file = join(dir, "qa.json");
    // Literal keys only — the exact shape of the user's QA config.
    writeFileSync(file, JSON.stringify({ apiKeys: { XAI_API_KEY: "sk-fake-literal" } }));
    setConfigFileOverride(file);
    __resetSniffForTests(); // config changed → recompute the memoized sniff

    expect(hasOpSources()).toBe(false);
  });

  test("override file WITH an op:// apiKey → hasOpSources() true (faithful substitution)", async () => {
    const { hasOpSources, __resetSniffForTests } = await import("./auth/credentials/op-source.js");
    const file = join(dir, "op.json");
    writeFileSync(file, JSON.stringify({ apiKeys: { XAI_API_KEY: "op://Vault/Item/field" } }));
    setConfigFileOverride(file);
    __resetSniffForTests();

    // Not a blanket disable: an op:// ref in the override IS honored.
    expect(hasOpSources()).toBe(true);
  });
});

describe("planConfigOverride", () => {
  const deps = {
    resolve: (path: string) => `/resolved${path}`,
    exists: () => true,
  };

  function expectApply(plan: ReturnType<typeof planConfigOverride>) {
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") {
      throw new Error(`expected apply plan, received ${plan.kind}`);
    }
    return plan;
  }

  test("returns none when neither the flag nor environment requests an override", () => {
    // Normal config discovery must stay in charge when no override was requested.
    expect(planConfigOverride(["prompt"], {}, deps)).toEqual({ kind: "none" });
  });

  test("applies and strips a separated --config flag", () => {
    const plan = expectApply(planConfigOverride(["--config", "/path/qa.json"], {}, deps));

    expect(plan.path).toBe("/resolved/path/qa.json");
    expect(plan.fromFlag).toBe(true);
    expect(plan.argv).toEqual([]);
  });

  test("applies and strips an equals-form --config flag", () => {
    const plan = expectApply(planConfigOverride(["--config=/path/qa.json", "prompt"], {}, deps));

    expect(plan.path).toBe("/resolved/path/qa.json");
    expect(plan.fromFlag).toBe(true);
    expect(plan.argv).toEqual(["prompt"]);
  });

  test("preserves surrounding argument order while stripping the flag", () => {
    // Wrapper-only arguments must disappear without disturbing the child command.
    const plan = expectApply(
      planConfigOverride(["--model", "gpt-4o", "--config", "/qa.json", "prompt text"], {}, deps)
    );

    expect(plan.argv).toEqual(["--model", "gpt-4o", "prompt text"]);
  });

  test("applies CLAUDISH_CONFIG without changing argv", () => {
    const argv = ["--model", "gpt-4o", "prompt text"];
    const plan = expectApply(planConfigOverride(argv, { CLAUDISH_CONFIG: "/env/qa.json" }, deps));

    expect(plan.path).toBe("/resolved/env/qa.json");
    expect(plan.fromFlag).toBe(false);
    expect(plan.argv).toEqual(argv);
  });

  test("prefers the explicit flag over CLAUDISH_CONFIG", () => {
    // A per-invocation choice must override inherited process configuration.
    const plan = expectApply(
      planConfigOverride(["--config", "/flag.json"], { CLAUDISH_CONFIG: "/env.json" }, deps)
    );

    expect(plan.path).toBe("/resolved/flag.json");
    expect(plan.fromFlag).toBe(true);
  });

  test("rejects a dangling --config flag", () => {
    expect(planConfigOverride(["--config"], {}, deps)).toEqual({
      kind: "error",
      message: "[claudish] --config requires a file path",
    });
  });

  test("rejects another flag as the --config filename", () => {
    expect(planConfigOverride(["--config", "--debug"], {}, deps)).toEqual({
      kind: "error",
      message: "[claudish] --config requires a file path",
    });
  });

  test("rejects an empty equals-form --config value", () => {
    expect(planConfigOverride(["--config="], {}, deps)).toEqual({
      kind: "error",
      message: "[claudish] --config requires a file path",
    });
  });

  test("ignores an empty CLAUDISH_CONFIG value", () => {
    // Empty inherited variables should behave like an unset override.
    expect(planConfigOverride([], { CLAUDISH_CONFIG: "" }, deps)).toEqual({ kind: "none" });
  });

  test("reports a missing file with its resolved path", () => {
    const plan = planConfigOverride(
      ["--config", "/missing.json"],
      {},
      {
        ...deps,
        exists: () => false,
      }
    );

    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") {
      throw new Error(`expected error plan, received ${plan.kind}`);
    }
    expect(plan.message).toStartWith("[claudish] --config file not found:");
    expect(plan.message).toContain("/resolved/missing.json");
  });

  test("consumes only the first --config occurrence", () => {
    // Later tokens may belong to a child invocation and must remain untouched.
    const plan = expectApply(
      planConfigOverride(
        ["--config", "/first.json", "--config", "/second.json", "prompt"],
        {},
        deps
      )
    );

    expect(plan.path).toBe("/resolved/first.json");
    expect(plan.argv).toEqual(["--config", "/second.json", "prompt"]);
  });
});
