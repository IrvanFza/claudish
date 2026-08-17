/**
 * R12 — where a predefined endpoint actually points.
 *
 * The bug these tests exist for: `classifyEndpointBaseUrl` read `process.env`
 * only, while `getEffectiveBaseUrl` (the documented chain, and the one the
 * whole rest of the codebase uses) reads `config.endpoints[VAR]` FIRST. The
 * config TUI's URL editor writes BOTH, so the divergence was invisible for the
 * rest of the session and appeared only after a restart — at which point the
 * TUI kept DISPLAYING the saved private URL while requests went to the bundled
 * public host. UI says private, wire says public: the R12 data-egress failure
 * inverted.
 *
 * Hermetic: `setConfigFileOverride` points `loadConfig()` at a temp file, so
 * nothing here reads or writes the developer's `~/.claudish/config.json`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../profile-config.js";
import { classifyEndpointBaseUrl, describeBadBaseUrlOverride } from "./custom-endpoints-loader.js";
import {
  type ProviderDefinition,
  baseUrlOverrideCandidates,
  getEffectiveBaseUrl,
} from "./provider-definitions.js";

const VAR = "PREDEF_TEST_BASE_URL";
const VAR2 = "PREDEF_TEST_BASE_URL_ALT";
const DECLARED = "https://api.bundled-vendor.example";

let dir: string;
let cfgPath: string;

/** Write a global config containing exactly these `endpoints` entries. */
function writeConfig(endpoints: Record<string, string>): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({ version: "1", defaultProfile: "default", profiles: {}, endpoints }, null, 2)
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-predef-baseurl-"));
  cfgPath = join(dir, "config.json");
  writeConfig({});
  setConfigFileOverride(cfgPath);
  delete process.env[VAR];
  delete process.env[VAR2];
});

afterEach(() => {
  setConfigFileOverride(null);
  delete process.env[VAR];
  delete process.env[VAR2];
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  setConfigFileOverride(null);
});

describe("classifyEndpointBaseUrl — config.endpoints is honoured (F8 / R12)", () => {
  test("a config-stored URL is used when the env var is unset", () => {
    writeConfig({ [VAR]: "https://gateway.internal.example" });
    const resolved = classifyEndpointBaseUrl(DECLARED, [VAR]);
    expect(resolved).toEqual({ ok: true, url: "https://gateway.internal.example" });
  });

  test("with NEITHER set, the bundled default stands", () => {
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({ ok: true, url: DECLARED });
  });

  test("a row declaring no override vars never consults config at all", () => {
    writeConfig({ [VAR]: "https://gateway.internal.example" });
    expect(classifyEndpointBaseUrl(DECLARED, undefined)).toEqual({ ok: true, url: DECLARED });
    expect(classifyEndpointBaseUrl(DECLARED, [])).toEqual({ ok: true, url: DECLARED });
    expect(baseUrlOverrideCandidates(undefined)).toEqual([]);
    expect(baseUrlOverrideCandidates([])).toEqual([]);
  });

  test("trailing slashes are stripped from a config value, as from an env one", () => {
    writeConfig({ [VAR]: "https://gateway.internal.example/" });
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({
      ok: true,
      url: "https://gateway.internal.example",
    });
  });
});

describe("classifyEndpointBaseUrl — precedence matches getEffectiveBaseUrl exactly", () => {
  test("config WINS over env for the same variable", () => {
    writeConfig({ [VAR]: "https://from-config.example" });
    process.env[VAR] = "https://from-env.example";
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({
      ok: true,
      url: "https://from-config.example",
    });
  });

  test("config wins as a TIER — config[second var] beats env[first var]", () => {
    // getEffectiveBaseUrl scans ALL vars in config before ANY var in env, so
    // this is not a per-variable comparison. Pinned because it is surprising.
    writeConfig({ [VAR2]: "https://from-config-alt.example" });
    process.env[VAR] = "https://from-env.example";
    expect(classifyEndpointBaseUrl(DECLARED, [VAR, VAR2])).toEqual({
      ok: true,
      url: "https://from-config-alt.example",
    });
  });

  test("the two resolvers agree on the same inputs", () => {
    const def = {
      name: "predef-test",
      baseUrl: DECLARED,
      baseUrlEnvVars: [VAR, VAR2],
    } as unknown as ProviderDefinition;

    // 1. nothing set
    expect(getEffectiveBaseUrl(def)).toBe(DECLARED);
    expect(classifyEndpointBaseUrl(DECLARED, [VAR, VAR2])).toEqual({ ok: true, url: DECLARED });

    // 2. env only
    process.env[VAR] = "https://from-env.example";
    expect(getEffectiveBaseUrl(def)).toBe("https://from-env.example");
    expect(classifyEndpointBaseUrl(DECLARED, [VAR, VAR2])).toEqual({
      ok: true,
      url: "https://from-env.example",
    });

    // 3. config + env
    writeConfig({ [VAR]: "https://from-config.example" });
    expect(getEffectiveBaseUrl(def)).toBe("https://from-config.example");
    expect(classifyEndpointBaseUrl(DECLARED, [VAR, VAR2])).toEqual({
      ok: true,
      url: "https://from-config.example",
    });
  });
});

