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
