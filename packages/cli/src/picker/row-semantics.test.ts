import { describe, expect, test } from "bun:test";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
/**
 * The pure semantics behind a row, a detail line and a discovery notice — the tier
 * that needs no renderer, and the tier where the honesty rules are actually
 * decidable.
 *
 * Three of these assertions exist because the alternative reading is silently
 * plausible: a fallback list must say it MAY NOT WORK and not merely that it came
 * from somewhere else; a capability the catalog is silent about must not be
 * rendered as absent; and no rendered notice may contain the substring `undefined`.
 */
import type { DiscoveryFailure } from "../providers/model-discovery.js";
import {
  discoveryNoticeContent,
  mergeCredentialLines,
  noticeRows,
  wrapWords,
} from "./DiscoveryNotice.js";
import { truncate } from "../tui/viz/text.js";
import { capabilityWords, descriptionLines, detailText, providerFactsText } from "./detail.js";
import { type PickerRow, dedupeByModelId, dedupeByProviderModel } from "./hooks/usePickerModels.js";
import { providerColumn } from "./layout.js";
import { billingLabel, priceFg, priceLabel, readinessGlyph } from "./rows.js";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "m",
  name: "m",
  description: "",
  provider: "p",
  ...over,
});

describe("priceLabel", () => {
  test("the `/1M` suffix goes — the column header says it once for the whole list", () => {
    expect(priceLabel("$9.00/1M", "metered")).toBe("$9.00");
    expect(priceLabel("$0.15/1M", "metered")).toBe("$0.15");
  });

  test("a flat-rate plan keeps its word instead of a number it does not have", () => {
    expect(priceLabel("SUB", "sub")).toBe("SUB");
    expect(priceLabel("FREE", "metered")).toBe("FREE");
    // A local model costs nothing per token and says so in lower case: shouting is
    // reserved for the two labels that are about money.
    expect(priceLabel("$3.00/1M", "local")).toBe("local");
    expect(priceLabel("LOCAL", "metered")).toBe("local");
  });

  test("an absent price is `N/A`, and never an empty cell", () => {
    // An empty price column would read as "free", which is a claim about money.
    expect(priceLabel("N/A", "metered")).toBe("N/A");
    expect(priceLabel("", "metered")).toBe("N/A");
  });
});

describe("priceFg", () => {
  test("the three labels that are ABOUT MONEY are three distinct colours", () => {
    // `FREE` (costs nothing), `SUB` (a flat-rate plan, so no per-token number
    // exists) and a rate are three different financial claims, and a reader
    // scanning for a cheap model separates them by hue before reading the word.
    expect(new Set(["FREE", "SUB", "$2.25"].map(priceFg)).size).toBe(3);
  });

  test("the two labels that are NOT prices share the dim tier, deliberately", () => {
    // `local` and `N/A` are both "there is no number here". Giving them separate
    // hues would put two more meanings into a column that already carries three,
    // and neither is a fact the reader acts on.
    expect(priceFg("local")).toBe(priceFg("N/A"));
    expect(priceFg("local")).not.toBe(priceFg("$2.25"));
  });

  test("AN EXPENSIVE PRICE IS NOT PAINTED AS AN ALARM — one colour, one meaning", () => {
    // A prototype of this dialog bucketed metered prices and drew anything over
    // $10/1M in orange; the owner and the reviewer both read `$30.00` as an error,
    // because red-orange is what this app spends on a failure and on `SUB`. A
    // number is a number: the numeral is body ink at every magnitude, and the
    // comparison the reader is making is between the DIGITS.
    const prices = ["$0.15", "$2.25", "$12.50", "$15.00", "$30.00"].map(priceFg);
    expect(new Set(prices).size).toBe(1);
  });
});

