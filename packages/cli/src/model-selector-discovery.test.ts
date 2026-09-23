/**
 * The picker's discovery outcome — `buildDiscoveredModelOutcome`, the notice
 * formatter behind it, and the chat-capability chokepoint both doors return
 * through.
 *
 * The defect these pin: `buildDiscoveredModelRows` returned `[]` for five
 * distinguishable states — a rejected key, an unreachable endpoint, a genuinely
 * empty dynamic models catalog, a dynamic models catalog where nothing was chat-capable, and a dynamic models catalog that
 * collapsed to nothing — and the caller fell through to the cloud catalog for
 * all of them in silence. The user saw "fewer model names, like the provider
 * does not have any models". So every test here is a state that used to be
 * indistinguishable from the other four.
 *
 * Offline by construction: `globalThis.fetch`, `credentials.getRequestAuth` and
 * the `CatalogClient` are all substituted directly. No `mock.module()` — it
 * bleeds into sibling Bun test files.
 *
 * Nothing here asserts a price, a context window or a capability flag: those
 * come from the on-disk model catalog, which is warm on a dev machine and cold
 * on a fresh clone. Ids, counts and outcome kinds are the assertions.
 *
 * Run: bun test packages/cli/src/model-selector-discovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { credentials } from "./auth/credentials/authority.js";
import {
  _modelsCatalogCollapse,
  buildDiscoveredModelOutcome,
  buildDiscoveredModelRows,
  formatDiscoveryFailureNotice,
  toPickerRows,
  warnDiscoveryFailure,
} from "./model-selector.js";
import type { ModelInfo } from "./model-selector.js";
import type { CatalogClient, CatalogModel } from "./providers/model-catalog.js";
import {
  type DiscoveryFailure,
  type DiscoveryFailureKind,
  describeDiscoveryFailure,
  invalidateModelDiscovery,
} from "./providers/model-discovery.js";
import type { ProviderDefinition } from "./providers/provider-definitions.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./providers/runtime-providers.js";

const PROVIDER = "picker-outcome-test";
const DISPLAY_NAME = "Picker Outcome Test";
const ENV_VAR = "PICKER_OUTCOME_TEST_API_KEY";
const KEY_URL = "https://picker-outcome.invalid/key";

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;
const realCollapse = _modelsCatalogCollapse.collapse;

function defineProvider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    name: PROVIDER,
    displayName: DISPLAY_NAME,
    transport: "openai",
    baseUrl: "https://picker-outcome.invalid",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: ENV_VAR,
    apiKeyDescription: "Offline test key",
    apiKeyUrl: KEY_URL,
    shortcuts: [],
    legacyPrefixes: [],
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    createHandler: { kind: "none", reason: "virtual", note: "Offline test fixture" },
    isDirectApi: true,
    ...overrides,
  };
}

/** The provider's live endpoint answers with exactly these ids. */
function serves(ids: string[]): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

function rejectsWith(status: number): void {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ error: "rejected" }), { status })
  ) as unknown as typeof fetch;
}

/** A CatalogClient that answers from memory. `null` rows means "catalog fails". */
function stubCatalog(rows: CatalogModel[] | null): CatalogClient {
  return {
    async modelsByVendor() {
      if (rows === null) throw new Error("catalog unavailable");
      return rows;
    },
    async vendorsForModel() {
      return null;
    },
    async searchModels() {
      return [];
    },
    servedByVendor() {
      return rows === null ? [] : rows;
    },
  };
}

const CATALOG_ROWS: CatalogModel[] = [
  { modelId: "catalog-chat-1", displayName: "Catalog Chat 1", provider: "moonshotai" },
  { modelId: "catalog-chat-2", displayName: "Catalog Chat 2", provider: "moonshotai" },
];

beforeEach(() => {
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  registerRuntimeProvider(defineProvider());
  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-test-token" },
  }));
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected fetch call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  globalThis.fetch = realFetch;
  credentials.getRequestAuth = realGetRequestAuth;
  _modelsCatalogCollapse.collapse = realCollapse;
});

