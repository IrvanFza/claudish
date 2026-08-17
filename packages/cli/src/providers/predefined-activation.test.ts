/**
 * Activation lifecycle — and, specifically, what happens when a row that was
 * registered earlier in this process stops being eligible.
 *
 * `registerRuntimeProvider` is a `Map.set` with no removal, and the same name is
 * simultaneously live in the credential authority, in the derived `@prefix`
 * alias table, and in any handler cache built since. So `{ force: true }` can
 * only ADD: a user who disables a vendor in the config TUI keeps `groq@`
 * answering for the rest of the process.
 *
 * De-registration was considered and rejected — a partial removal is a provider
 * that half-exists, which is worse than a stale one. What was actually wrong is
 * that claudish said NOTHING, so "I turned it off and it kept answering" read
 * as a bug rather than as a restart requirement. These tests pin the warning.
 *
 * Hermetic: a synthetic catalog (never the shipped one) plus an explicit
 * registry clear, so nothing here depends on which vendors ship or on which
 * keys the developer happens to have exported.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClaudishProfileConfig } from "../profile-config.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
import { __resetPredefinedStateForTests, loadPredefinedEndpoints } from "./predefined-endpoints.js";
import { clearRuntimeRegistry, getRuntimeProviders } from "./runtime-providers.js";

const ENV_VAR = "PREDEF_ACTIVATION_TEST_KEY";

const ROW: PredefinedEndpoint = {
  name: "predef-activation-vendor",
  displayName: "Predef Activation Vendor",
  baseUrl: "https://api.predef-activation.example",
  apiPath: "/v1/chat/completions",
  format: "openai",
  apiKeyEnvVar: ENV_VAR,
  evidence: { tier: "probe", verdict: "auth-realm", measuredAt: "2026-08-14" },
};

const CATALOG: readonly PredefinedEndpoint[] = [ROW];

let warnings: string[];
let realError: typeof console.error;

beforeEach(() => {
  clearRuntimeRegistry();
  __resetPredefinedStateForTests();
  process.env[ENV_VAR] = "sk-test-key";
  warnings = [];
  realError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realError;
  delete process.env[ENV_VAR];
  clearRuntimeRegistry();
  __resetPredefinedStateForTests();
});

const cfg = (over: Partial<ClaudishProfileConfig> = {}) => over as ClaudishProfileConfig;

function stale(): string[] {
  return warnings.filter((w) => w.includes("no longer eligible"));
}

describe("a row registers when its key is present", () => {
  test("registered, and no staleness warning on a first pass", () => {
    const res = loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    expect(res.registered).toEqual([ROW.name]);
    expect(getRuntimeProviders().has(ROW.name)).toBe(true);
    expect(stale()).toEqual([]);
  });

  test("re-running with the same inputs is idempotent and silent", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    warnings = [];
    const res = loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    expect(res.registered).toEqual([ROW.name]);
    expect(warnings).toEqual([]);
  });
});

describe("disabling mid-process warns and states the restart requirement", () => {
  test("`disable` after a registration", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    warnings = [];
    const res = loadPredefinedEndpoints(cfg({ predefinedEndpoints: { disable: [ROW.name] } }), {
      catalog: CATALOG,
    });
    expect(res.registered).toEqual([]);
    expect(res.skipped).toEqual([{ name: ROW.name, reason: "disabled in config" }]);
    // The row is STILL live — that is the fact the warning exists to disclose.
    expect(getRuntimeProviders().has(ROW.name)).toBe(true);
    expect(stale()).toHaveLength(1);
    expect(stale()[0]).toContain("disabled in config");
    expect(stale()[0]).toContain("Restart claudish");
  });

  test("`enabled: false` (whole catalog off) after a registration", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    warnings = [];
    loadPredefinedEndpoints(cfg({ predefinedEndpoints: { enabled: false } }), {
      catalog: CATALOG,
    });
    expect(stale()).toHaveLength(1);
    expect(stale()[0]).toContain("catalog off");
  });

  test("the credential going away after a registration", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    warnings = [];
    delete process.env[ENV_VAR];
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    expect(stale()).toHaveLength(1);
    expect(stale()[0]).toContain("no local credential");
  });

  test("a user customEndpoints entry appearing after a registration", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    warnings = [];
    loadPredefinedEndpoints(
      cfg({
        customEndpoints: {
          [ROW.name]: { kind: "simple", url: "https://x.example", format: "openai", apiKey: "k" },
        },
      } as unknown as Partial<ClaudishProfileConfig>),
      { catalog: CATALOG }
    );
    expect(stale()).toHaveLength(1);
    expect(stale()[0]).toContain("replaced by customEndpoints");
  });

  test("the warning is emitted ONCE, not on every re-evaluation", () => {
    loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    const disabled = cfg({ predefinedEndpoints: { disable: [ROW.name] } });
    loadPredefinedEndpoints(disabled, { catalog: CATALOG });
    warnings = [];
    loadPredefinedEndpoints(disabled, { catalog: CATALOG });
    loadPredefinedEndpoints(disabled, { catalog: CATALOG });
    expect(stale()).toEqual([]);
  });
});

describe("the warning never fires for a row that was never registered", () => {
  test("uncredentialed from the start is silent", () => {
    delete process.env[ENV_VAR];
    const res = loadPredefinedEndpoints(cfg(), { catalog: CATALOG });
    expect(res.registered).toEqual([]);
    expect(stale()).toEqual([]);
  });

  test("disabled from the start is silent", () => {
    loadPredefinedEndpoints(cfg({ predefinedEndpoints: { disable: [ROW.name] } }), {
      catalog: CATALOG,
    });
    expect(stale()).toEqual([]);
  });

  test("a DUPLICATE row does not warn about the row that is working", () => {
    // The trap a uniform hook would fall into: after row 1 registers, its name
    // is in `ownRegistrations`, so row 2 — a maintainer error, correctly
    // ignored — would report the working provider as "no longer eligible".
    const res = loadPredefinedEndpoints(cfg(), { catalog: [ROW, { ...ROW }] });
    expect(res.registered).toEqual([ROW.name]);
    expect(res.skipped).toEqual([{ name: ROW.name, reason: "duplicate row" }]);
    expect(stale()).toEqual([]);
    expect(warnings.some((w) => w.includes("appears more than once"))).toBe(true);
  });
});