describe("classifyEndpointBaseUrl — a malformed CONFIG value SKIPS, it does not fall back", () => {
  test("skip-not-fallback applies to a config-sourced value", () => {
    writeConfig({ [VAR]: "htp://not-a-url:9999" });
    const resolved = classifyEndpointBaseUrl(DECLARED, [VAR]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.envVar).toBe(VAR);
    expect(resolved.value).toBe("htp://not-a-url:9999");
    expect(resolved.source).toBe("config");
  });

  test("a malformed config value is NOT rescued by a valid env value", () => {
    // The whole point of the rule: a wrong destination is worse than none, and
    // "the other tier happened to be fine" is not a reason to proceed past a
    // value the user set on purpose.
    writeConfig({ [VAR]: "not a url at all" });
    process.env[VAR] = "https://from-env.example";
    expect(classifyEndpointBaseUrl(DECLARED, [VAR]).ok).toBe(false);
  });

  test("a malformed ENV value still skips, unchanged", () => {
    process.env[VAR] = "htp://not-a-url:9999";
    const resolved = classifyEndpointBaseUrl(DECLARED, [VAR]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.source).toBe("env");
  });

  test("a non-http(s) scheme is refused from either source", () => {
    for (const bad of ["file:///etc/passwd", "ftp://host/x", "ws://host"]) {
      process.env[VAR] = bad;
      expect(classifyEndpointBaseUrl(DECLARED, [VAR]).ok).toBe(false);
      delete process.env[VAR];
      writeConfig({ [VAR]: bad });
      expect(classifyEndpointBaseUrl(DECLARED, [VAR]).ok).toBe(false);
      writeConfig({});
    }
  });
});

describe("classifyEndpointBaseUrl — an unexpanded ${VAR} placeholder means UNSET", () => {
  test("a placeholder in config is skipped, not treated as malformed", () => {
    writeConfig({ [VAR]: "${SOME_UNSET_THING}" });
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({ ok: true, url: DECLARED });
  });

  test("a placeholder in env is skipped, not treated as malformed", () => {
    process.env[VAR] = "${SOME_UNSET_THING}";
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({ ok: true, url: DECLARED });
  });

  test("a placeholder in config falls through to a real env value", () => {
    writeConfig({ [VAR]: "${SOME_UNSET_THING}" });
    process.env[VAR] = "https://from-env.example";
    expect(classifyEndpointBaseUrl(DECLARED, [VAR])).toEqual({
      ok: true,
      url: "https://from-env.example",
    });
  });
});

describe("describeBadBaseUrlOverride", () => {
  test("the env-sourced sentence is unchanged byte for byte", () => {
    // Pinned against the recorded stderr transcript in the feature's live-run
    // validation document.
    expect(
      describeBadBaseUrlOverride(
        { envVar: "TUNING_ENGINES_BASE_URL", value: "htp://not-a-url:9999", source: "env" },
        "https://api.tuningengines.com"
      )
    ).toBe(
      "TUNING_ENGINES_BASE_URL is set to 'htp://not-a-url:9999', which is not a valid http(s) URL. " +
        "Fix or unset it. (Not falling back to https://api.tuningengines.com — the override was set on purpose.)"
    );
  });

  test("an absent source renders identically to an env one", () => {
    const withSource = describeBadBaseUrlOverride(
      { envVar: VAR, value: "bad", source: "env" },
      DECLARED
    );
    const withoutSource = describeBadBaseUrlOverride({ envVar: VAR, value: "bad" }, DECLARED);
    expect(withoutSource).toBe(withSource);
  });

  test("a config-sourced value names the config key, and 'unset it' is not the advice", () => {
    const msg = describeBadBaseUrlOverride(
      { envVar: VAR, value: "bad", source: "config" },
      DECLARED
    );
    expect(msg).toContain(`config.endpoints["${VAR}"]`);
    expect(msg).toContain("claudish config");
    expect(msg).not.toContain("unset it");
    // The refusal to fall back is stated in both variants.
    expect(msg).toContain(`Not falling back to ${DECLARED}`);
  });
});