describe("buildDiscoveredModelOutcome — all five states, told apart", () => {
  test("STATE A · a healthy dynamic models catalog is `rows`, non-empty, with servedCount === chatCount", async () => {
    serves(["alpha-chat", "beta-chat", "gamma-chat"]);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("rows");
    if (outcome.kind !== "rows") throw new Error("unreachable");
    expect(outcome.rows.map((r) => r.id).sort()).toEqual(["alpha-chat", "beta-chat", "gamma-chat"]);
    expect(outcome.rows.length).toBeGreaterThan(0);
    expect(outcome.servedCount).toBe(3);
    expect(outcome.chatCount).toBe(3);
  });

  test("a PARTIALLY filtered dynamic models catalog keeps the two counts apart — the fact discarded today", async () => {
    serves(["alpha-chat", "text-embedding-3-large", "whisper-1"]);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("rows");
    if (outcome.kind !== "rows") throw new Error("unreachable");
    expect(outcome.rows.map((r) => r.id)).toEqual(["alpha-chat"]);
    expect(outcome.servedCount).toBe(3);
    expect(outcome.chatCount).toBe(1);
    expect(outcome.chatCount).toBeLessThan(outcome.servedCount);
  });

  test("STATE B · served N, none chat-capable → all-filtered with the count and ≤3 sample ids", async () => {
    // Invisible today: the provider is healthy, the key is fine, and the picker
    // silently shows the cloud catalog instead. The sample ids are what make the
    // notice self-explaining — they are usually embeddings or route wildcards.
    serves(["text-embedding-3-large", "whisper-1", "dall-e-3", "nomic-embed-text"]);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("all-filtered");
    if (outcome.kind !== "all-filtered") throw new Error("unreachable");
    expect(outcome.servedCount).toBe(4);
    expect(outcome.sampleIds.length).toBe(3);
    for (const id of outcome.sampleIds) {
      expect(["text-embedding-3-large", "whisper-1", "dall-e-3", "nomic-embed-text"]).toContain(id);
    }
    expect(outcome.fallbackRows.map((r) => r.id).sort()).toEqual([
      "catalog-chat-1",
      "catalog-chat-2",
    ]);
  });

  test("STATE C · a genuinely empty dynamic models catalog is its own variant, carrying the failure", async () => {
    serves([]);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("empty-models-catalog");
    if (outcome.kind !== "empty-models-catalog") throw new Error("unreachable");
    expect(outcome.failure.kind).toBe("empty-models-catalog");
    expect(outcome.failure.endpoint).toContain("/v1/models");
    expect(outcome.fallbackRows.length).toBe(2);
  });

  test("STATE D · a rejected key is `failed` — a DIFFERENT variant from empty-models-catalog", async () => {
    rejectsWith(401);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.failure.kind).toBe("unauthorized");
    expect(outcome.failure.status).toBe(401);
    // The whole point of the split: a 401 and an empty list are not the same
    // thing, and the type no longer lets a renderer treat them as one.
    expect(outcome.kind).not.toBe("empty-models-catalog");
    expect(outcome.notice.join("")).toContain(DISPLAY_NAME);
    expect(outcome.notice.join("")).toContain(ENV_VAR);
    expect(outcome.fallbackRows.map((r) => r.id).sort()).toEqual([
      "catalog-chat-1",
      "catalog-chat-2",
    ]);
  });

  test("STATE E · a dynamic models catalog that collapses to nothing is collapsed-empty, never rows:[]", async () => {
    // Unreachable through the one shipped resolver (every entry lands in a group
    // and every group yields a choice), and modelled anyway: `{kind:"rows",
    // rows: []}` would be an empty panel with no explanation — the exact defect
    // class this type exists to remove, reintroduced inside it.
    _modelsCatalogCollapse.collapse = () => [];
    serves(["alpha-chat", "beta-chat"]);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    expect(outcome.kind).toBe("collapsed-empty");
    if (outcome.kind !== "collapsed-empty") throw new Error("unreachable");
    expect(outcome.servedCount).toBe(2);
    expect(outcome.chatCount).toBe(2);
    expect(outcome.fallbackRows.length).toBe(2);
  });

  test("a provider with no modelDiscovery is `unsupported`, which renders nothing", async () => {
    clearRuntimeRegistry();
    registerRuntimeProvider(defineProvider({ modelDiscovery: undefined }));

    expect(
      await buildDiscoveredModelOutcome(PROVIDER, DISPLAY_NAME, stubCatalog(CATALOG_ROWS))
    ).toEqual({ kind: "unsupported", reason: "no-descriptor" });
  });

  test("`rows` is non-empty on every path that produces it", async () => {
    // The invariant `rows: [ModelInfo, ...ModelInfo[]]` states at the type level;
    // this asserts it at runtime across every shape that reaches the branch.
    for (const ids of [["only-one"], ["a-chat", "b-chat"], ["a-chat", "whisper-1"]]) {
      invalidateModelDiscovery();
      serves(ids);
      const outcome = await buildDiscoveredModelOutcome(
        PROVIDER,
        DISPLAY_NAME,
        stubCatalog(CATALOG_ROWS)
      );
      expect(outcome.kind).toBe("rows");
      if (outcome.kind !== "rows") throw new Error("unreachable");
      expect(outcome.rows.length).toBeGreaterThan(0);
    }
  });
});