describe("billingLabel / readinessGlyph", () => {
  test("each billing mode has its own WORD, and only the flat-rate one is coloured", () => {
    const tags = (["sub", "local", "metered"] as const).map(billingLabel);
    expect(tags.map((t) => t.text)).toEqual(["SUB", "local", "$"]);
    // `SUB` is the one that changes what a launch COSTS, so it is the one that
    // gets a hue; the other two recede. Colour spent evenly is colour spent on
    // nothing.
    expect(tags[0]?.fg).not.toBe(tags[1]?.fg);
    expect(tags[0]?.fg).not.toBe(tags[2]?.fg);
  });

  test("readiness has three states, not two — pending is not missing", () => {
    const g = (["pending", "ready", "missing"] as const).map(readinessGlyph);
    expect(new Set(g.map((x) => x.glyph)).size).toBe(3);
    expect(new Set(g.map((x) => x.fg)).size).toBe(3);
  });
});

describe("capabilityWords", () => {
  test("a capability the catalog is SILENT about is not rendered as absent", () => {
    // `undefined` is not `false`. The slim catalog carries `supportsTools` for most
    // models and nothing for some, and printing an absence would be claiming a fact
    // nobody has.
    expect(capabilityWords(model({ supportsTools: true }))).toEqual(["tools"]);
    expect(capabilityWords(model({}))).toEqual([]);
    expect(capabilityWords(model({ supportsTools: false }))).toEqual([]);
  });

  test("all three are listed in a fixed order when all three are known", () => {
    expect(
      capabilityWords(model({ supportsTools: true, supportsReasoning: true, supportsVision: true }))
    ).toEqual(["tools", "reasoning", "vision"]);
  });
});

describe("detailText", () => {
  test("the exact spec leads, so the picker never hides its own return value", () => {
    const { text } = detailText("google@gemini-3.8-flash", model({ releaseDate: "2026-09-14" }));
    expect(text.startsWith("google@gemini-3.8-flash")).toBe(true);
    expect(text).toContain("2026-09");
  });

  test("`supportsTools: false` is DISQUALIFYING and says so in words", () => {
    // A model that cannot take tool definitions cannot drive Claude Code at all,
    // which is a different claim from "it is a bit less capable".
    expect(detailText("x@y", model({ supportsTools: false })).warn).toContain("no tool support");
    expect(detailText("x@y", model({ supportsTools: true })).warn).toBe("");
    expect(detailText("x@y", model({})).warn).toBe("");
  });
});

describe("providerFactsText", () => {
  test("billing is a SENTENCE, not a symbol — a flat rate says it costs nothing per token", () => {
    const sub = providerFactsText({
      label: "Kimi Coding",
      shortcut: "kc@",
      billing: "sub",
      envVar: "KIMI_CODING_API_KEY",
    });
    expect(sub.billing).toContain("flat-rate");
    expect(sub.billing).toContain("no per-token");
    // The short form makes the SAME claim in fewer words, for a row that cannot
    // afford the sentence — never a different claim, and never silence.
    expect(sub.billingShort).toContain("flat-rate");
    expect(sub.billingShort.length).toBeLessThan(sub.billing.length);
    expect(
      providerFactsText({ label: "", shortcut: "", billing: "metered", envVar: "" }).billing
    ).toContain("per token");
    expect(
      providerFactsText({ label: "", shortcut: "", billing: "local", envVar: "" }).billing
    ).toContain("this machine");
  });

  test("the credential is NAMED, and a sign-in provider says so instead of naming nothing", () => {
    // A truncated or absent variable name sends the reader hunting for a variable
    // that does not exist — a defect this dialog has already shipped once.
    expect(
      providerFactsText({
        label: "OpenRouter",
        shortcut: "or@",
        billing: "metered",
        envVar: "OPENROUTER_API_KEY",
      }).auth
    ).toBe("OPENROUTER_API_KEY");
    expect(
      providerFactsText({ label: "Devin", shortcut: "dv@", billing: "sub", envVar: "" }).auth
    ).toContain("signs in");
  });
});

