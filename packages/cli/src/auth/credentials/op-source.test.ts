/**
 * op-source — the lazy 1Password seam behind the credential authority.
 *
 * These tests cover op-source's UNIQUE contracts:
 *  1. the SYNC laziness gate (hasOpSources) and the short-circuits in
 *     resolveOpKeyForEnvVars that return BEFORE any 1Password module/SDK is
 *     touched;
 *  2. the GLOB SINGLE-FLIGHT: one configured glob resolves ONCE per process
 *     (one vaults.list + items.list + items.get; values come from that
 *     discovery, so NO secrets.resolveAll) no matter how many providers ask,
 *     failures are never memoized, and two different globs never cross-contaminate.
 *
 * The deep resolution primitives (collectConfigImports / resolveGlobImportAll /
 * resolveSecrets) are exhaustively tested in providers/onepassword.test.ts; the
 * full resolve path against real 1Password is exercised by the manual
 * scratch-op-hydrate-check probe.
 *
 * Deliberately NO `mock.module` here: Bun's module mocks are process-global and
 * would bleed into sibling files (providers/onepassword.test.ts, the lazy test)
 * in a full `bun test` run. Everything is hermetic via the injectable
 * __setOpSourceSeamsForTests seams (in-memory config + fake SDK factory + stub
 * auth), mirroring onepassword.test.ts's SdkClientFactory idiom.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { SdkAuth, SdkClientFactory, SdkClientLike } from "../../providers/onepassword.js";
import {
  setAppLockProbe,
  setLockRetryTiming,
  setScreenLockProbe,
} from "../../providers/onepassword.js";
import {
  __configureStartupTraceForTests,
  __getStartupSpansForTests,
  __resetStartupTraceForTests,
} from "../../startup-trace.js";
import {
  __resetResolveCacheForTests,
  __resetSdkAuthForTests,
  __resetSniffForTests,
  __resetWarnOnceForTests,
  __setOpSourceSeamsForTests,
  hasOpSources,
  invalidateOpResolutionCache,
  resolveOpKeyForEnvVars,
} from "./op-source.js";

let savedArgv: string[];
let savedDisableOp: string | undefined;

beforeEach(() => {
  savedArgv = process.argv;
  // The glob tests need the real sniff path (CLAUDISH_DISABLE_OP would force
  // hasOpSources()=false and short-circuit before the seams are consulted).
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  delete process.env.CLAUDISH_DISABLE_OP;
  __resetSniffForTests();
  __resetResolveCacheForTests();
  __resetSdkAuthForTests();
  __resetWarnOnceForTests();
  __setOpSourceSeamsForTests(undefined);
  setLockRetryTiming({ seconds: 0.01, tickMs: 1 });
  setScreenLockProbe(() => false);
  setAppLockProbe(() => false);
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  __resetSniffForTests();
  __resetResolveCacheForTests();
  __resetSdkAuthForTests();
  __resetWarnOnceForTests();
  __setOpSourceSeamsForTests(undefined);
  setLockRetryTiming();
  setScreenLockProbe(undefined);
  setAppLockProbe(undefined);
});

describe("hasOpSources() — the sync laziness gate", () => {
  // The no-flag case reads the real ~/.claudish/config.json (the sniff reads the
  // file directly), so we don't assert "false" — it depends on the host's config.
  // The argv-flag cases ARE deterministic regardless of host config.

  it("is true with --op <glob>", () => {
    process.argv = ["bun", "index.ts", "--op", "op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op=<glob> inline form", () => {
    process.argv = ["bun", "index.ts", "--op=op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op-env <id>", () => {
    process.argv = ["bun", "index.ts", "--op-env", "env-1"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op-env=<id> inline form", () => {
    process.argv = ["bun", "index.ts", "--op-env=env-1"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });
});

describe("resolveOpKeyForEnvVars() — short-circuits (no SDK touched)", () => {
  it("returns {} for an empty wanted set, even WITH an op source present", async () => {
    // A keyless/satisfied model produces an empty wanted set. This is the
    // "ollama@ / already-satisfied key" laziness case: no SDK, no resolution.
    process.argv = ["bun", "index.ts", "--op", "op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
    const out = await resolveOpKeyForEnvVars(new Set(), { onAuthFailure: "skip" });
    expect(out).toEqual({});
  });
});

// ===========================================================================
// Glob single-flight + full-result memoization (the 36s-startup fix)
//
// Fixture DERIVED from providers/onepassword.test.ts's real-captured item (same
// vault/item/section/field titles — a compact subset; no invented secret-like
// data). The fake SdkClientFactory counts every SDK namespace call so the tests
// can assert "exactly ONE discovery, and NO resolveAll" for N providers (the
// glob path reads values from discovery, not a second title-based resolve).
// ===========================================================================

const VAULT = "Jack";
const ITEM = "AI LLM models API keys 10xlabs";
const GLOB_ALL = `op://${VAULT}/${ITEM}/**`;
const GLOB_OPENAI = `op://${VAULT}/${ITEM}/OpenAI/*`;
const GLOB_MOON = `op://${VAULT}/${ITEM}/Moonshot Kimi/*`;

/** SDK-shaped item (subset of the captured fixture — same titles/sections). */
const SDK_ITEM: Awaited<ReturnType<SdkClientLike["items"]["get"]>> = {
  id: "abc123",
  title: ITEM,
  sections: [
    { id: "s-oai", title: "OpenAI" },
    { id: "s-moon", title: "Moonshot Kimi" },
    { id: "s-glm", title: "GLM Z models" },
  ],
  fields: [
    // sectionless, lowercase → invalid env name → skipped by the glob filter.
    { id: "f-0", title: "username", fieldType: "STRING", value: "" },
    { id: "f-1", title: "OPENAI_API_KEY", sectionId: "s-oai", fieldType: "CONCEALED", value: "x" },
    {
      id: "f-2",
      title: "MOONSHOT_API_KEY",
      sectionId: "s-moon",
      fieldType: "CONCEALED",
      value: "x",
    },
    {
      id: "f-3",
      title: "KIMI_CODING_API_KEY",
      sectionId: "s-moon",
      fieldType: "CONCEALED",
      value: "x",
    },
    { id: "f-4", title: "ZHIPU_API_KEY", sectionId: "s-glm", fieldType: "CONCEALED", value: "x" },
  ],
};

