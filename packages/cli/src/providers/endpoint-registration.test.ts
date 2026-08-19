import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { __resetEndpointDiagnosticsForTests } from "./endpoint-diagnostics.js";
import {
  ensureEndpointsRegistered,
  getCustomEndpointResult,
  invalidateEndpointRegistration,
} from "./endpoint-registration.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
import {
  __resetPredefinedStateForTests,
  __setPredefinedCatalogForTests,
  loadPredefinedEndpoints,
} from "./predefined-endpoints.js";
import { getAllProviders, getProviderByName } from "./provider-definitions.js";
import { clearRuntimeRegistry, getRuntimeProviders } from "./runtime-providers.js";

const KILL_SWITCH = "CLAUDISH_NO_PREDEFINED_ENDPOINTS";
const ORDER_KEY = "ORDER_VENDOR_API_KEY";
const ENV_KEYS = [KILL_SWITCH, ORDER_KEY] as const;

const ORDER_ROW: PredefinedEndpoint = {
  name: "order-vendor",
  displayName: "Bundled Order Vendor",
  baseUrl: "https://bundled.order-vendor.example",
  apiPath: "/v1/chat/completions",
  format: "openai",
  apiKeyEnvVar: ORDER_KEY,
  evidence: { tier: "probe", verdict: "auth-realm", measuredAt: "2026-08-19" },
};

const ORDER_CUSTOM_URL = "https://custom.order-vendor.example/v1";

let savedEnv: Map<string, string | undefined>;
let realError: typeof console.error;

function config(customEndpoints?: Record<string, unknown>): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    customEndpoints,
  } as ClaudishProfileConfig;
}

function simpleEndpoint(url: string): Record<string, unknown> {
  return {
    kind: "simple",
    url,
    format: "openai",
    apiKey: "sk-test-key",
  };
}

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];

  realError = console.error;
  clearRuntimeRegistry();
  __resetEndpointDiagnosticsForTests();
  __resetPredefinedStateForTests();
  __setPredefinedCatalogForTests([]);
  invalidateEndpointRegistration();
});

afterEach(() => {
  console.error = realError;
  invalidateEndpointRegistration();
  __setPredefinedCatalogForTests(null);
  __resetPredefinedStateForTests();
  __resetEndpointDiagnosticsForTests();
  clearRuntimeRegistry();

  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("endpoint registration", () => {
  test("ensureEndpointsRegistered registers custom endpoints through the shared seam", () => {
    const endpointConfig = config({
      "seam-custom": simpleEndpoint("https://seam-custom.example/v1"),
    });

    ensureEndpointsRegistered({ config: endpointConfig });

    expect(getCustomEndpointResult()).toEqual({ registered: 1, errors: [], refused: [] });
    expect(getProviderByName("seam-custom")?.baseUrl).toBe("https://seam-custom.example/v1");
    expect(getAllProviders().some((provider) => provider.name === "seam-custom")).toBe(true);
  });

  test("bundled registration runs before custom registration", () => {
    __setPredefinedCatalogForTests([ORDER_ROW]);
    process.env[ORDER_KEY] = "sk-bundled-order-key";
    const endpointConfig = config({
      "order-vendor": simpleEndpoint(ORDER_CUSTOM_URL),
    });

    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));

    // Pin the exact suppression reason as well as the externally observable
    // warning branch exercised by ensureEndpointsRegistered below.
    expect(loadPredefinedEndpoints(endpointConfig)).toEqual({
      registered: [],
      skipped: [{ name: "order-vendor", reason: "replaced by customEndpoints" }],
    });
    clearRuntimeRegistry();
    __resetPredefinedStateForTests();
    messages.length = 0;

    ensureEndpointsRegistered({ config: endpointConfig });

    expect(getProviderByName("order-vendor")?.baseUrl).toBe(ORDER_CUSTOM_URL);
    expect(
      messages.some((message) =>
        message.includes("customEndpoints['order-vendor'] replaces the bundled entry entirely")
      )
    ).toBe(true);
    // If the two loader calls are swapped, the bundled loader reaches its
    // earlier runtime-collision branch instead of the user-replacement branch.
    expect(messages.some((message) => message.includes("already registered"))).toBe(false);
  });

  test("the latch makes a second call with a later config a no-op", () => {
    ensureEndpointsRegistered({
      config: config({
        "latched-first": simpleEndpoint("https://latched-first.example/v1"),
      }),
    });
    const firstResult = getCustomEndpointResult();

    ensureEndpointsRegistered({
      config: config({
        "latched-second": simpleEndpoint("https://latched-second.example/v1"),
      }),
    });

    expect(getCustomEndpointResult()).toBe(firstResult);
    expect(firstResult).toEqual({ registered: 1, errors: [], refused: [] });
    expect(getRuntimeProviders().has("latched-first")).toBe(true);
    expect(getRuntimeProviders().has("latched-second")).toBe(false);
    expect(getRuntimeProviders().size).toBe(1);
  });

  // The latch behaviour above is correct for the STARTUP sites, which all read
  // the same global config. It is wrong for any caller that is handed a specific
  // config and must honour it — and `createProxyServer` is exactly that.
  //
  // This is a real regression the suite caught: folding `loadCustomEndpoints`
  // into the latched seam replaced an UNCONDITIONAL `loadCustomEndpoints(config)`
  // call in `proxy-server.ts`, so a proxy started after anything else had already
  // registered silently dropped every `customEndpoints` entry in its own config.
  // `default-provider-e2e.test.ts` C1 passed in isolation and failed in a
  // full-suite run for precisely this reason.
  test("force re-registers a later config — the proxy-server contract", () => {
    ensureEndpointsRegistered({
      config: config({ "first-proxy-ep": simpleEndpoint("https://first.example/v1") }),
    });
    expect(getRuntimeProviders().has("first-proxy-ep")).toBe(true);

    // What `createProxyServer` does: it is told THIS config and must serve it.
    ensureEndpointsRegistered({
      config: config({ "second-proxy-ep": simpleEndpoint("https://second.example/v1") }),
      force: true,
    });

    expect(getRuntimeProviders().has("second-proxy-ep")).toBe(true);
    // Additive, never subtractive: `registerRuntimeProvider` is a `Map.set` with
    // no removal, so the earlier endpoint stays registered for the process.
    expect(getRuntimeProviders().has("first-proxy-ep")).toBe(true);
    expect(getCustomEndpointResult()).toEqual({ registered: 1, errors: [], refused: [] });
  });

  test("a broken custom endpoint config is reported without throwing", () => {
    const brokenConfig = config({
      broken: {
        kind: "simple",
        format: "openai",
        apiKey: "sk-test-key",
        // Missing url: the endpoint schema rejects this row.
      },
    });

    expect(() => ensureEndpointsRegistered({ config: brokenConfig })).not.toThrow();
    expect(getCustomEndpointResult().registered).toBe(0);
    expect(getCustomEndpointResult().refused).toEqual([]);
    expect(getCustomEndpointResult().errors).toHaveLength(1);
    expect(getCustomEndpointResult().errors[0]?.name).toBe("broken");
    expect(getProviderByName("broken")).toBeUndefined();
  });
});
