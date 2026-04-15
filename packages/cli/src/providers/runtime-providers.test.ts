/**
 * Tests for runtime-providers.ts — the small Map-backed registry.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { ProviderDefinition } from "./provider-definitions.js";
import type { ProviderProfile } from "./provider-profiles.js";
import {
  registerRuntimeProvider,
  registerRuntimeProfile,
  getRuntimeProviders,
  getRuntimeProfiles,
  clearRuntimeRegistry,
} from "./runtime-providers.js";

function makeDef(name: string, overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    name,
    displayName: name,
    transport: "openai",
    baseUrl: `https://${name}.example.com`,
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: `${name.toUpperCase()}_KEY`,
    apiKeyDescription: `${name} key`,
    apiKeyUrl: "",
    shortcuts: [name],
    legacyPrefixes: [],
    ...overrides,
  };
}

function makeProfile(): ProviderProfile {
  return {
    createHandler() {
      return null;
    },
  };
}

describe("runtime-providers", () => {
  beforeEach(() => {
    clearRuntimeRegistry();
  });

  test("registerRuntimeProvider then get returns the same definition", () => {
    const def = makeDef("my-vllm");
    registerRuntimeProvider(def);

    const result = getRuntimeProviders().get("my-vllm");
    expect(result).toBeDefined();
    expect(result?.name).toBe("my-vllm");
    expect(result?.baseUrl).toBe("https://my-vllm.example.com");
  });

  test("registerRuntimeProvider overwrites on duplicate name", () => {
    registerRuntimeProvider(makeDef("dup", { baseUrl: "https://first.example.com" }));
    registerRuntimeProvider(makeDef("dup", { baseUrl: "https://second.example.com" }));

    const map = getRuntimeProviders();
    expect(map.size).toBe(1);
    expect(map.get("dup")?.baseUrl).toBe("https://second.example.com");
  });

  test("clearRuntimeRegistry empties both maps", () => {
    registerRuntimeProvider(makeDef("p1"));
    registerRuntimeProfile("p1", makeProfile());
    expect(getRuntimeProviders().size).toBe(1);
    expect(getRuntimeProfiles().size).toBe(1);

    clearRuntimeRegistry();

    expect(getRuntimeProviders().size).toBe(0);
    expect(getRuntimeProfiles().size).toBe(0);
  });

  test("registerRuntimeProfile then get returns the same profile", () => {
    const profile = makeProfile();
    registerRuntimeProfile("my-profile", profile);

    const result = getRuntimeProfiles().get("my-profile");
    expect(result).toBe(profile);
  });
});
