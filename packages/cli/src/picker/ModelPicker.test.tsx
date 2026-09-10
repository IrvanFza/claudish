import { describe, expect, test } from "bun:test";
/** @jsxImportSource @opentui/react */
/**
 * Tier 2 — `testRender` over the real component tree, with the loaders injected.
 *
 * `renderOnce()` IS MANDATORY before every capture, or every cell comes back as
 * unpainted filler and the assertion measures nothing.
 *
 * TWO CAPTURES, TWO BLINDNESSES. `captureCharFrame()` sees text and layout and is
 * BLIND to a heat row of coloured spaces and to a one-column stub of background left
 * behind by a squeezed widget — a whole character-level suite once passed over a mangled
 * row. `captureSpans()` sees colour, which is where the severity tiers and the gradient
 * live. Both are used here, for the things each can decide.
 *
 * THE DATA SOURCE IS A PARAMETER, NEVER `mock.module()`: mocking shared infrastructure
 * bleeds across Bun's module registry and breaks sibling e2e files.
 */
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
import { C } from "../tui/theme.js";
import { ModelPicker } from "./ModelPicker.js";
import type { CatalogLoad, PickerDataSource, RailChoice } from "./PickerDataSource.js";

// ── a scriptable source ──────────────────────────────────────────────────────────

const rail = (over: Partial<RailChoice> = {}): RailChoice => ({
  value: "kimi",
  label: "kimi",
  description: "Direct API",
  billing: "metered",
  envVar: "MOONSHOT_API_KEY",
  hasDiscovery: true,
  discoveryShape: "deadline",
  ...over,
});

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "kimi-k3",
  name: "kimi-k3",
  description: "a model",
  provider: "Kimi",
  contextLength: 1_000_000,
  context: "1M",
  supportsTools: true,
  pricing: { input: "$1", output: "$2", average: "$9.00/1M" },
  ...over,
});

interface FakeOpts {
  roster?: RailChoice[];
  ready?: Record<string, boolean>;
  outcome?: PickerDiscoveryOutcome;
  catalogRows?: ModelInfo[];
  /** Never settles — the in-flight states. */
  hang?: boolean;
}

function fakeSource(opts: FakeOpts = {}): PickerDataSource {
  const roster = opts.roster ?? [rail()];
  const never = new Promise<never>(() => {});
  return {
    providerRoster: () => roster,
    notEnabledLocalProviders: () => [],
    displayName: (p) => (p === "kimi" ? "Kimi / Moonshot" : p),
    async *probeCredentials(names) {
      if (opts.hang) await never;
      for (const n of names) yield [n, opts.ready?.[n] ?? true] as [string, boolean];
    },
    loadCatalog: (): Promise<CatalogLoad> =>
      opts.hang ? never : Promise.resolve({ top: [], recommended: [] }),
    discoverRoster: (): Promise<PickerDiscoveryOutcome> =>
      opts.hang
        ? never
        : Promise.resolve(
            opts.outcome ?? {
              kind: "rows",
              rows: [model()],
              servedCount: 1,
              chatCount: 1,
            }
          ),
    catalogModels: () => (opts.hang ? never : Promise.resolve(opts.catalogRows ?? [])),
  };
}

/** Always destroy in `finally`: a leaked renderer keeps native threads alive and hangs `bun test`. */
async function draw(
  node: ReactNode,
  width = 80,
  height = 24,
  settleMs = 0
): Promise<{ text: string[]; frame: CapturedFrame }> {
  const { renderOnce, captureCharFrame, captureSpans, renderer } = await testRender(node, {
    width,
    height,
  });
  try {
    await renderOnce();
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
      await renderOnce();
    }
    return { text: captureCharFrame().split("\n"), frame: captureSpans() };
  } finally {
    renderer.destroy();
  }
}

const joined = (text: string[]): string => text.join("\n");
const bgs = (f: CapturedFrame): Set<string> =>
  new Set(f.lines.flatMap((l) => l.spans.map((s) => s.bg.toInts().slice(0, 3).join())));
const rgb = (hex: string): string =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join();

// ── the first frame ──────────────────────────────────────────────────────────────

describe("the first frame", () => {
  test("lists EVERY pickable provider before any probe resolves", async () => {
    // FR-1's structural half: the rail is derived synchronously, so a blank frame is
    // not reachable — not "unlikely", not reachable.
    const roster = ["openrouter", "google", "kimi"].map((v) => rail({ value: v, label: v }));
    const { text } = await draw(
      <ModelPicker source={fakeSource({ roster, hang: true })} onDone={() => {}} />
    );
    for (const name of ["openrouter", "google", "kimi"]) {
      expect(joined(text)).toContain(name);
    }
  });

  test("no rendered row exceeds the frame width, at 80 and at 145", async () => {
    for (const width of [80, 145]) {
      const { text } = await draw(
        <ModelPicker source={fakeSource()} onDone={() => {}} />,
        width,
        width === 80 ? 24 : 45,
        30
      );
      const over = text.filter((l) => l.length > width);
      expect({ width, over }).toEqual({ width, over: [] });
    }
  });

  test("the footer's hints are present and unclipped at 80×24", async () => {
    const { text } = await draw(
      <ModelPicker source={fakeSource()} onDone={() => {}} />,
      80,
      24,
      30
    );
    // `captureCharFrame()` ends with a trailing newline, so the LAST element is "".
    const footer = text.filter((l) => l.trim() !== "").pop() ?? "";
    for (const hint of ["move", "select", "filter", "pane", "custom", "cancel"]) {
      expect(footer).toContain(hint);
    }
  });
});