describe("descriptionLines", () => {
  test("a short sentence is one row and is not padded into two", () => {
    expect(descriptionLines("A fast model.", 40, 2)).toEqual(["A fast model."]);
  });

  test("no row exceeds the width, and an over-long blurb ends in an ellipsis", () => {
    const long =
      "Kimi's most capable model to date, with 2.8 trillion parameters, native visual reasoning, " +
      "and a context window measured in millions of tokens across every supported modality.";
    const rows = descriptionLines(long, 40, 2);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40);
    expect(rows[1]?.endsWith("…")).toBe(true);
  });

  test("an absent description is NO rows — the block draws its own blanks", () => {
    // Returning `[""]` would be indistinguishable from a one-row description at the
    // call site, and the block's fixed height is what keeps the footer still.
    expect(descriptionLines("   ", 40, 2)).toEqual([]);
  });
});

describe("row identity depends on the VIEW", () => {
  const row = (provider: string, id: string, spec: string): PickerRow =>
    ({ provider, shortcut: "", spec, price: "", model: model({ id }) }) as PickerRow;

  test("ALL MODELS: one model on N providers is N rows, with N distinct specs", () => {
    // The owner's rule, verbatim: "if model has more than one provider that going
    // to be two lines in 'all models' list". `gpt-6-astra` at $30.00 on OpenRouter
    // beside the same model as SUB on Codex is the single most useful thing this
    // list does, and keying on the model id alone would delete two of the three.
    const kept = dedupeByProviderModel([
      row("openrouter", "gpt-6-astra", "openrouter@openai/gpt-6-astra"),
      row("openai", "gpt-6-astra", "oai@gpt-6-astra"),
      row("openai-codex", "gpt-6-astra", "cx@gpt-6-astra"),
    ]);
    expect(kept.length).toBe(3);
    expect(new Set(kept.map((r) => r.spec)).size).toBe(3);
  });

  test("ALL MODELS: the same model TWICE under ONE provider is still one row", () => {
    // A provider's live roster and its catalog entries overlap, and that overlap
    // is not two routes — it is one route described twice.
    const kept = dedupeByProviderModel([
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k2.6", "kimi@kimi-k2.6"),
    ]);
    expect(kept.map((r) => r.model.id)).toEqual(["kimi-k3", "kimi-k2.6"]);
  });

  test("PROVIDER CATALOG: one row per model id, roster and catalog collapsed", () => {
    // "and if we enter to provider catalog, not all models - then the model will
    // be just one". One route is in scope, so a second row would mean nothing —
    // even when the two sources spell the spec differently.
    const kept = dedupeByModelId([
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k3", "kimi@moonshot/kimi-k3"),
      row("kimi", "kimi-k2.6", "kimi@kimi-k2.6"),
    ]);
    expect(kept.length).toBe(2);
    // The FIRST wins, and the caller puts the live roster first — what the
    // endpoint answered for THESE credentials beats what the catalog says.
    expect(kept[0]?.spec).toBe("kimi@kimi-k3");
  });
});

