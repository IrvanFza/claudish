/**
 * C5 / R6: bundled rows cannot claim any live builtin namespace, even when a
 * user explicitly places the colliding row in `enable`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProviderFilterAliases } from "../model-selector.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { PROVIDER_FILTER_ALIAS_EXTRA } from "./picker-alias-extra.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
import {
  __resetPredefinedStateForTests,
  __setPredefinedCatalogForTests,
  loadPredefinedEndpoints,
} from "./predefined-endpoints.js";
import { BUILTIN_PROVIDERS, getProviderByName, getShortcuts } from "./provider-definitions.js";
import { clearRuntimeRegistry, getRuntimeProviders } from "./runtime-providers.js";

const KILL_SWITCH = "CLAUDISH_NO_PREDEFINED_ENDPOINTS";
const COLLISION_KEYS = [
  "MISTRAL_COLLISION_TEST_KEY",
  "OPENROUTER_COLLISION_TEST_KEY",
  "ZEN_COLLISION_TEST_KEY",
] as const;
const ENV_KEYS = [...COLLISION_KEYS, KILL_SWITCH] as const;

let savedEnv: Map<string, string | undefined>;
let warnings: string[];
let realError: typeof console.error;

function config(name: string): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    predefinedEndpoints: { enable: [name] },
  } as ClaudishProfileConfig;
}

function row(name: string, apiKeyEnvVar: string): PredefinedEndpoint {
  return {
    name,
    displayName: `Collision ${name}`,
    baseUrl: `https://${name}.collision.example`,
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar,
    evidence: { tier: "probe", verdict: "auth-realm", measuredAt: "2026-08-14" },
  };
}

function expectCollision(candidate: PredefinedEndpoint, owner: string): void {
  __setPredefinedCatalogForTests([candidate]);
  const result = loadPredefinedEndpoints(config(candidate.name));

  expect(result.registered).toEqual([]);
  expect(result.skipped).toEqual([{ name: candidate.name, reason: "collides with builtin" }]);
  expect(getRuntimeProviders().has(candidate.name)).toBe(false);

  const warning = warnings.find((line) => line.includes(`predefined endpoint '${candidate.name}'`));
  expect(warning).toBeDefined();
  expect(warning).toContain(`predefined endpoint '${candidate.name}'`);
  expect(warning).toContain(`builtin provider '${owner}'`);
}

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  clearRuntimeRegistry();
  __resetPredefinedStateForTests();
  __setPredefinedCatalogForTests(null);

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

describe("predefined endpoint collision refusals", () => {
  test("a builtin shortcut remains owned by its builtin", () => {
    const candidate = row("mistral", COLLISION_KEYS[0]);
    expectCollision(candidate, "mistralai");
    expect(getShortcuts().mistral).toBe("mistralai");
  });

  test("a builtin canonical name keeps its own definition and base URL", () => {
    const builtin = BUILTIN_PROVIDERS.find((provider) => provider.name === "openrouter");
    expect(builtin).toBeDefined();

    const candidate = row("openrouter", COLLISION_KEYS[1]);
    expectCollision(candidate, "openrouter");
    expect(getProviderByName("openrouter")?.baseUrl).toBe(builtin?.baseUrl);
  });

  test("a picker-only alias remains owned by its builtin target", () => {
    const owner = PROVIDER_FILTER_ALIAS_EXTRA.zen;
    expect(owner).toBe("opencode-zen");

    const candidate = row("zen", COLLISION_KEYS[2]);
    expectCollision(candidate, owner);
    expect(getProviderFilterAliases().zen).toBe(owner);
    expect(getProviderByName("zen")).toBeUndefined();
  });
});
