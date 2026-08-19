/**
 * C4 / R4: a user-authored endpoint fully replaces a bundled row. Both load
 * orders are asserted because replacement must be suppression-based, not a
 * last-write-wins accident.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { loadCustomEndpoints } from "./custom-endpoints-loader.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
import {
  __resetPredefinedStateForTests,
  __setPredefinedCatalogForTests,
  loadPredefinedEndpoints,
} from "./predefined-endpoints.js";
import { getProviderByName } from "./provider-definitions.js";
import { clearRuntimeRegistry, getRuntimeProviders } from "./runtime-providers.js";

const VENDOR_KEY = "GROQ_API_KEY";
const USER_KEY = "CUSTOM_GROQ_KEY";
const KILL_SWITCH = "CLAUDISH_NO_PREDEFINED_ENDPOINTS";
const ENV_KEYS = [VENDOR_KEY, USER_KEY, KILL_SWITCH] as const;

const CATALOG_ROW: PredefinedEndpoint = {
  name: "groq",
  displayName: "Bundled Groq",
  baseUrl: "https://bundled.groq.example",
  apiPath: "/v1/chat/completions",
  format: "openai",
  apiKeyEnvVar: VENDOR_KEY,
  evidence: { tier: "probe", verdict: "auth-realm", measuredAt: "2026-08-14" },
};

const USER_URL = "https://user-owned.groq.example";
const USER_PATH = "/custom/chat/completions";

let savedEnv: Map<string, string | undefined>;
let realError: typeof console.error;

function config(customEndpoints: Record<string, unknown>): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    customEndpoints,
  } as ClaudishProfileConfig;
}

const GROQ_CONFIG = config({
  groq: {
    kind: "complex",
    displayName: "User Groq",
    transport: "openai",
    baseUrl: USER_URL,
    apiPath: USER_PATH,
    apiKey: "${CUSTOM_GROQ_KEY}",
    authScheme: "x-api-key",
  },
});

function expectUserGroq(): void {
  const definition = getProviderByName("groq");
  expect(definition).toBeDefined();
  expect(definition?.baseUrl).toBe(USER_URL);
  expect(definition?.apiPath).toBe(USER_PATH);
  expect(definition?.displayName).toBe("User Groq");
  expect(definition?.authScheme).toBe("x-api-key");
  expect(definition?.apiKeyEnvVar).toBe(USER_KEY);
  expect(definition?.apiKeyAliases).toBeUndefined();
  expect(getRuntimeProviders().size).toBe(1);
}

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env[VENDOR_KEY] = "test-vendor-key";

  clearRuntimeRegistry();
  __resetPredefinedStateForTests();
  __setPredefinedCatalogForTests([CATALOG_ROW]);

  realError = console.error;
  console.error = () => {};
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

describe("user customEndpoints replacement", () => {
  test("user endpoint loaded before the bundle remains the total definition", () => {
    expect(loadCustomEndpoints(GROQ_CONFIG)).toEqual({ registered: 1, errors: [], refused: [] });
    const bundled = loadPredefinedEndpoints(GROQ_CONFIG);

    expect(bundled.registered).toEqual([]);
    expect(bundled.skipped).toEqual([{ name: "groq", reason: "already registered" }]);
    expectUserGroq();
  });

  test("user endpoint loaded after the bundle remains the total definition", () => {
    const bundled = loadPredefinedEndpoints(GROQ_CONFIG);
    expect(bundled.registered).toEqual([]);
    expect(bundled.skipped).toEqual([{ name: "groq", reason: "replaced by customEndpoints" }]);
    expect(loadCustomEndpoints(GROQ_CONFIG)).toEqual({ registered: 1, errors: [], refused: [] });

    expectUserGroq();
  });

  test("a user endpoint whose former catalog row no longer exists loads normally", () => {
    delete process.env[VENDOR_KEY];
    __setPredefinedCatalogForTests([]);
    const userOnly = config({
      "user-only": {
        kind: "simple",
        url: "https://user-only.example/v1",
        format: "openai",
        apiKey: "${CUSTOM_USER_ONLY_KEY}",
      },
    });

    expect(loadPredefinedEndpoints(userOnly)).toEqual({ registered: [], skipped: [] });
    expect(loadCustomEndpoints(userOnly)).toEqual({ registered: 1, errors: [], refused: [] });
    expect(getProviderByName("user-only")?.baseUrl).toBe("https://user-only.example/v1");
  });
});
