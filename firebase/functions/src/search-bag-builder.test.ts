import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  buildSearchBag,
  computeBagHash,
  extractAccessMethodTokens,
  SEARCH_BAG_MODEL,
} from "./search-bag-builder.js";
import type { ModelDoc } from "./schema.js";

// ─────────────────────────────────────────────────────────────
// ModelDoc factory
// ─────────────────────────────────────────────────────────────
function makeDoc(overrides: Partial<ModelDoc> & Pick<ModelDoc, "modelId" | "provider">): ModelDoc {
  const now = Timestamp.now();
  return {
    displayName: overrides.displayName ?? overrides.modelId,
    pricing: { input: 1.0, output: 2.0 },
    contextWindow: 128_000,
    capabilities: { tools: true, streaming: true },
    aliases: [],
    status: "active",
    fieldSources: {},
    sources: {},
    lastUpdated: now,
    lastChecked: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// fetch mock — swap globalThis.fetch per test
// ─────────────────────────────────────────────────────────────
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: string }> = [];

function mockFetch(responder: (call: { url: string; body: string }) => {
  status: number;
  text?: string;
  throws?: Error;
}) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    const call = { url, body };
    fetchCalls.push(call);
    const r = responder(call);
    if (r.throws) throw r.throws;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() {
        return JSON.parse(r.text ?? "{}");
      },
      async text() {
        return r.text ?? "";
      },
    } as Response;
  }) as typeof fetch;
}

function mockGeminiReturning(tokens: string[]): void {
  mockFetch(() => ({
    status: 200,
    text: JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ tokens }) }],
          },
        },
      ],
    }),
  }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─────────────────────────────────────────────────────────────
// computeBagHash
// ─────────────────────────────────────────────────────────────
describe("computeBagHash", () => {
  it("is deterministic — same input yields same hash", () => {
    const doc = makeDoc({
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      family: "claude-opus",
      displayName: "Claude Opus 4.6",
      description: "Anthropic flagship",
    });
    const h1 = computeBagHash(doc);
    const h2 = computeBagHash(doc);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when modelId changes", () => {
    const a = makeDoc({ modelId: "a", provider: "openai", displayName: "A" });
    const b = makeDoc({ modelId: "b", provider: "openai", displayName: "A" });
    expect(computeBagHash(a)).not.toBe(computeBagHash(b));
  });

  it("changes when provider changes", () => {
    const a = makeDoc({ modelId: "m", provider: "openai", displayName: "M" });
    const b = makeDoc({ modelId: "m", provider: "anthropic", displayName: "M" });
    expect(computeBagHash(a)).not.toBe(computeBagHash(b));
  });

  it("changes when family changes", () => {
    const a = makeDoc({ modelId: "m", provider: "openai", displayName: "M", family: "gpt-4" });
    const b = makeDoc({ modelId: "m", provider: "openai", displayName: "M", family: "gpt-5" });
    expect(computeBagHash(a)).not.toBe(computeBagHash(b));
  });

  it("changes when displayName changes", () => {
    const a = makeDoc({ modelId: "m", provider: "openai", displayName: "Alpha" });
    const b = makeDoc({ modelId: "m", provider: "openai", displayName: "Beta" });
    expect(computeBagHash(a)).not.toBe(computeBagHash(b));
  });

  it("changes when description changes", () => {
    const a = makeDoc({ modelId: "m", provider: "openai", displayName: "M", description: "one" });
    const b = makeDoc({ modelId: "m", provider: "openai", displayName: "M", description: "two" });
    expect(computeBagHash(a)).not.toBe(computeBagHash(b));
  });
});

// ─────────────────────────────────────────────────────────────
// extractAccessMethodTokens
// ─────────────────────────────────────────────────────────────
describe("extractAccessMethodTokens", () => {
  it("includes all z-ai access tokens plus openrouter", () => {
    const tokens = extractAccessMethodTokens("z-ai");
    // z-ai has GLM Coding (gc), OpenCode Zen (zen), OllamaCloud (oc)
    expect(tokens).toContain("gc");
    expect(tokens).toContain("zen");
    expect(tokens).toContain("oc");
    expect(tokens).toContain("glm");         // split from "glm coding"
    expect(tokens).toContain("coding");
    expect(tokens).toContain("opencode");    // split from "opencode zen"
    expect(tokens).toContain("ollamacloud"); // OllamaCloud lowercased as one word
    expect(tokens).toContain("openrouter");
    expect(tokens).toContain("or");
  });

  it("includes openrouter/or even for providers without explicit access methods", () => {
    const tokens = extractAccessMethodTokens("x-ai");
    expect(tokens).toContain("openrouter");
    expect(tokens).toContain("or");
  });

  it("is deduped — no token appears twice", () => {
    const tokens = extractAccessMethodTokens("moonshotai");
    const set = new Set(tokens);
    expect(set.size).toBe(tokens.length);
  });

  it("returns lowercase tokens only", () => {
    const tokens = extractAccessMethodTokens("minimax");
    for (const t of tokens) {
      expect(t).toBe(t.toLowerCase());
    }
  });

  it("includes qwen's gateway tokens (zen + oc + openrouter)", () => {
    const tokens = extractAccessMethodTokens("qwen");
    expect(tokens).toContain("zen");
    expect(tokens).toContain("opencode");
    expect(tokens).toContain("oc");
    expect(tokens).toContain("ollamacloud");
    expect(tokens).toContain("openrouter");
  });
});