describe("buildDiscoveredModelOutcome — the fallback leg", () => {
  test("a failing catalog leaves fallbackRows empty instead of rejecting", async () => {
    rejectsWith(500);

    const outcome = await buildDiscoveredModelOutcome(PROVIDER, DISPLAY_NAME, stubCatalog(null));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.fallbackRows).toEqual([]);
    // With nothing to show, "manual model entry" is finally the true sentence.
    expect(outcome.notice.join("")).toContain("Falling back to manual model entry.");
  });

  test("with catalog rows in hand the notice names the catalog, not manual entry", async () => {
    rejectsWith(401);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog(CATALOG_ROWS)
    );

    if (outcome.kind !== "failed") throw new Error("unreachable");
    const notice = outcome.notice.join("");
    expect(notice).toContain("cloud-catalog entries below — not its live model list.");
    expect(notice).not.toContain("Falling back to manual model entry.");
  });

  test("the catalog fallback is chat-filtered too, via the same chokepoint", async () => {
    rejectsWith(401);

    const outcome = await buildDiscoveredModelOutcome(
      PROVIDER,
      DISPLAY_NAME,
      stubCatalog([
        ...CATALOG_ROWS,
        { modelId: "gpt-image-2.5-flare", displayName: "Image", provider: "openai" },
      ])
    );

    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.fallbackRows.map((r) => r.id)).not.toContain("gpt-image-2.5-flare");
  });
});