interface SdkCallCounts {
  vaultsList: number;
  itemsList: number;
  itemsGet: number;
  resolveAll: number;
}

/**
 * A counting fake SDK client factory (mirrors onepassword.test.ts's
 * makeFakeSdkFactory, plus per-namespace call counters). `failVaultsList` is a
 * one-shot latch: when active, the NEXT vaults.list throws (a transient
 * desktop-app failure), then the latch clears.
 */
function makeCountingFactory(opts: { failVaultsList?: { active: boolean } } = {}): {
  factory: SdkClientFactory;
  counts: SdkCallCounts;
} {
  const counts: SdkCallCounts = { vaultsList: 0, itemsList: 0, itemsGet: 0, resolveAll: 0 };
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        return `sdk:${ref}`;
      },
      async resolveAll(refs: string[]) {
        counts.resolveAll++;
        const individualResponses: Record<string, { content?: { secret: string } }> = {};
        for (const r of refs) individualResponses[r] = { content: { secret: `sdk:${r}` } };
        return { individualResponses };
      },
    },
    vaults: {
      async list() {
        counts.vaultsList++;
        if (opts.failVaultsList?.active) {
          opts.failVaultsList.active = false;
          throw new Error("1Password desktop bridge failed (test)");
        }
        return [{ id: "vid", title: VAULT }];
      },
    },
    items: {
      async list() {
        counts.itemsList++;
        return [{ id: "abc123", title: ITEM }];
      },
      async get() {
        counts.itemsGet++;
        return SDK_ITEM;
      },
    },
    environments: {
      async getVariables() {
        return { variables: [] };
      },
    },
  };
  return { factory: async () => client, counts };
}

const stubAuth: SdkAuth = { kind: "token", token: "ops_test" };

/** Install the hermetic seams: in-memory config + counting SDK + stub auth. */
function seamWith(globs: string[], factory: SdkClientFactory): void {
  __setOpSourceSeamsForTests({
    config: { onepassword: globs },
    sdkFactory: factory,
    auth: stubAuth,
  });
  __resetSniffForTests(); // re-sniff against the seamed config
}

const resolveOne = (name: string): Promise<Record<string, string>> =>
  resolveOpKeyForEnvVars(new Set([name]), { onAuthFailure: "skip" });