// ─────────────────────────────────────────────────────────────
// buildSearchBag — happy path
// ─────────────────────────────────────────────────────────────
describe("buildSearchBag", () => {
  beforeEach(() => {
    fetchCalls = [];
  });

  it("returns tokens combining LLM output + access method tokens", async () => {
    mockGeminiReturning([
      "claude", "opus", "anthropic", "sonnet", "haiku", "flagship",
      "reasoning", "vision", "tools", "coding", "premium",
      "4", "4-6", "sonnet-4-6", "fast",
    ]);

    const doc = makeDoc({
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      displayName: "Claude Opus 4.6",
      family: "claude-opus",
      description: "Flagship",
    });
    const bag = await buildSearchBag(doc, "fake-key");

    // LLM tokens present
    expect(bag).toContain("claude");
    expect(bag).toContain("opus");
    expect(bag).toContain("anthropic");
    // OpenRouter access tokens merged in
    expect(bag).toContain("openrouter");
    expect(bag).toContain("or");
    // No duplicates
    expect(new Set(bag).size).toBe(bag.length);
  });

  it("falls back to deterministic bag when LLM throws", async () => {
    mockFetch(() => ({ status: 500, throws: new Error("boom") }));

    const doc = makeDoc({
      modelId: "gpt-5",
      provider: "openai",
      displayName: "GPT-5",
      capabilities: { tools: true, vision: true, thinking: true },
      pricing: { input: 0, output: 0 },
    });
    const bag = await buildSearchBag(doc, "fake-key");

    // Deterministic fallback always returns tokens — never empty
    expect(bag.length).toBeGreaterThan(0);
    expect(bag).toContain("gpt-5");
    expect(bag).toContain("openai");
    expect(bag).toContain("vision");
    expect(bag).toContain("reasoning");
    expect(bag).toContain("free");    // pricing 0/0
    expect(bag).toContain("openrouter");
  });

  it("falls back when LLM returns malformed JSON", async () => {
    mockFetch(() => ({
      status: 200,
      text: JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "this is not json at all" }] } },
        ],
      }),
    }));

    const doc = makeDoc({
      modelId: "llama-4",
      provider: "meta-llama",
      displayName: "Llama 4",
    });
    const bag = await buildSearchBag(doc, "fake-key");
    expect(bag.length).toBeGreaterThan(0);
    expect(bag).toContain("llama-4");
  });

  it("falls back when LLM response has tokens field missing", async () => {
    mockFetch(() => ({
      status: 200,
      text: JSON.stringify({
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ words: ["a", "b"] }) }] } },
        ],
      }),
    }));

    const doc = makeDoc({
      modelId: "model-x",
      provider: "openai",
      displayName: "Model X",
    });
    const bag = await buildSearchBag(doc, "fake-key");
    expect(bag.length).toBeGreaterThan(0);
  });

  it("strips markdown fences from LLM output", async () => {
    mockFetch(() => ({
      status: 200,
      text: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text:
                    "```json\n" +
                    JSON.stringify({
                      tokens: [
                        "alpha", "beta", "gamma", "delta", "epsilon",
                        "zeta", "eta", "theta", "iota", "kappa",
                        "lambda", "mu", "nu", "xi", "omicron",
                      ],
                    }) +
                    "\n```",
                },
              ],
            },
          },
        ],
      }),
    }));

    const doc = makeDoc({
      modelId: "fenced-model",
      provider: "openai",
      displayName: "Fenced",
    });
    const bag = await buildSearchBag(doc, "fake-key");
    expect(bag).toContain("alpha");
    expect(bag).toContain("kappa");
  });

  it("never throws even if fetch rejects", async () => {
    mockFetch(() => ({ status: 0, throws: new Error("network dead") }));

    const doc = makeDoc({
      modelId: "resilient",
      provider: "openai",
      displayName: "Resilient",
    });
    let err: unknown = null;
    let bag: string[] = [];
    try {
      bag = await buildSearchBag(doc, "fake-key");
    } catch (e) {
      err = e;
    }
    expect(err).toBeNull();
    expect(bag.length).toBeGreaterThan(0);
  });

  it("exports the expected SEARCH_BAG_MODEL constant", () => {
    expect(SEARCH_BAG_MODEL).toBe("gemini-3.1-flash-lite-preview");
  });
});
