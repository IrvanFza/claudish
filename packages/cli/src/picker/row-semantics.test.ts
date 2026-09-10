import { describe, expect, test } from "bun:test";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
/**
 * The pure arithmetic behind a model row and a discovery notice — the tier that needs
 * no renderer, and the tier where the honesty rules are actually decidable.
 *
 * Two of these assertions exist because the alternative reading is silently plausible:
 * an absent context window must yield `NaN` (which paints `╌`) and NEVER 0 (which
 * paints the same full track a healthy tiny window paints), and no rendered notice may
 * contain the substring `undefined`.
 */
import type { DiscoveryFailure } from "../providers/model-discovery.js";
import { discoveryNoticeContent, mergeCredentialLines } from "./DiscoveryNotice.js";
import { ctxMix, priceMix, resample } from "./StatsStrip.js";
import { billingTag, contextMeterPct, parseDisplayPrice, priceMeterPct } from "./rows.js";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "m",
  name: "m",
  description: "",
  provider: "p",
  ...over,
});

describe("contextMeterPct", () => {
  test("is monotonic and bounded 0..100", () => {
    const pcts = [8_000, 32_000, 128_000, 512_000, 1_000_000].map((n) =>
      contextMeterPct(n, 8_000, 1_000_000)
    );
    expect(pcts.every((p) => p >= 0 && p <= 100)).toBe(true);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
  });

  test("an absent window is NaN, never 0", () => {
    // 0 would paint a full `░` track — pixel-identical to a healthy 8 K model.
    expect(Number.isNaN(contextMeterPct(undefined, 1000, 2000))).toBe(true);
    expect(Number.isNaN(contextMeterPct(0, 1000, 2000))).toBe(true);
  });

  test("a homogeneous list does not collapse its smallest row to an empty bar", () => {
    // MEASURED on the first capture: a 250K/1M roster scaled to its own bounds painted
    // every 250K row at exactly 0%. The floor is anchored six doublings below the max.
    expect(contextMeterPct(250_000, 250_000, 1_000_000)).toBeGreaterThan(50);
    expect(contextMeterPct(1_000_000, 250_000, 1_000_000)).toBe(100);
  });

  test("a degenerate range answers 100 rather than dividing by zero", () => {
    expect(contextMeterPct(1000, 1000, 1000)).toBe(100);
    expect(contextMeterPct(1000, 0, 0)).toBe(100);
  });
});

describe("priceMeterPct", () => {
  test("CHEAPER IS A LONGER BAR — the ramp ends green, so the fill is cheapness", () => {
    const cheap = priceMeterPct(0.1, 0.1, 15);
    const dear = priceMeterPct(15, 0.1, 15);
    expect(cheap).toBe(100);
    expect(dear).toBe(0);
  });

  test("free is a full bar; an absent rate is NaN", () => {
    expect(priceMeterPct(0, 0.1, 15)).toBe(100);
    expect(Number.isNaN(priceMeterPct(undefined, 0.1, 15))).toBe(true);
  });
});

describe("parseDisplayPrice", () => {
  test("reads the number out of a display string and nothing out of a word", () => {
    expect(parseDisplayPrice("$9.00/1M")).toBe(9);
    expect(parseDisplayPrice("$0.15/1M")).toBe(0.15);
    expect(parseDisplayPrice("SUB")).toBeUndefined();
    expect(parseDisplayPrice("N/A")).toBeUndefined();
  });
});

describe("billingTag", () => {
  test("each mode has its own word and its own colour", () => {
    const tags = (["sub", "local", "metered"] as const).map(billingTag);
    expect(tags.map((t) => t.text)).toEqual(["SUB", "LOCAL", "$"]);
    expect(new Set(tags.map((t) => t.fg)).size).toBe(3);
  });
});

