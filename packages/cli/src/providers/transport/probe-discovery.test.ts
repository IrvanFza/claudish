/**
 * Tests for probe-discovery ranking + fetch helpers.
 *
 * The fetch path is exercised via a mocked global.fetch.
 *
 * Run: bun test src/providers/transport/probe-discovery.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  _clearProbeDiscoveryCache,
  discoverViaLMStudio,
  discoverViaOllama,
  discoverViaOpenAIModels,
  invalidateProbeDiscovery,
  rankProbeCandidates,
} from "./probe-discovery.js";

describe("rankProbeCandidates", () => {
  test("prefers small-name patterns", () => {
    const ranked = rankProbeCandidates([
      "gpt-4o",
      "gpt-4o-mini",
      "llama-70b",
      "llama-3b",
      "claude-opus-4",
      "claude-haiku-4",
    ]);
    // Smalls bubble to the top; alphabetical within group.
    expect(ranked[0]).toBe("claude-haiku-4");
    // Among smalls: claude-haiku-4, gpt-4o-mini, llama-3b
    expect(ranked.slice(0, 3)).toEqual(["claude-haiku-4", "gpt-4o-mini", "llama-3b"]);
  });

  test("falls back to alphabetical when none match heuristics", () => {
    const ranked = rankProbeCandidates(["zoo-model", "alpha-model", "kappa-model"]);
    expect(ranked).toEqual(["alpha-model", "kappa-model", "zoo-model"]);
  });

  test("handles empty input", () => {
    expect(rankProbeCandidates([])).toEqual([]);
  });

  test("recognizes parametric size markers (1b/3b/7b)", () => {
    const ranked = rankProbeCandidates(["model-70b", "model-7b", "model-3b"]);
    expect(ranked[0]).toBe("model-3b");
    expect(ranked[1]).toBe("model-7b");
    expect(ranked[2]).toBe("model-70b"); // doesn't match the small pattern
  });

  test("filters out non-chat-capable model names", () => {
    const ranked = rankProbeCandidates([
      "gpt-4o-mini",
      "dall-e-3",
      "text-embedding-3-small",
      "whisper-1",
      "tts-1",
      "gemini-2.0-flash-exp-image-generation",
      "voxtral-mini-latest",
      "claude-haiku-4",
    ]);
    // Only chat models survive. Order: small-name first, then alphabetical.
    expect(ranked).toEqual(["claude-haiku-4", "gpt-4o-mini"]);
  });

  test("returns empty when all candidates are non-chat", () => {
    const ranked = rankProbeCandidates(["text-embedding-3-large", "whisper-1", "tts-1-hd"]);
    expect(ranked).toEqual([]);
  });

  test("drops wildcard route patterns", () => {
    const ranked = rankProbeCandidates(["gemini/*", "gem-mad/*", "gpt-4o-mini"]);
    expect(ranked).toEqual(["gpt-4o-mini"]);
  });

  test("prefers standard names over deployment-prefixed aliases", () => {
    const ranked = rankProbeCandidates([
      "gem-mad/gemini-flash-latest",
      "oai-10x/gpt-4o-mini",
      "gemini-2.5-flash-lite",
      "gpt-4o-mini",
    ]);
    // Standard names (no slash, or vendor-prefixed) come first; among
    // those, small-name first, then alphabetical.
    expect(ranked.slice(0, 2)).toEqual(["gemini-2.5-flash-lite", "gpt-4o-mini"]);
  });

  test("accepts recognized vendor prefixes as standard", () => {
    const ranked = rankProbeCandidates([
      "gem-mad/foo-mini",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku",
    ]);
    expect(ranked.slice(0, 2)).toEqual(["anthropic/claude-haiku", "openai/gpt-4o-mini"]);
  });
});

describe("discoverViaOpenAIModels", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
  });

  test("returns smallest model from /v1/models response", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "claude-haiku-4" }],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const outcome = await discoverViaOpenAIModels(
      "http://litellm.local/v1/models",
      {},
      { key: "test-litellm" }
    );
    expect(outcome.model).toBe("claude-haiku-4");
  });

  test("returns null + http reason on HTTP error", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels("http://x", {}, { key: "test-503" });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("503");
  });

  test("returns null + empty-list reason on empty model list", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-empty" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("no models loaded");
  });

  test("classifies localhost ECONNREFUSED with actionable 'is the server running?' hint", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("fetch failed");
      (err as any).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-refused-local" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("server running");
    expect(outcome.reason).toContain("localhost:1234");
  });

  test("classifies Bun's 'Unable to connect' message even without cause.code", async () => {
    // Bun's actual error shape for localhost refusal — no cause.code field.
    globalThis.fetch = mock(async () => {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-bun-refused" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("localhost:1234");
  });

  test("remote host ECONNREFUSED suggests checking URL/network", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("fetch failed");
      (err as any).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://192.168.1.50:1234/v1/models",
      {},
      { key: "test-refused-remote" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("192.168.1.50:1234");
    // Remote variant should mention checking URL/network rather than "is server running"
    expect(outcome.reason).toContain("check");
  });

  test("caches result within TTL", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: "lite-x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const a = await discoverViaOpenAIModels("http://x", {}, { key: "cache-test" });
    const b = await discoverViaOpenAIModels("http://x", {}, { key: "cache-test" });
    expect(a.model).toBe("lite-x");
    expect(b.model).toBe("lite-x");
    expect(fetchCount).toBe(1); // second call was cached
  });

  test("invalidateProbeDiscovery drops slug-prefixed cache entries", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(2);

    // Repeat: both cached, no new fetches
    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(2);

    // Invalidate just lmstudio → next lmstudio call refetches, litellm stays cached
    invalidateProbeDiscovery("lmstudio");
    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(3);
  });
});

describe("discoverViaOllama", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
  });

  test("prefers smaller loaded model from /api/ps", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "llama3-70b", size: 70_000_000_000 },
              { name: "llama3-3b", size: 3_000_000_000 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", { key: "ps-test" });
    expect(outcome.model).toBe("llama3-3b");
  });

  test("falls back to /api/tags when no models loaded", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen-7b", size: 7_000_000_000 },
              { name: "tinyllama-1b", size: 1_000_000_000 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", { key: "tags-fallback" });
    expect(outcome.model).toBe("tinyllama-1b");
  });

  test("returns null + reason when both endpoints empty", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOllama("http://localhost:11434", { key: "empty" });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("no models");
  });

  test("skips embedding models even when they're smallest by size", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "all-minilm:latest", size: 45_000_000 }, // smallest BUT embedding
              { name: "nomic-embed-text", size: 274_000_000 }, // embedding
              { name: "llama-3.2-3b", size: 3_000_000_000 }, // chat, bigger
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "embed-skip",
    });
    expect(outcome.model).toBe("llama-3.2-3b");
  });
});

describe("discoverViaLMStudio", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
  });

  test("prefers loaded models over not-loaded ones", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "big-model-loaded", state: "loaded", type: "llm" },
              { id: "tiny-mini-not-loaded", state: "not-loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-loaded-first" }
    );
    // Loaded wins even though the not-loaded one has "mini" in name.
    expect(outcome.model).toBe("big-model-loaded");
  });

  test("falls back to not-loaded models when nothing loaded", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "qwen-large", state: "not-loaded", type: "llm" },
              { id: "llama-mini", state: "not-loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-only-cold" }
    );
    // Among not-loaded, the small-name heuristic picks llama-mini.
    expect(outcome.model).toBe("llama-mini");
  });

  test("filters out embedding-type entries", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "all-minilm:latest", state: "loaded", type: "embeddings" },
              { id: "llama-3-loaded", state: "loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-embed-skip" }
    );
    expect(outcome.model).toBe("llama-3-loaded");
  });

  test("falls back to /v1/models when /api/v0/models returns 404", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response("", { status: 404 });
      }
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-old-version" }
    );
    expect(outcome.model).toBe("gpt-4o-mini");
  });

  test("returns null + reason when nothing chat-capable", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "nomic-embed-text", state: "loaded", type: "embeddings" }],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-only-embed" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("chat-capable");
  });
});