// ── provenance: the user's actual complaint ──────────────────────────────────────

describe("a fallback list says it is a fallback", () => {
  const failed: PickerDiscoveryOutcome = {
    kind: "failed",
    failure: {
      kind: "unauthorized",
      provider: "kimi",
      status: 401,
      endpoint: "https://api.moonshot.ai/v1/models",
    },
    notice: [
      "\n⚠ Kimi / Moonshot could not list its models: the API key was rejected (HTTP 401)\n",
      "  Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).\n",
      "  Get a key: https://platform.moonshot.cn/\n",
      "  Showing Kimi / Moonshot's cloud-catalog entries below — not its live roster.\n\n",
    ],
    fallbackRows: [model()],
  };

  test("the panel title, the per-row mark and the banner all say it", async () => {
    const { text } = await draw(
      <ModelPicker source={fakeSource({ outcome: failed })} onDone={() => {}} />,
      80,
      24,
      40
    );
    const all = joined(text);
    expect(all).toContain("cloud catalog (fallback)");
    expect(all).toContain("cat");
    expect(all).toContain("not its live roster");
  });

  test("a LIVE roster carries no mark and no fallback title — which is what makes the mark a signal", async () => {
    const { text } = await draw(
      <ModelPicker source={fakeSource()} onDone={() => {}} />,
      80,
      24,
      40
    );
    const all = joined(text);
    expect(all).toContain("live roster");
    expect(all).not.toContain("fallback");
    // The mark's COLUMN is reserved on both kinds of list so the cells left of it do
    // not move; what a live row must not carry is the word.
    expect(all.split("\n").filter((l) => /\bcat\b/.test(l))).toEqual([]);
  });

  test("the failed banner names the provider, the kind, the env var and the key URL", async () => {
    const { text } = await draw(
      <ModelPicker source={fakeSource({ outcome: failed })} onDone={() => {}} />,
      145,
      45,
      40
    );
    const all = joined(text);
    expect(all).toContain("Kimi / Moonshot");
    expect(all).toContain("the API key was rejected");
    expect(all).toContain("MOONSHOT_API_KEY");
    expect(all).toContain("platform.moonshot.cn");
  });

  test("the banner never exceeds four rows on a short terminal", async () => {
    const { text } = await draw(
      <ModelPicker source={fakeSource({ outcome: failed })} onDone={() => {}} />,
      80,
      24,
      40
    );
    // The banner sits between the panes and the footer; count the rows carrying its
    // left rule. Four is the whole budget at `height < 30`, chrome included.
    const ruled = text.filter((l) => l.trimStart().startsWith("│") && l.includes("Moonshot"));
    expect(ruled.length).toBeLessThanOrEqual(4);
  });

  test("`empty-roster` renders in the NOTICE tier, without the error wash", async () => {
    // `captureCharFrame` is blind to this: the two tiers differ in COLOUR as well as in
    // words, and the colour is the half a reader sees first.
    const empty: PickerDiscoveryOutcome = {
      kind: "empty-roster",
      failure: { kind: "empty-roster", provider: "kimi", endpoint: "https://api.test/v1/models" },
      fallbackRows: [model()],
    };
    const failedFrame = await draw(
      <ModelPicker source={fakeSource({ outcome: failed })} onDone={() => {}} />,
      80,
      24,
      40
    );
    const emptyFrame = await draw(
      <ModelPicker source={fakeSource({ outcome: empty })} onDone={() => {}} />,
      80,
      24,
      40
    );
    expect(bgs(failedFrame.frame).has(rgb(C.bgError))).toBe(true);
    expect(bgs(emptyFrame.frame).has(rgb(C.bgError))).toBe(false);
    expect(joined(emptyFrame.text)).toContain("empty");
  });
});

// ── colour, which only spans can see ─────────────────────────────────────────────

describe("the context meter is a real gradient", () => {
  test("a wide row's filled cells carry many distinct colours", async () => {
    // The negative control against a flat one-colour bar and against a four-glyph
    // `░▒▓█` ramp — both score 1 here.
    const rows = [
      model({ id: "a", contextLength: 1_000_000, context: "1M" }),
      model({ id: "b", contextLength: 8_000, context: "8K" }),
    ];
    const { frame } = await draw(
      <ModelPicker
        source={fakeSource({
          outcome: { kind: "rows", rows: [rows[0]!, rows[1]!], servedCount: 2, chatCount: 2 },
        })}
        onDone={() => {}}
      />,
      145,
      45,
      40
    );
    const fgs = new Set(
      frame.lines
        .filter((l) => l.spans.some((s) => s.text.includes("█")))
        .flatMap((l) =>
          l.spans.filter((s) => s.text.includes("█")).map((s) => s.fg.toInts().join())
        )
    );
    expect(fgs.size).toBeGreaterThanOrEqual(12);
  });
});

// ── the rail's steady state ──────────────────────────────────────────────────────

describe("the rail", () => {
  test("collapses unready providers into ONE summary row rather than listing them", async () => {
    const roster = ["openrouter", "google", "kimi"].map((v) => rail({ value: v, label: v }));
    const { text } = await draw(
      <ModelPicker
        source={fakeSource({ roster, ready: { openrouter: true, google: false, kimi: false } })}
        onDone={() => {}}
      />,
      80,
      24,
      40
    );
    const all = joined(text);
    expect(all).toContain("openrouter");
    expect(all).toContain("+2 need a key");
    // The two unready ones are ABSENT from the rail, not listed and greyed — the steady
    // state matches the roster the old picker showed.
    expect(all).not.toContain("google");
  });
});
