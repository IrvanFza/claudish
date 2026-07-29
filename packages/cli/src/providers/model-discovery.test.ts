/**
 * Tests for live, per-subscription model discovery.
 *
 * The fetch path is exercised via a mocked global.fetch. The credential
 * authority method is replaced directly to keep the tests offline without
 * using mock.module(), which can bleed into sibling Bun test files.
 *
 * Run: bun test packages/cli/src/providers/model-discovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentials } from "../auth/credentials/authority.js";
import {
  discoverContextWindow,
  discoverProviderModels,
  invalidateModelDiscovery,
  rankDiscoveredModels,
  type DiscoveredModel,
} from "./model-discovery.js";

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;

function stubJsonResponse(body: unknown, status = 200) {
  const fetchMock = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  invalidateModelDiscovery();
  globalThis.fetch = realFetch;
  credentials.getRequestAuth = realGetRequestAuth;

  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-test-token" },
  }));
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected fetch call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  invalidateModelDiscovery();
  globalThis.fetch = realFetch;
  credentials.getRequestAuth = realGetRequestAuth;
});

describe("discoverProviderModels", () => {
  test("parses an OpenAI-style model list", async () => {
    stubJsonResponse({
      data: [
        {
          id: "k3",
          display_name: "Kimi K3",
          context_length: 1_048_576,
        },
      ],
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([
      {
        id: "k3",
        displayName: "Kimi K3",
        contextWindow: 1_048_576,
      },
    ]);
  });

  test("tolerates context-window field names and rejects invalid windows", async () => {
    stubJsonResponse({
      data: [
        { id: "context-length", context_length: 1_000 },
        { id: "context-window", context_window: 2_000 },
        { id: "max-context-length", max_context_length: 3_000 },
        { id: "zero", context_length: 0 },
        { id: "negative", context_window: -1 },
        { id: "non-numeric", max_context_length: "4000" },
        { id: "missing" },
      ],
    });

    const models = await discoverProviderModels("kimi-coding");
    const windows = Object.fromEntries(models.map((model) => [model.id, model.contextWindow]));

    expect(windows).toEqual({
      "context-length": 1_000,
      "context-window": 2_000,
      "max-context-length": 3_000,
      zero: undefined,
      negative: undefined,
      "non-numeric": undefined,
      missing: undefined,
    });
  });

  test("returns [] without fetching when the provider has no descriptor", async () => {
    const fetchMock = mock(async () => new Response("should not be called"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await discoverProviderModels("openrouter")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns [] for an unknown provider", async () => {
    expect(await discoverProviderModels("not-a-real-provider")).toEqual([]);
  });

  test("returns [] when credentials throw", async () => {
    credentials.getRequestAuth = mock(async () => {
      throw new Error("No offline credentials");
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("returns [] when fetch rejects", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Offline");
    }) as unknown as typeof fetch;

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("returns [] for a non-2xx response", async () => {
    stubJsonResponse({ error: "unavailable" }, 503);

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("returns [] when the body is not JSON", async () => {
    globalThis.fetch = mock(
      async () => new Response("{not-json", { status: 200 })
    ) as unknown as typeof fetch;

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("returns [] when the body has no data array", async () => {
    stubJsonResponse({ models: [{ id: "k3" }] });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("returns [] when the data array is empty", async () => {
    stubJsonResponse({ data: [] });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("skips rows with missing or blank ids", async () => {
    stubJsonResponse({
      data: [{ display_name: "Missing" }, { id: "" }, { id: "   " }, null, "not-an-object"],
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });
});

describe("model discovery cache and context lookup", () => {
  test("caches within the TTL and provider invalidation forces a refetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: [{ id: `model-${fetchCount}`, context_length: fetchCount * 1_000 }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-1");
    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-1");
    expect(fetchCount).toBe(1);

    invalidateModelDiscovery("kimi-coding");

    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-2");
    expect(fetchCount).toBe(2);
  });

  test("global invalidation clears cached discovery", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: `model-${fetchCount}` }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await discoverProviderModels("kimi-coding");
    await discoverProviderModels("kimi-coding");
    expect(fetchCount).toBe(1);

    invalidateModelDiscovery();

    await discoverProviderModels("kimi-coding");
    expect(fetchCount).toBe(2);
  });

  test("finds exact and case-insensitive windows and returns undefined otherwise", async () => {
    const fetchMock = stubJsonResponse({
      data: [
        { id: "k3", context_length: 1_048_576 },
        { id: "window-not-reported", display_name: "Unknown window" },
      ],
    });

    expect(await discoverContextWindow("kimi-coding", "k3")).toBe(1_048_576);
    expect(await discoverContextWindow("kimi-coding", "K3")).toBe(1_048_576);
    expect(await discoverContextWindow("kimi-coding", "not-listed")).toBeUndefined();
    expect(
      await discoverContextWindow("kimi-coding", "window-not-reported")
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rankDiscoveredModels", () => {
  test("sorts by window descending, then id, without mutating the input", () => {
    const models: DiscoveredModel[] = [
      { id: "no-window" },
      { id: "zeta", contextWindow: 262_144 },
      { id: "alpha", contextWindow: 262_144 },
      { id: "largest", contextWindow: 1_048_576 },
    ];
    const original = [...models];

    const ranked = rankDiscoveredModels(models);

    expect(ranked.map((model) => model.id)).toEqual([
      "largest",
      "alpha",
      "zeta",
      "no-window",
    ]);
    expect(models).toEqual(original);
    expect(ranked).not.toBe(models);
  });

  test("ranks k3 first for the real Kimi roster", () => {
    const ranked = rankDiscoveredModels([
      { id: "kimi-for-coding-highspeed", contextWindow: 262_144 },
      { id: "k3-256k", contextWindow: 262_144 },
      { id: "k3", contextWindow: 1_048_576 },
      { id: "kimi-for-coding", contextWindow: 262_144 },
    ]);

    expect(ranked[0]?.id).toBe("k3");
  });
});