describe("ctxMix / priceMix", () => {
  test("price bands are exclusive and count only rows with a per-token rate", () => {
    // A subscription row has no number to band, and inventing one would put a flat-rate
    // plan somewhere on a price axis it does not sit on.
    const list = [
      model({ pricing: { input: "", output: "", average: "FREE" } }),
      model({ pricing: { input: "", output: "", average: "$0.15/1M" } }),
      model({ pricing: { input: "", output: "", average: "$2.90/1M" } }),
      model({ pricing: { input: "", output: "", average: "$30.00/1M" } }),
      model({ pricing: { input: "", output: "", average: "SUB" } }),
      model({}),
    ];
    expect(priceMix(list)).toEqual([1, 1, 1, 1]);
  });

  test("context buckets sum to the models that HAVE a window", () => {
    const list = [
      model({ contextLength: 8_000 }),
      model({ contextLength: 131_072 }),
      model({ contextLength: 1_000_000 }),
      model({}),
    ];
    expect(ctxMix(list).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("resample", () => {
  test("always paints exactly the requested number of columns", () => {
    for (const n of [0, 1, 5, 21, 342]) {
      for (const w of [1, 8, 48]) {
        expect(
          resample(
            Array.from({ length: n }, (_, i) => i),
            w
          ).length
        ).toBe(n === 0 ? 0 : w);
      }
    }
  });
});

const failure = (over: Partial<DiscoveryFailure> = {}): DiscoveryFailure => ({
  kind: "unauthorized",
  provider: "kimi",
  ...over,
});

describe("discoveryNoticeContent", () => {
  test("`failed` is the ERROR tier; the three empty states are the NOTICE tier", () => {
    const rows: PickerDiscoveryOutcome[] = [
      { kind: "failed", failure: failure(), notice: ["⚠ x failed"], fallbackRows: [] },
      { kind: "empty-roster", failure: failure({ kind: "empty-roster" }), fallbackRows: [] },
      { kind: "all-filtered", servedCount: 3, sampleIds: ["e"], fallbackRows: [] },
      { kind: "collapsed-empty", servedCount: 3, chatCount: 3, fallbackRows: [] },
    ];
    expect(rows.map((o) => discoveryNoticeContent(o, "Kimi")?.severity)).toEqual([
      "error",
      "notice",
      "notice",
      "notice",
    ]);
  });

  test("`rows` and `unsupported` render nothing at all", () => {
    expect(
      discoveryNoticeContent(
        { kind: "rows", rows: [model()], servedCount: 1, chatCount: 1 },
        "Kimi"
      )
    ).toBeNull();
    expect(
      discoveryNoticeContent({ kind: "unsupported", reason: "no-descriptor" }, "Kimi")
    ).toBeNull();
  });

  test("`empty-roster` and `all-filtered` say DIFFERENT things — V7's automatable half", () => {
    const empty = discoveryNoticeContent(
      { kind: "empty-roster", failure: failure({ kind: "empty-roster" }), fallbackRows: [] },
      "Kimi"
    );
    const filtered = discoveryNoticeContent(
      {
        kind: "all-filtered",
        servedCount: 7,
        sampleIds: ["text-embedding-3-large"],
        fallbackRows: [],
      },
      "Kimi"
    );
    expect(empty?.lines[0]).toContain("empty");
    expect(filtered?.lines[0]).toContain("none of them chat-capable");
    expect(filtered?.lines.join(" ")).toContain("text-embedding-3-large");
    expect(empty?.lines[0]).not.toBe(filtered?.lines[0]);
  });

  test("a fallback list gets the PROVENANCE sentence; no fallback gets a next step", () => {
    const withRows = discoveryNoticeContent(
      { kind: "empty-roster", failure: failure({ kind: "empty-roster" }), fallbackRows: [model()] },
      "Kimi"
    );
    const without = discoveryNoticeContent(
      { kind: "empty-roster", failure: failure({ kind: "empty-roster" }), fallbackRows: [] },
      "Kimi"
    );
    expect(withRows?.lines.join(" ")).toContain("not its live roster");
    expect(without?.lines.join(" ")).toContain("Press c");
  });

  test("the HTTP status becomes a badge and leaves the headline once", () => {
    const c = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: ["\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n"],
        fallbackRows: [model()],
      },
      "Kimi"
    );
    expect(c?.badge).toBe("HTTP 401");
    expect(c?.lines[0]).not.toContain("(HTTP 401)");
    expect(c?.lines[0]).toContain("the API key was rejected");
  });

  test("NO rendered notice ever contains the substring `undefined`", () => {
    // Every variant × endpoint present/absent × status present/absent. `endpoint` and
    // `status` are both optional and a registered fetcher may report neither.
    const variants: PickerDiscoveryOutcome[] = [];
    for (const endpoint of [undefined, "https://api.test/v1/models"]) {
      for (const status of [undefined, 500]) {
        const f = failure({
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(status === undefined ? {} : { status }),
        });
        variants.push({ kind: "failed", failure: f, notice: ["⚠ x"], fallbackRows: [] });
        variants.push({
          kind: "empty-roster",
          failure: { ...f, kind: "empty-roster" },
          fallbackRows: [],
        });
      }
    }
    variants.push({ kind: "all-filtered", servedCount: 1, sampleIds: [], fallbackRows: [] });
    variants.push({ kind: "collapsed-empty", servedCount: 1, chatCount: 1, fallbackRows: [] });
    for (const v of variants) {
      const c = discoveryNoticeContent(v, "Kimi");
      expect([v.kind, c?.lines.join(" ").includes("undefined") ?? false]).toEqual([v.kind, false]);
    }
  });
});

describe("mergeCredentialLines", () => {
  test("merges the env-var and key-URL rows when they fit, dropping the parenthetical", () => {
    const lines = [
      "⚠ Kimi could not list its models: the API key was rejected",
      "Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).",
      "Get a key: https://platform.moonshot.cn/",
      "Showing Kimi's cloud-catalog entries below — not its live roster.",
    ];
    const merged = mergeCredentialLines(lines, 78);
    expect(merged.length).toBe(3);
    expect(merged[1]).toBe("Check MOONSHOT_API_KEY · Get a key: https://platform.moonshot.cn/");
  });

  test("leaves them apart when the merge would not fit", () => {
    const lines = [
      "head",
      "Check A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_INDEED (advice).",
      "Get a key: https://example.test/an/extremely/long/path/to/the/api/keys/page",
      "tail",
    ];
    expect(mergeCredentialLines(lines, 40)).toEqual(lines);
  });
});