describe("glob single-flight — one resolution shared by every provider", () => {
  it("N concurrent per-key resolves over ONE glob → exactly one vaults.list/items.list/items.get/resolveAll", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    // Six concurrent "providers" (incl. a duplicate and a key the item lacks) —
    // the startup shape: everyone enqueues before the first resolution lands.
    const [openai, moonshot, kimi, zhipu, missing, openaiAgain] = await Promise.all([
      resolveOne("OPENAI_API_KEY"),
      resolveOne("MOONSHOT_API_KEY"),
      resolveOne("KIMI_CODING_API_KEY"),
      resolveOne("ZHIPU_API_KEY"),
      resolveOne("NOT_IN_THIS_ITEM_KEY"),
      resolveOne("OPENAI_API_KEY"),
    ]);

    // ONE full discovery, and NO resolveAll — values come from discovery now.
    expect(counts).toEqual({ vaultsList: 1, itemsList: 1, itemsGet: 1, resolveAll: 0 });

    // Every caller got ITS value out of the shared result (the discovered value).
    expect(openai).toEqual({ OPENAI_API_KEY: "x" });
    expect(moonshot).toEqual({ MOONSHOT_API_KEY: "x" });
    expect(kimi).toEqual({ KIMI_CODING_API_KEY: "x" });
    expect(zhipu).toEqual({ ZHIPU_API_KEY: "x" });
    expect(missing).toEqual({}); // the glob simply doesn't hold this key
    expect(openaiAgain).toEqual(openai);
  });

  it("sequential resolves after completion → pure cache hits, zero additional SDK calls", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(1);

    // A var NEVER wanted before — but the full-glob result already holds it.
    const moonshot = await resolveOne("MOONSHOT_API_KEY");
    expect(moonshot).toEqual({ MOONSHOT_API_KEY: "x" });
    // A var the glob does NOT hold → memoized empty pick, still no SDK.
    expect(await resolveOne("NOT_IN_THIS_ITEM_KEY")).toEqual({});

    expect(counts).toEqual({ vaultsList: 1, itemsList: 1, itemsGet: 1, resolveAll: 0 });
  });

  it("a FAILED glob resolution is not cached — the next resolve retries", async () => {
    const failLatch = { active: true };
    const { factory, counts } = makeCountingFactory({ failVaultsList: failLatch });
    seamWith([GLOB_ALL], factory);

    // First resolve: discovery throws → warn+skip (startup contract), {} back.
    expect(await resolveOne("OPENAI_API_KEY")).toEqual({});
    expect(counts.vaultsList).toBe(1);
    expect(counts.itemsGet).toBe(0);

    // Second resolve: the rejected promise was EVICTED → full retry, succeeds.
    const out = await resolveOne("OPENAI_API_KEY");
    expect(out).toEqual({ OPENAI_API_KEY: "x" });
    expect(counts).toEqual({ vaultsList: 2, itemsList: 1, itemsGet: 1, resolveAll: 0 });
  });

  it("two DIFFERENT globs → two resolutions, no cross-contamination", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_OPENAI, GLOB_MOON], factory);

    // Wanted key lives in glob #1 → glob #2 is never touched (loop breaks).
    const openai = await resolveOne("OPENAI_API_KEY");
    expect(openai).toEqual({ OPENAI_API_KEY: "x" });
    expect(counts.itemsGet).toBe(1);

    // Wanted key lives in glob #2 → glob #1 is a memoized miss, #2 resolves.
    const moonshot = await resolveOne("MOONSHOT_API_KEY");
    expect(moonshot).toEqual({ MOONSHOT_API_KEY: "x" });
    expect(counts.itemsGet).toBe(2);

    // A key NEITHER scoped glob matches → both memoized, no more SDK calls.
    expect(await resolveOne("ZHIPU_API_KEY")).toEqual({});
    expect(counts.itemsGet).toBe(2);
    expect(counts.resolveAll).toBe(0);
  });

  it("invalidateOpResolutionCache() forces a fresh discovery on the next resolve", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(1);

    // TUI hydrate-on-add / item edited in 1Password → drop every memo.
    invalidateOpResolutionCache();
    __resetSniffForTests(); // invalidate also resets the sniff; re-sniff the seams

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(2);
  });
});

// ===========================================================================
// Environment point-of-need + full-result memoization
//
// A 1Password Environment is fetched only after a concrete provider key reaches
// this resolver. getVariables() returns the whole environment, so one SDK call
// must satisfy later requests for other keys from the process-wide cache.
// ===========================================================================

const ENVIRONMENT_ID = "env-abc";
const ENVIRONMENT_VARIABLES = [
  { name: "OPENROUTER_API_KEY", value: "sk-test-router", masked: true },
  { name: "GEMINI_API_KEY", value: "sk-test-gemini", masked: true },
];

interface EnvironmentCallCounts {
  getVariables: number;
  environmentIds: string[];
}

