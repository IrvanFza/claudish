import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import type { ModelDoc } from "./schema.js";

// ─────────────────────────────────────────────────────────────
// FakeFirestore — minimal in-memory implementation of the Firestore
// query API surface used by query-handler.ts.
//
// Supports chained: collection(name).where(field, op, value).limit(n).get()
// Each where() returns a new FakeQuery that layers another filter on top.
// ─────────────────────────────────────────────────────────────

type WhereOp = "==" | "<=" | ">=" | "<" | ">";
interface WhereClause { field: string; op: WhereOp; value: unknown }

function getNested(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function applyWhere(docs: any[], clauses: WhereClause[]): any[] {
  return docs.filter(doc => {
    for (const c of clauses) {
      const v = getNested(doc, c.field);
      switch (c.op) {
        case "==": if (v !== c.value) return false; break;
        case "<=": if (typeof v !== "number" || v > (c.value as number)) return false; break;
        case ">=": if (typeof v !== "number" || v < (c.value as number)) return false; break;
        case "<":  if (typeof v !== "number" || v >= (c.value as number)) return false; break;
        case ">":  if (typeof v !== "number" || v <= (c.value as number)) return false; break;
      }
    }
    return true;
  });
}

class FakeQuery {
  constructor(
    private readonly source: () => any[],
    private readonly clauses: WhereClause[] = [],
    private readonly limitN: number | null = null,
    private readonly orderByField: string | null = null,
    private readonly orderByDir: "asc" | "desc" = "asc",
  ) {}

  where(field: string, op: WhereOp, value: unknown): FakeQuery {
    return new FakeQuery(
      this.source,
      [...this.clauses, { field, op, value }],
      this.limitN,
      this.orderByField,
      this.orderByDir,
    );
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.source, this.clauses, this.limitN, field, dir);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.source, this.clauses, n, this.orderByField, this.orderByDir);
  }

  async get(): Promise<{ docs: Array<{ id: string; data: () => any }> }> {
    let rows = applyWhere(this.source(), this.clauses);
    if (this.orderByField) {
      const f = this.orderByField;
      const dir = this.orderByDir === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const av = getNested(a, f) as any;
        const bv = getNested(b, f) as any;
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * dir;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return {
      docs: rows.map(r => ({
        id: r.modelId ?? r.__id ?? "unknown",
        data: () => r,
      })),
    };
  }
}

class FakeCollection extends FakeQuery {
  constructor(rows: any[]) {
    super(() => rows);
  }
  doc(_id: string) {
    // Not exercised by the tests in this file (changelog / config paths).
    return {
      collection: () => new FakeQuery(() => []),
      get: async () => ({ exists: false, data: () => undefined }),
    };
  }
}

class FakeFirestore {
  private collections = new Map<string, any[]>();

  seed(name: string, rows: any[]): void {
    this.collections.set(name, rows);
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this.collections.get(name) ?? []);
  }
}

// ─────────────────────────────────────────────────────────────
// Module mock — replaces firebase-admin/firestore's getFirestore
// with a function returning our shared FakeFirestore instance.
// Must be registered BEFORE importing query-handler.
// ─────────────────────────────────────────────────────────────

const fakeDb = new FakeFirestore();

mock.module("firebase-admin/firestore", () => {
  // Re-export Timestamp from the real module, swap getFirestore.
  const actual = require("firebase-admin/firestore");
  return {
    ...actual,
    getFirestore: () => fakeDb,
  };
});

// Import AFTER mock registration.
const { handleQueryModels } = await import("./query-handler.js");

// ─────────────────────────────────────────────────────────────
// ModelDoc factory + mock req/res helpers
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
    sources: {
      [overrides.provider]: {
        confidence: "api_official",
        externalId: overrides.modelId,
        lastSeen: now,
      },
    },
    lastUpdated: now,
    lastChecked: now,
    releaseDate: "2026-02-01",
    ...overrides,
  };
}

function makeReq(query: Record<string, string>, method = "GET"): any {
  return { method, query };
}

function makeRes(): any {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return res;
}

