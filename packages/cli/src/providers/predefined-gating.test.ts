/**
 * C3 / R2-R5: a synthetic catalog row is visible only when the activation
 * predicate admits it. The three user-facing surfaces are asserted together so
 * a provider cannot exist in lookup while leaking into (or disappearing from)
 * the picker namespace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildProviderChoices, getProviderFilterAliases } from "../model-selector.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
import {
  __resetPredefinedStateForTests,
  __setPredefinedCatalogForTests,
  loadPredefinedEndpoints,
} from "./predefined-endpoints.js";
import { getAllProviders, getProviderByName, getShortcuts } from "./provider-definitions.js";
import { clearRuntimeRegistry } from "./runtime-providers.js";

const PRIMARY_KEY = "ACME_API_KEY";
const CUSTOM_KEY = "CUSTOM_ACME_KEY";
const KILL_SWITCH = "CLAUDISH_NO_PREDEFINED_ENDPOINTS";
const ENV_KEYS = [PRIMARY_KEY, CUSTOM_KEY, KILL_SWITCH] as const;

const ROW: PredefinedEndpoint = {
  name: "acme",
  displayName: "Acme",
  baseUrl: "https://api.acme.example",
  apiPath: "/v1/chat/completions",
  format: "openai",
  apiKeyEnvVar: PRIMARY_KEY,
  evidence: { tier: "probe", verdict: "auth-realm", measuredAt: "2026-08-14" },
};

let savedEnv: Map<string, string | undefined>;
let warnings: string[];
let realError: typeof console.error;

function config(overrides: Partial<ClaudishProfileConfig> = {}): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    ...overrides,
  } as ClaudishProfileConfig;
}

function aliasesContainAcme(): boolean {
  const aliases = getProviderFilterAliases();
  return aliases.acme === ROW.name || Object.values(aliases).includes(ROW.name);
}

function pickerContainsAcme(): boolean {
  return buildProviderChoices().some((choice) => choice.value === ROW.name);
}

function expectAbsent(): void {
  expect(getProviderByName(ROW.name)).toBeUndefined();
  expect(pickerContainsAcme()).toBe(false);
  expect(aliasesContainAcme()).toBe(false);
}

function expectPresent(): void {
  expect(getProviderByName(ROW.name)).toBeDefined();
  expect(pickerContainsAcme()).toBe(true);
  expect(aliasesContainAcme()).toBe(true);
}

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  clearRuntimeRegistry();
  __resetPredefinedStateForTests();
  __setPredefinedCatalogForTests([ROW]);

  warnings = [];
  realError = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = realError;
  __setPredefinedCatalogForTests(null);
  __resetPredefinedStateForTests();
  clearRuntimeRegistry();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("predefined endpoint credential gating", () => {
  test("an unset credential is absent from lookup, picker choices, and filter aliases", () => {
    loadPredefinedEndpoints(config());
    expectAbsent();
  });

  test("the declared vendor credential activates all three surfaces", () => {
    process.env[PRIMARY_KEY] = "test-key";
    loadPredefinedEndpoints(config());
    expectPresent();
    expect(getShortcuts()[ROW.name]).toBe(ROW.name);
  });

  test("an empty declared credential is absent", () => {
    process.env[PRIMARY_KEY] = "";
    loadPredefinedEndpoints(config());
    expectAbsent();
  });

  test("an unexpanded credential placeholder is absent", () => {
    process.env[PRIMARY_KEY] = "${ACME_API_KEY}";
    loadPredefinedEndpoints(config());
    expectAbsent();
  });

  test("the synthesized CUSTOM_<NAME>_KEY alias activates the row", () => {
    process.env[CUSTOM_KEY] = "test-alias-key";
    loadPredefinedEndpoints(config());
    expectPresent();
  });

  test("an explicit enable activates a row without a credential", () => {
    loadPredefinedEndpoints(config({ predefinedEndpoints: { enable: [ROW.name] } }));
    expectPresent();
  });

  test("a per-row disable refuses a row even when its credential is present", () => {
    process.env[PRIMARY_KEY] = "test-key";
    loadPredefinedEndpoints(config({ predefinedEndpoints: { disable: [ROW.name] } }));
    expectAbsent();
  });

  test("enabled: false disables the whole catalog", () => {
    process.env[PRIMARY_KEY] = "test-key";
    loadPredefinedEndpoints(config({ predefinedEndpoints: { enabled: false } }));
    expectAbsent();
  });

  test("the environment kill switch disables the whole catalog", () => {
    process.env[PRIMARY_KEY] = "test-key";
    process.env[KILL_SWITCH] = "1";
    loadPredefinedEndpoints(config());
    expectAbsent();
  });

  test("disable beats enable when the same row appears in both", () => {
    loadPredefinedEndpoints(
      config({ predefinedEndpoints: { disable: [ROW.name], enable: [ROW.name] } })
    );
    expectAbsent();
  });

  test("disabling an unknown name is a no-op for other rows", () => {
    process.env[PRIMARY_KEY] = "test-key";
    expect(() =>
      loadPredefinedEndpoints(config({ predefinedEndpoints: { disable: ["does-not-exist"] } }))
    ).not.toThrow();
    expectPresent();
  });

  test("duplicate catalog names register once and warn", () => {
    process.env[PRIMARY_KEY] = "test-key";
    __setPredefinedCatalogForTests([ROW, { ...ROW, baseUrl: "https://duplicate.acme.example" }]);

    const result = loadPredefinedEndpoints(config());

    expect(result.registered).toEqual([ROW.name]);
    expect(result.skipped).toEqual([{ name: ROW.name, reason: "duplicate row" }]);
    expect(getAllProviders().filter((provider) => provider.name === ROW.name)).toHaveLength(1);
    expect(warnings.some((warning) => warning.includes("appears more than once"))).toBe(true);
  });
});