describe("providerColumn", () => {
  const entry = (value: string, label: string, shortcut: string) => ({ value, label, shortcut });

  test("NO TWO PROVIDERS EVER RENDER THE SAME STRING — the rejected rail's defect", () => {
    // `OpenCode Zen` and `OpenCode Zen Go` share a twelve-character prefix, which is
    // exactly the collision that rendered two different providers as `opencod…`.
    const { cells, text } = providerColumn(
      [
        entry("opencode-zen", "OpenCode Zen", "zen@"),
        entry("opencode-zen-go", "OpenCode Zen Go", "zengo@"),
        entry("sakana", "Sakana Fugu", "fugu@"),
        entry("sakana-subscription", "Sakana Fugu Subscription", "sc@"),
        entry("openrouter", "OpenRouter", "or@"),
      ],
      truncate
    );
    const drawn = [...text.values()];
    expect(new Set(drawn).size).toBe(drawn.length);
    for (const s of drawn) expect(s.length).toBeLessThanOrEqual(cells);
  });

  test("a name that FITS is printed whole — truncation is the exception, not the rule", () => {
    const { text } = providerColumn(
      [entry("openrouter", "OpenRouter", "or@"), entry("openai", "OpenAI", "oai@")],
      truncate
    );
    expect(text.get("openrouter")).toBe("OpenRouter");
    expect(text.get("openai")).toBe("OpenAI");
  });

  test("names that cannot be separated at ANY width fall back to the unique shortcut", () => {
    // Two custom endpoints with the same long name is a real configuration; the
    // shortcut is unique by construction because it is the shortest prefix that
    // parses back to exactly one provider.
    const same = "A Very Long Custom Endpoint Name";
    const { text } = providerColumn([entry("a", same, "aa@"), entry("b", same, "bb@")], truncate);
    const drawn = [...text.values()];
    expect(new Set(drawn).size).toBe(2);
    expect(drawn.some((s) => s.includes("bb@"))).toBe(true);
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

  test("`empty-roster` and `all-filtered` say DIFFERENT things", () => {
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

  test("A FALLBACK LIST SAYS IT MAY NOT WORK, not merely where it came from", () => {
    // The single most useful sentence in this state, and the one the shipped stderr
    // wording never carried: discovery failed because the credential was rejected,
    // so nothing has confirmed the account can call any of these models. A reader
    // told only "catalog entries" concludes the list is differently-sourced, picks
    // one, and finds out at launch.
    const c = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: [
          "\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n",
          "  Showing Kimi's cloud-catalog entries below — not its live roster.\n\n",
        ],
        fallbackRows: [model(), model({ id: "b" }), model({ id: "c" }), model({ id: "d" })],
      },
      "Kimi"
    );
    const joined = c?.lines.join(" ") ?? "";
    expect(joined).toContain("The 4 rows below");
    expect(joined).toContain("not Kimi's live roster");
    expect(joined).toContain("may still fail");
    // The formatter's own shorter sentence is REPLACED, not printed beside it.
    expect(joined).not.toContain("Showing Kimi's cloud-catalog entries");
  });

  test("no fallback list gets a next step instead of a provenance sentence", () => {
    const without = discoveryNoticeContent(
      { kind: "empty-roster", failure: failure({ kind: "empty-roster" }), fallbackRows: [] },
      "Kimi"
    );
    expect(without?.lines.join(" ")).toContain("Press c");
    expect(without?.lines.join(" ")).not.toContain("may still fail");
  });

  test("the dialog status for a failure says UNAVAILABLE, not broken", () => {
    const c = discoveryNoticeContent(
      { kind: "failed", failure: failure(), notice: ["⚠ x"], fallbackRows: [model()] },
      "Kimi"
    );
    expect(c?.title).toBe("live roster unavailable");
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

describe("wrapWords / noticeRows", () => {
  test("a line that fits is returned untouched", () => {
    expect(wrapWords("short enough", 40)).toEqual(["short enough"]);
  });

  test("no wrapped row exceeds the width", () => {
    const long =
      "The 4 rows below are catalog entries, not Kimi / Moonshot's live roster — they do not confirm access, so launching one may still fail.";
    for (const w of [30, 48, 70]) {
      for (const line of wrapWords(long, w)) expect(line.length).toBeLessThanOrEqual(w);
    }
  });

  test("THE `may still fail` CLAUSE SURVIVES AT 80 COLUMNS", () => {
    // It is the tail of the sentence, so a truncating banner would take it first —
    // which is exactly the failure this whole state exists to prevent.
    const content = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: [
          "\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n",
          "  Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).\n",
          "  Get a key: https://platform.moonshot.cn/\n",
        ],
        fallbackRows: [model(), model({ id: "b" }), model({ id: "c" }), model({ id: "d" })],
      },
      "Kimi"
    );
    // 76-column dialog: 2 border, 2 padding, 2 for the banner's own rule + gutter.
    const rows = noticeRows(content!, 70, 5);
    expect(rows.lines.join(" ")).toContain("may still fail");
    expect(rows.lines.length).toBeLessThanOrEqual(5);
    expect(rows.badge).toBe("HTTP 401");
  });

  test("the row count is knowable BEFORE render — the inline row budget depends on it", () => {
    const content = discoveryNoticeContent(
      { kind: "failed", failure: failure(), notice: ["⚠ x"], fallbackRows: [] },
      "Kimi"
    );
    const rows = noticeRows(content!, 70, 5);
    expect(rows.lines.length).toBeGreaterThan(0);
    expect(rows.lines.length).toBeLessThanOrEqual(5);
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