async function callHandler(query: Record<string, string>, method = "GET"): Promise<{ status: number; body: any }> {
  const req = makeReq(query, method);
  const res = makeRes();
  await handleQueryModels(req, res);
  return { status: res.statusCode, body: res.body };
}

// ─────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────

function seedModels(rows: ModelDoc[]): void {
  fakeDb.seed("models", rows);
}

beforeEach(() => {
  // Each test seeds fresh — clear any leftover.
  fakeDb.seed("models", []);
});

// ─────────────────────────────────────────────────────────────
// Suite 1: top100 happy path
// ─────────────────────────────────────────────────────────────

describe("GET ?catalog=top100 — happy path", () => {
  function seedPool(count: number): ModelDoc[] {
    const providers = ["anthropic", "openai", "google", "deepseek", "meta", "unknown-co"];
    const docs: ModelDoc[] = [];
    for (let i = 0; i < count; i++) {
      docs.push(makeDoc({
        modelId: `model-${i.toString().padStart(3, "0")}`,
        displayName: `Model ${i}`,
        provider: providers[i % providers.length],
        pricing: { input: 1 + (i % 5), output: 2 + (i % 5) },
        contextWindow: 32_000 + (i % 10) * 10_000,
        capabilities: { tools: true, streaming: true, thinking: i % 3 === 0, vision: i % 2 === 0 },
        releaseDate: `2025-${((i % 12) + 1).toString().padStart(2, "0")}-01`,
      }));
    }
    return docs;
  }

  it("returns ranked models with required response envelope fields", async () => {
    seedModels(seedPool(30));
    const { status, body } = await callHandler({ catalog: "top100" });
    expect(status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.poolSize).toBe("number");
    expect(body.scoring).toBeDefined();
    expect(body.scoring.weights).toBeDefined();
    expect(body.scoring.weights.popularity).toBe(0.25);
    expect(body.scoring.weights.recency).toBe(0.30);
    expect(body.scoring.weights.generation).toBe(0.20);
    expect(body.scoring.weights.capabilities).toBe(0.10);
    expect(body.scoring.weights.context).toBe(0.10);
    expect(body.scoring.weights.confidence).toBe(0.05);
  });

  it("all returned models have status active and valid pricing", async () => {
    seedModels(seedPool(50));
    const { body } = await callHandler({ catalog: "top100" });
    for (const m of body.models) {
      expect(m.status).toBe("active");
      expect(typeof m.pricing?.input).toBe("number");
      expect(typeof m.pricing?.output).toBe("number");
    }
  });

  it("ranks are 1-indexed and contiguous", async () => {
    seedModels(seedPool(25));
    const { body } = await callHandler({ catalog: "top100" });
    body.models.forEach((m: any, i: number) => {
      expect(m.rank).toBe(i + 1);
    });
  });

  it("scores are monotonic non-increasing", async () => {
    seedModels(seedPool(40));
    const { body } = await callHandler({ catalog: "top100" });
    for (let i = 0; i < body.models.length - 1; i++) {
      expect(body.models[i].score).toBeGreaterThanOrEqual(body.models[i + 1].score);
    }
  });

  it("respects explicit limit param (limit=5)", async () => {
    seedModels(seedPool(30));
    const { body } = await callHandler({ catalog: "top100", limit: "5" });
    expect(body.models.length).toBe(5);
    expect(body.total).toBe(5);
  });

  it("default limit is 100", async () => {
    seedModels(seedPool(150));
    const { body } = await callHandler({ catalog: "top100" });
    expect(body.models.length).toBeLessThanOrEqual(100);
    expect(body.total).toBeLessThanOrEqual(100);
    expect(body.total).toBe(body.models.length);
  });

  it("caps limit at 200 even when requested limit=500", async () => {
    seedModels(seedPool(300));
    const { body } = await callHandler({ catalog: "top100", limit: "500" });
    expect(body.models.length).toBeLessThanOrEqual(200);
    expect(body.total).toBeLessThanOrEqual(200);
  });

  it("poolSize reflects eligible pool and can exceed total", async () => {
    seedModels(seedPool(150));
    const { body } = await callHandler({ catalog: "top100", limit: "10" });
    expect(body.total).toBe(body.models.length);
    expect(body.total).toBeLessThanOrEqual(body.poolSize);
    expect(body.poolSize).toBeGreaterThanOrEqual(10);
  });

  it("total equals models.length", async () => {
    seedModels(seedPool(20));
    const { body } = await callHandler({ catalog: "top100" });
    expect(body.total).toBe(body.models.length);
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 2: eligibility filter
// ─────────────────────────────────────────────────────────────

describe("GET ?catalog=top100 — eligibility filter", () => {
  it("excludes status=deprecated models", async () => {
    seedModels([
      makeDoc({ modelId: "live-1", provider: "openai" }),
      makeDoc({ modelId: "live-2", provider: "anthropic" }),
      makeDoc({ modelId: "dead-1", provider: "openai", status: "deprecated" }),
      makeDoc({ modelId: "dead-2", provider: "anthropic", status: "deprecated" }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).not.toContain("dead-1");
    expect(ids).not.toContain("dead-2");
    expect(ids).toContain("live-1");
    expect(ids).toContain("live-2");
  });

  it("excludes models missing pricing.input", async () => {
    seedModels([
      makeDoc({ modelId: "ok-1", provider: "openai" }),
      makeDoc({ modelId: "no-input", provider: "openai", pricing: { output: 2 } as any }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("ok-1");
    expect(ids).not.toContain("no-input");
  });

  it("excludes models missing pricing.output", async () => {
    seedModels([
      makeDoc({ modelId: "ok-1", provider: "openai" }),
      makeDoc({ modelId: "no-output", provider: "openai", pricing: { input: 1 } as any }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("ok-1");
    expect(ids).not.toContain("no-output");
  });

  it("excludes models with non-numeric pricing", async () => {
    seedModels([
      makeDoc({ modelId: "ok-1", provider: "openai" }),
      makeDoc({ modelId: "bad-price", provider: "openai", pricing: { input: "free" as any, output: "free" as any } }),
      makeDoc({ modelId: "null-price", provider: "openai", pricing: { input: null as any, output: null as any } }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("ok-1");
    expect(ids).not.toContain("bad-price");
    expect(ids).not.toContain("null-price");
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 3: ranking quality
// ─────────────────────────────────────────────────────────────

describe("GET ?catalog=top100 — ranking quality", () => {
  it("top 2 contain both frontier flagships (anthropic + openai) over noise", async () => {
    const now = Timestamp.now();
    seedModels([
      makeDoc({
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        displayName: "Claude Opus 4.6",
        pricing: { input: 15, output: 75 },
        contextWindow: 500_000,
        capabilities: { tools: true, streaming: true, thinking: true, vision: true, jsonMode: true, structuredOutput: true },
        releaseDate: "2026-02-15",
        sources: { anthropic: { confidence: "api_official", externalId: "claude-opus-4-6", lastSeen: now } },
      }),
      makeDoc({
        modelId: "gpt-5.4",
        provider: "openai",
        displayName: "GPT-5.4",
        pricing: { input: 10, output: 30 },
        contextWindow: 400_000,
        capabilities: { tools: true, streaming: true, thinking: true, vision: true, jsonMode: true, structuredOutput: true },
        releaseDate: "2026-03-01",
        sources: { openai: { confidence: "api_official", externalId: "gpt-5.4", lastSeen: now } },
      }),
      makeDoc({
        modelId: "old-random-1",
        provider: "unknown-co",
        displayName: "Old Random 1",
        pricing: { input: 0.5, output: 1 },
        contextWindow: 8_000,
        capabilities: { streaming: true },
        releaseDate: "2023-01-01",
      }),
      makeDoc({
        modelId: "aggregator-noise",
        provider: "random-small",
        displayName: "Aggregator Noise",
        pricing: { input: 0.1, output: 0.2 },
        contextWindow: 4_000,
        capabilities: {},
        releaseDate: "2022-06-01",
      }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const top2Ids = body.models.slice(0, 2).map((m: any) => m.modelId);
    expect(top2Ids).toContain("claude-opus-4-6");
    expect(top2Ids).toContain("gpt-5.4");
  });

  it("a brand-new deepseek beats a 2-year-old claude on merit scoring", async () => {
    const now = Timestamp.now();
    seedModels([
      makeDoc({
        modelId: "deepseek-v4",
        provider: "deepseek",
        displayName: "DeepSeek V4",
        pricing: { input: 0.3, output: 1.0 },
        contextWindow: 256_000,
        capabilities: { tools: true, streaming: true, thinking: true, vision: true, jsonMode: true },
        releaseDate: "2026-03-20",
        sources: { deepseek: { confidence: "api_official", externalId: "deepseek-v4", lastSeen: now } },
      }),
      makeDoc({
        modelId: "claude-2",
        provider: "anthropic",
        displayName: "Claude 2",
        pricing: { input: 8, output: 24 },
        contextWindow: 100_000,
        capabilities: { streaming: true, tools: true },
        releaseDate: "2024-03-01",
        sources: { anthropic: { confidence: "api_official", externalId: "claude-2", lastSeen: now } },
      }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    const ids = body.models.map((m: any) => m.modelId);
    const deepseekRank = ids.indexOf("deepseek-v4");
    const claude2Rank = ids.indexOf("claude-2");
    expect(deepseekRank).toBeGreaterThanOrEqual(0);
    expect(claude2Rank).toBeGreaterThanOrEqual(0);
    expect(deepseekRank).toBeLessThan(claude2Rank);
  });

  it("includeScores=1 adds scoreBreakdown with all expected keys", async () => {
    seedModels([
      makeDoc({ modelId: "m1", provider: "openai" }),
      makeDoc({ modelId: "m2", provider: "anthropic" }),
    ]);
    const { body } = await callHandler({ catalog: "top100", includeScores: "1" });
    for (const m of body.models) {
      expect(m.scoreBreakdown).toBeDefined();
      expect(typeof m.scoreBreakdown.total).toBe("number");
      expect(typeof m.scoreBreakdown.popularity).toBe("number");
      expect(typeof m.scoreBreakdown.recency).toBe("number");
      expect(typeof m.scoreBreakdown.generation).toBe("number");
      expect(typeof m.scoreBreakdown.capabilities).toBe("number");
      expect(typeof m.scoreBreakdown.context).toBe("number");
      expect(typeof m.scoreBreakdown.confidence).toBe("number");
    }
  });

  it("without includeScores, scoreBreakdown is absent", async () => {
    seedModels([
      makeDoc({ modelId: "m1", provider: "openai" }),
      makeDoc({ modelId: "m2", provider: "anthropic" }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    for (const m of body.models) {
      expect(m.scoreBreakdown).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 4: search — pre-fix regression
// ─────────────────────────────────────────────────────────────

describe("GET ?search=<term> — pre-fix regression", () => {
  it("finds gpt matches even when buried past the first 50 rows (regression)", async () => {
    const docs: ModelDoc[] = [];
    // 60 non-gpt models first
    for (let i = 0; i < 60; i++) {
      docs.push(makeDoc({
        modelId: `noise-model-${i.toString().padStart(3, "0")}`,
        displayName: `Noise ${i}`,
        provider: "unknown-co",
      }));
    }
    // 5 gpt-containing models appended at end
    for (let i = 0; i < 5; i++) {
      docs.push(makeDoc({
        modelId: `gpt-variant-${i}`,
        displayName: `GPT Variant ${i}`,
        provider: "openai",
      }));
    }
    seedModels(docs);

    const { status, body } = await callHandler({ search: "gpt", limit: "10" });
    expect(status).toBe(200);
    expect(Array.isArray(body.models)).toBe(true);
    // Pre-fix would have returned 0; post-fix returns up to 5.
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.length).toBeLessThanOrEqual(5);
    for (const m of body.models) {
      expect(m.modelId.toLowerCase()).toContain("gpt");
    }
  });

  it("search is case-insensitive (upper-case query matches lowercase id)", async () => {
    seedModels([
      makeDoc({ modelId: "gpt-4o", provider: "openai" }),
      makeDoc({ modelId: "claude-opus", provider: "anthropic" }),
    ]);
    const { body } = await callHandler({ search: "GPT" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("gpt-4o");
  });

  it("search matches aliases, not only modelId/displayName", async () => {
    seedModels([
      makeDoc({
        modelId: "canon-id-xyz",
        displayName: "Canonical XYZ",
        provider: "openai",
        aliases: ["openai/gpt-foo", "gpt-foo"],
      }),
      makeDoc({
        modelId: "other-thing",
        displayName: "Other",
        provider: "anthropic",
        aliases: [],
      }),
    ]);
    const { body } = await callHandler({ search: "gpt-foo" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("canon-id-xyz");
    expect(ids).not.toContain("other-thing");
  });

  it("limit param trims post-filter results", async () => {
    const docs: ModelDoc[] = [];
    for (let i = 0; i < 10; i++) {
      docs.push(makeDoc({
        modelId: `gpt-item-${i}`,
        displayName: `GPT Item ${i}`,
        provider: "openai",
      }));
    }
    seedModels(docs);
    const { body } = await callHandler({ search: "gpt", limit: "3" });
    expect(body.models.length).toBe(3);
    expect(body.total).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 5: search — combined filters
// ─────────────────────────────────────────────────────────────

describe("GET ?search=<term> — combined filters", () => {
  it("?search=gpt&provider=openai applies provider filter AND search", async () => {
    seedModels([
      makeDoc({ modelId: "gpt-oai-1", displayName: "GPT from OAI", provider: "openai" }),
      makeDoc({ modelId: "gpt-azure-1", displayName: "GPT from Azure", provider: "azure" }),
      makeDoc({ modelId: "claude-opus", displayName: "Claude", provider: "anthropic" }),
    ]);
    const { body } = await callHandler({ search: "gpt", provider: "openai" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("gpt-oai-1");
    expect(ids).not.toContain("gpt-azure-1");
    expect(ids).not.toContain("claude-opus");
  });

  it("?search=gpt&minContext=100000 applies context filter AND search", async () => {
    seedModels([
      makeDoc({ modelId: "gpt-big", displayName: "GPT big ctx", provider: "openai", contextWindow: 200_000 }),
      makeDoc({ modelId: "gpt-small", displayName: "GPT small ctx", provider: "openai", contextWindow: 8_000 }),
      makeDoc({ modelId: "claude-big", displayName: "Claude big", provider: "anthropic", contextWindow: 500_000 }),
    ]);
    const { body } = await callHandler({ search: "gpt", minContext: "100000" });
    const ids = body.models.map((m: any) => m.modelId);
    expect(ids).toContain("gpt-big");
    expect(ids).not.toContain("gpt-small");
    expect(ids).not.toContain("claude-big");
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 6: edge cases
// ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("non-GET method returns 405", async () => {
    seedModels([makeDoc({ modelId: "x", provider: "openai" })]);
    const { status, body } = await callHandler({ catalog: "top100" }, "POST");
    expect(status).toBe(405);
    expect(body).toBeDefined();
  });

  it("empty result set for search returns { models: [], total: 0 }", async () => {
    seedModels([makeDoc({ modelId: "claude-opus", provider: "anthropic" })]);
    const { status, body } = await callHandler({ search: "nonexistent-xyz-term" });
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("top100 with zero eligible models returns empty array and poolSize=0, no crash", async () => {
    seedModels([
      makeDoc({ modelId: "dep-1", provider: "openai", status: "deprecated" }),
      makeDoc({ modelId: "nopricing", provider: "openai", pricing: undefined as any }),
    ]);
    const { status, body } = await callHandler({ catalog: "top100" });
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.poolSize).toBe(0);
  });

  it("top100 with empty models collection returns empty array", async () => {
    seedModels([]);
    const { status, body } = await callHandler({ catalog: "top100" });
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.poolSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Suite 7: Public projection — internal provenance fields stripped
//
// The Firestore ModelDoc carries collector-tracking fields (sources,
// fieldSources, lastUpdated, lastChecked) that are useful internally
// but MUST NOT leak into public API responses. This suite locks that
// contract in — if anyone accidentally returns raw ModelDocs, these
// tests fail.
// ─────────────────────────────────────────────────────────────

const INTERNAL_FIELDS = [
  "sources",
  "fieldSources",
  "lastUpdated",
  "lastChecked",
  "dataFreshnessWarning",
  "deprecatedAt",
  "successorId",
] as const;

function expectNoInternalFields(model: Record<string, unknown>): void {
  for (const field of INTERNAL_FIELDS) {
    expect(model[field]).toBeUndefined();
  }
}

describe("public projection — internal fields stripped", () => {
  it("top100 models omit sources, fieldSources, lastUpdated, lastChecked", async () => {
    seedModels([
      makeDoc({ modelId: "claude-opus-4-6", provider: "anthropic", family: "claude-opus" }),
      makeDoc({ modelId: "gpt-5-4", provider: "openai" }),
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    expect(body.models.length).toBeGreaterThan(0);
    for (const m of body.models) {
      expectNoInternalFields(m);
    }
  });

  it("top100 models keep the public fields users need", async () => {
    seedModels([
      makeDoc({
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        family: "claude-opus",
        description: "Anthropic flagship",
        releaseDate: "2026-03-01",
      }),
    ]);
    const { body } = await callHandler({ catalog: "top100", includeScores: "1" });
    const m = body.models[0];
    expect(m.modelId).toBe("claude-opus-4-6");
    expect(m.displayName).toBeDefined();
    expect(m.description).toBe("Anthropic flagship");
    expect(m.provider).toBe("anthropic");
    expect(m.family).toBe("claude-opus");
    expect(m.releaseDate).toBe("2026-03-01");
    expect(m.pricing).toBeDefined();
    expect(m.contextWindow).toBeDefined();
    expect(m.capabilities).toBeDefined();
    expect(m.aliases).toBeDefined();
    expect(m.status).toBe("active");
    // Ranking metadata is top100-specific — preserved on top of the projection
    expect(m.rank).toBe(1);
    expect(typeof m.score).toBe("number");
    expect(m.scoreBreakdown).toBeDefined();
  });

  it("standard list query models omit internal provenance fields", async () => {
    seedModels([
      makeDoc({ modelId: "m1", provider: "anthropic" }),
      makeDoc({ modelId: "m2", provider: "openai" }),
    ]);
    const { body } = await callHandler({});
    expect(body.models.length).toBe(2);
    for (const m of body.models) {
      expectNoInternalFields(m);
    }
  });

  it("search results omit internal provenance fields", async () => {
    seedModels([
      makeDoc({ modelId: "gpt-5", provider: "openai" }),
      makeDoc({ modelId: "claude", provider: "anthropic" }),
    ]);
    const { body } = await callHandler({ search: "gpt" });
    expect(body.models.length).toBeGreaterThan(0);
    for (const m of body.models) {
      expectNoInternalFields(m);
    }
  });

  it("projection drops internal fields even when the underlying doc has them populated", async () => {
    // Seed with a model that has ALL internal fields set (worst case for leakage).
    const now = Timestamp.now();
    seedModels([
      {
        ...makeDoc({ modelId: "leaky", provider: "anthropic" }),
        sources: {
          "anthropic-api": {
            confidence: "api_official",
            externalId: "leaky-v1",
            lastSeen: now,
            sourceUrl: "https://internal.example.com",
          },
        },
        fieldSources: {
          pricing: {
            collectorId: "anthropic-api",
            confidence: "api_official",
            sourceUrl: "https://internal.example.com",
            fetchedAt: now.toDate().toISOString(),
          },
        },
        dataFreshnessWarning: true,
      } as ModelDoc,
    ]);
    const { body } = await callHandler({ catalog: "top100" });
    expect(body.models.length).toBe(1);
    const m = body.models[0];
    expectNoInternalFields(m);
    // Negative control: ensure no stray internal URL appears anywhere in the JSON.
    expect(JSON.stringify(m)).not.toContain("internal.example.com");
    expect(JSON.stringify(m)).not.toContain("anthropic-api");
  });
});