function makeCountingEnvironmentFactory(): {
  factory: SdkClientFactory;
  counts: EnvironmentCallCounts;
} {
  const counts: EnvironmentCallCounts = { getVariables: 0, environmentIds: [] };
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        return `sdk:${ref}`;
      },
      async resolveAll() {
        return { individualResponses: {} };
      },
    },
    vaults: {
      async list() {
        return [];
      },
    },
    items: {
      async list() {
        return [];
      },
      async get() {
        throw new Error("environment tests must not inspect items");
      },
    },
    environments: {
      async getVariables(id: string) {
        counts.getVariables++;
        counts.environmentIds.push(id);
        return { variables: ENVIRONMENT_VARIABLES };
      },
    },
  };
  return { factory: async () => client, counts };
}

function seamWithEnvironment(factory: SdkClientFactory): void {
  const config = {
    onepassword: [],
    onepasswordEnvironments: [ENVIRONMENT_ID],
  };
  __setOpSourceSeamsForTests({
    config,
    sdkFactory: factory,
    auth: stubAuth,
  });
  __resetSniffForTests();
}

describe("environment point-of-need", () => {
  it("resolves a wanted key with exactly one environment fetch", async () => {
    const { factory, counts } = makeCountingEnvironmentFactory();
    seamWithEnvironment(factory);

    const out = await resolveOne("OPENROUTER_API_KEY");

    expect(out).toEqual({ OPENROUTER_API_KEY: "sk-test-router" });
    expect(counts).toEqual({ getVariables: 1, environmentIds: [ENVIRONMENT_ID] });
  });

  it("caches the whole environment for a later provider key", async () => {
    const { factory, counts } = makeCountingEnvironmentFactory();
    seamWithEnvironment(factory);

    expect(await resolveOne("OPENROUTER_API_KEY")).toEqual({
      OPENROUTER_API_KEY: "sk-test-router",
    });
    expect(await resolveOne("GEMINI_API_KEY")).toEqual({
      GEMINI_API_KEY: "sk-test-gemini",
    });
    expect(counts).toEqual({ getVariables: 1, environmentIds: [ENVIRONMENT_ID] });
  });

  it("does not fetch a configured environment for a no-key operation", async () => {
    const { factory, counts } = makeCountingEnvironmentFactory();
    seamWithEnvironment(factory);

    const out = await resolveOpKeyForEnvVars(new Set(), { onAuthFailure: "skip" });

    expect(out).toEqual({});
    expect(counts).toEqual({ getVariables: 0, environmentIds: [] });
  });

  it("fetches once and returns {} when the environment lacks the wanted key", async () => {
    const { factory, counts } = makeCountingEnvironmentFactory();
    seamWithEnvironment(factory);

    const out = await resolveOne("MISSING_KEY");

    expect(out).toEqual({});
    expect(counts).toEqual({ getVariables: 1, environmentIds: [ENVIRONMENT_ID] });
  });
});

describe("1Password failure warnings", () => {
  it("prints each distinct environment failure message only once across a routing chain", async () => {
    const repeatedFailure = "Denied authorization for SDK client (test)";
    const distinctFailure = "1Password desktop bridge unavailable (test)";
    const client: SdkClientLike = {
      secrets: {
        async resolve(ref: string): Promise<string> {
          return `sdk:${ref}`;
        },
        async resolveAll() {
          return { individualResponses: {} };
        },
      },
      vaults: {
        async list() {
          return [];
        },
      },
      items: {
        async list() {
          return [];
        },
        async get() {
          throw new Error("warning test must not inspect items");
        },
      },
      environments: {
        async getVariables(id: string) {
          throw new Error(id === "env-denied" ? repeatedFailure : distinctFailure);
        },
      },
    };
    __setOpSourceSeamsForTests({
      config: {
        onepassword: [],
        onepasswordEnvironments: ["env-denied", "env-unavailable"],
      },
      sdkFactory: async () => client,
      auth: stubAuth,
    });
    __resetSniffForTests();

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A bare model's routing chain asks for several different provider vars.
      // Both environment resolutions fail on every ask; only the first copy of
      // each distinct message should reach stderr.
      for (const envVar of [
        "OPENROUTER_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
        "MISTRAL_API_KEY",
      ]) {
        expect(await resolveOne(envVar)).toEqual({});
      }

      const messages = errorSpy.mock.calls.map(([message]) => String(message));
      const repeatedWarning = `[claudish] 1Password environment skipped: ${repeatedFailure}`;
      const distinctWarning = `[claudish] 1Password environment skipped: ${distinctFailure}`;
      expect(messages.filter((message) => message === repeatedWarning)).toHaveLength(1);
      expect(messages.filter((message) => message === distinctWarning)).toHaveLength(1);
      expect(messages).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