describe("buildDiscoveredModelRows stays the wrapper the classic path uses", () => {
  test("rows on success, [] for every other outcome", async () => {
    serves(["alpha-chat"]);
    expect(
      (await buildDiscoveredModelRows(PROVIDER, DISPLAY_NAME, stubCatalog(CATALOG_ROWS))).map(
        (r) => r.id
      )
    ).toEqual(["alpha-chat"]);

    invalidateModelDiscovery();
    rejectsWith(401);
    expect(
      await buildDiscoveredModelRows(PROVIDER, DISPLAY_NAME, stubCatalog(CATALOG_ROWS))
    ).toEqual([]);
  });

  test("the failure is still RECORDED, so warnDiscoveryFailure can find it afterwards", async () => {
    // The classic path throws the outcome away and asks the module-global map
    // why the list was empty. Moving the classification must not break that.
    rejectsWith(401);
    await buildDiscoveredModelRows(PROVIDER, DISPLAY_NAME, stubCatalog(CATALOG_ROWS));

    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnDiscoveryFailure(PROVIDER, DISPLAY_NAME, {
        apiKeyEnvVar: ENV_VAR,
        apiKeyUrl: KEY_URL,
      });
      expect(stderr.mock.calls.length).toBeGreaterThan(0);
      expect(stderr.mock.calls.map(([c]) => String(c)).join("")).toContain("HTTP 401");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("formatDiscoveryFailureNotice", () => {
  const def = { apiKeyEnvVar: ENV_VAR, apiKeyUrl: KEY_URL };

  function failure(kind: DiscoveryFailureKind): DiscoveryFailure {
    return {
      kind,
      provider: PROVIDER,
      endpoint: "https://picker-outcome.invalid/v1/models",
      status: kind === "unauthorized" || kind === "http-error" ? 401 : undefined,
      detail: "upstream said no",
    };
  }

  test.each(["unauthorized", "no-credentials"] as const)(
    "%s earns the env var and the key URL — the two actionable kinds",
    (kind) => {
      const text = formatDiscoveryFailureNotice(DISPLAY_NAME, failure(kind), def).join("");

      expect(text).toContain(DISPLAY_NAME);
      expect(text).toContain(ENV_VAR);
      expect(text).toContain(KEY_URL);
      expect(text).toContain("Falling back to manual model entry.");
    }
  );

  test.each(["http-error", "unreachable", "malformed"] as const)(
    "%s omits credential guidance, because there is no credential step to take",
    (kind) => {
      const text = formatDiscoveryFailureNotice(DISPLAY_NAME, failure(kind), def).join("");

      expect(text).toContain(DISPLAY_NAME);
      expect(text).not.toContain(ENV_VAR);
      expect(text).not.toContain(KEY_URL);
      expect(text).toContain("Falling back to manual model entry.");
    }
  );

  test("the three fallbacks produce three different final lines", () => {
    const lines = (f: Parameters<typeof formatDiscoveryFailureNotice>[3]) =>
      formatDiscoveryFailureNotice(DISPLAY_NAME, failure("unauthorized"), def, f).join("");

    expect(lines("manual-entry")).toContain("Falling back to manual model entry.");
    expect(lines("catalog")).toContain(
      `Showing ${DISPLAY_NAME}'s cloud-catalog entries below — not its live model list.`
    );
    // "unknown" means nothing has decided yet, so it claims nothing.
    expect(lines("unknown")).not.toContain("Falling back");
    expect(lines("unknown")).not.toContain("cloud-catalog");
  });

  test("the default is byte-identical to what warnDiscoveryFailure writes to stderr", async () => {
    // The coupling between the formatter and the sink, asserted rather than
    // assumed: the classic path's wording must not drift when the TUI's does.
    rejectsWith(401);
    await buildDiscoveredModelRows(PROVIDER, DISPLAY_NAME, stubCatalog(null));

    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let written: string;
    try {
      warnDiscoveryFailure(PROVIDER, DISPLAY_NAME, def);
      written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stderr.mockRestore();
    }

    const recorded: DiscoveryFailure = {
      kind: "unauthorized",
      provider: PROVIDER,
      endpoint: "https://picker-outcome.invalid/v1/models",
      status: 401,
      detail: '{"error":"rejected"}',
    };
    expect(written).toBe(formatDiscoveryFailureNotice(DISPLAY_NAME, recorded, def).join(""));
  });
});

describe("no rendered notice interpolates `undefined`", () => {
  // A Record, not an array, so the COMPILER enforces "every kind": adding a
  // kind to `DiscoveryFailureKind` without listing it here fails typecheck. An
  // array did not — `incomplete` arrived in the union and this list, which
  // calls itself exhaustive, kept passing without it.
  const EVERY_KIND: Record<DiscoveryFailureKind, true> = {
    "no-credentials": true,
    unauthorized: true,
    "http-error": true,
    unreachable: true,
    malformed: true,
    incomplete: true,
    "empty-models-catalog": true,
  };
  const KINDS = Object.keys(EVERY_KIND) as DiscoveryFailureKind[];

  test("every kind × endpoint × status × detail × fallback", () => {
    // The `empty-models-catalog` records on the fetcher half carried no endpoint for
    // years, so any copy that names one renders the literal string `undefined`
    // to the user. Exhaustive rather than representative, because the optional
    // fields are independent and a single missed guard is invisible in review.
    let checked = 0;
    for (const kind of KINDS) {
      for (const endpoint of [undefined, "https://picker-outcome.invalid/v1/models"]) {
        for (const status of [undefined, 401, 500]) {
          for (const detail of [undefined, "", "upstream said no"]) {
            const f: DiscoveryFailure = { kind, provider: PROVIDER, endpoint, status, detail };

            expect(describeDiscoveryFailure(f)).not.toContain("undefined");

            for (const fallback of ["manual-entry", "catalog", "unknown"] as const) {
              for (const def of [
                { apiKeyEnvVar: ENV_VAR, apiKeyUrl: KEY_URL },
                { apiKeyEnvVar: "", apiKeyUrl: "" },
              ]) {
                const text = formatDiscoveryFailureNotice(DISPLAY_NAME, f, def, fallback).join("");
                expect(text).not.toContain("undefined");
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(KINDS.length * 2 * 3 * 3 * 3 * 2);
  });
});

describe("toPickerRows — one chat-capability chokepoint for both doors", () => {
  const row = (id: string): ModelInfo => ({
    id,
    name: id,
    description: id,
    provider: "test",
  });

  test("drops real non-chat ids", () => {
    // `gpt-image-2.5-flare` is the model F1 observed being selected by pressing
    // Enter twice at launch: the catalog paths applied no capability filter at
    // all, only the live-discovery path did.
    const dropped = [
      "gpt-image-2.5-flare",
      "text-embedding-3-large",
      "whisper-1",
      "dall-e-3",
      "tts-1-hd",
      "nomic-embed-text",
      "bge-m3",
      "gemini/*",
    ];

    expect(toPickerRows(dropped.map(row))).toEqual([]);
  });

  test("keeps real chat ids", () => {
    const kept = [
      "claude-opus-5",
      "gpt-5.2-codex",
      "gemini-3-pro",
      "kimi-k3",
      "deepseek-v3",
      "llama3.2",
      "MiniMax-M2",
    ];

    expect(
      toPickerRows(kept.map(row))
        .map((r) => r.id)
        .sort()
    ).toEqual([...kept].sort());
  });

  test("dedupes by id while filtering", () => {
    expect(
      toPickerRows([row("claude-opus-5"), row("claude-opus-5"), row("whisper-1")]).map((r) => r.id)
    ).toEqual(["claude-opus-5"]);
  });
});
