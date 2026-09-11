import { describe, expect, test } from "bun:test";
/** @jsxImportSource @opentui/react */
/**
 * Tier 2 — `testRender` over the real component tree, with the loaders injected.
 *
 * `renderOnce()` IS MANDATORY before every capture, or every cell comes back as
 * unpainted filler and the assertion measures nothing.
 *
 * TWO CAPTURES, TWO BLINDNESSES. `captureCharFrame()` sees text and layout and is
 * BLIND to a wash of coloured spaces and to a one-column stub of background left
 * behind by a squeezed widget — a whole character-level suite once passed over a
 * mangled row. `captureSpans()` sees colour, which is where the severity tiers and
 * the selection wash live. Both are used here, for the things each can decide.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE ONES ABOUT THE REJECTED BUILD. The owner's
 * report was "super unclear what is happening"; the diagnosis was two panes each
 * holding a cursor, and a meter on every row carrying a value that was identical on
 * 19 of 32 rows. So: exactly ONE cursor glyph on screen, and NO block-fill glyph in
 * any list row. Both are decidable from a frame, and both would have failed the
 * build that shipped.
 *
 * AND THE ONES ABOUT THE ROUND-TWO CORRECTION, which are about what the picker does
 * NOT do. `calls` counts every loader the fake is asked for, so "nothing is fetched
 * before the user asks for it" is an assertion rather than a claim in a comment —
 * and it is the one that would have caught the build the owner rejected, which
 * looked correct and simply did too much.
 *
 * THE DATA SOURCE IS A PARAMETER, NEVER `mock.module()`: mocking shared
 * infrastructure bleeds across Bun's module registry and breaks sibling e2e files.
 */
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
import type { DescriptionIndex } from "../providers/model-descriptions.js";
import { C } from "../tui/theme.js";
import { ModelPicker } from "./ModelPicker.js";
import { MAX_DIALOG_ROWS } from "./layout.js";
import type { PickerDataSource, PickerProviderChoice } from "./PickerDataSource.js";

// ── a scriptable source ──────────────────────────────────────────────────────────

const provider = (over: Partial<PickerProviderChoice> = {}): PickerProviderChoice => ({
  value: "kimi",
  label: "Kimi / Moonshot",
  shortcut: "kimi@",
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
  roster?: PickerProviderChoice[];
  ready?: Record<string, boolean>;
  outcome?: PickerDiscoveryOutcome;
  /** Per-provider discovery outcomes. Falls back to `outcome`. */
  outcomes?: Record<string, PickerDiscoveryOutcome>;
  /** Per-provider served lists; falls back to `served`. */
  byProvider?: Record<string, ModelInfo[]>;
  served?: ModelInfo[];
  /** `modelId` → prose sentence, as the description index answers. */
  descriptions?: Record<string, string>;
  /** Never settles — the in-flight states. */
  hang?: boolean;
}

/** Every loader the picker may reach for, counted. See the file header. */
interface Calls {
  catalog: number;
  descriptions: number;
  discover: string[];
}

function fakeSource(opts: FakeOpts = {}): PickerDataSource & { calls: Calls } {
  const roster = opts.roster ?? [provider()];
  const never = new Promise<never>(() => {});
  const descriptions = opts.descriptions ?? {};
  const calls: Calls = { catalog: 0, descriptions: 0, discover: [] };
  return {
    calls,
    providerRoster: () => roster,
    notEnabledLocalProviders: () => [],
    displayName: (p) => roster.find((r) => r.value === p)?.label ?? p,
    async *probeCredentials(names) {
      if (opts.hang) await never;
      for (const n of names) yield [n, opts.ready?.[n] ?? true] as [string, boolean];
    },
    ensureCatalog: (): Promise<void> => {
      calls.catalog++;
      return opts.hang ? never : Promise.resolve();
    },
    servedModels: (p) => opts.byProvider?.[p] ?? opts.served ?? [model()],
    discoverRoster: (p): Promise<PickerDiscoveryOutcome> => {
      calls.discover.push(p);
      return opts.hang
        ? never
        : Promise.resolve(
            opts.outcomes?.[p] ??
              opts.outcome ?? { kind: "rows", rows: [model()], servedCount: 1, chatCount: 1 }
          );
    },
    descriptions: (): Promise<DescriptionIndex> => {
      calls.descriptions++;
      return opts.hang
        ? never
        : Promise.resolve({
            get: (id: string) => descriptions[id],
            size: Object.keys(descriptions).length,
          });
    },
  };
}

interface Drawn {
  text: string[];
  frame: CapturedFrame;
  press: (keys: string[]) => Promise<void>;
  /** Re-render until the frame satisfies `pred`, or give up and let the assert speak. */
  until: (pred: (text: string[]) => boolean) => Promise<void>;
  recapture: () => { text: string[]; frame: CapturedFrame };
  destroy: () => void;
}

/** Always destroy in `finally`: a leaked renderer keeps native threads alive and hangs `bun test`. */
async function draw(node: ReactNode, width = 80, height = 24, settleMs = 30): Promise<Drawn> {
  const { renderOnce, captureCharFrame, captureSpans, renderer, mockInput } = await testRender(
    node,
    { width, height }
  );
  await renderOnce();
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
    await renderOnce();
  }
  const recapture = (): { text: string[]; frame: CapturedFrame } => ({
    text: captureCharFrame().split("\n"),
    frame: captureSpans(),
  });
  return {
    ...recapture(),
    press: async (keys) => {
      await mockInput.pressKeys(keys as never);
      await new Promise((r) => setTimeout(r, 20));
      await renderOnce();
    },
    /**
     * A FIXED SLEEP AFTER A KEYSTROKE IS A FLAKE, and this suite proved it: the
     * keystroke that opens a list starts an effect, and on a loaded machine the
     * 20 ms after it is not always enough for the effect, the state update and the
     * next paint. Under `bun test` with 212 files in flight it failed once and
     * passed alone, which is the worst signal there is. Polling for the CONDITION
     * the test is about takes the load out of the assertion; the deadline is short
     * enough that a genuine regression still fails in well under a second.
     */
    until: async (pred) => {
      for (let i = 0; i < 40; i++) {
        if (pred(captureCharFrame().split("\n"))) return;
        await new Promise((r) => setTimeout(r, 25));
        await renderOnce();
      }
    },
    recapture,
    destroy: () => renderer.destroy(),
  };
}

const joined = (text: string[]): string => text.join("\n");
const bgs = (f: CapturedFrame): Set<string> =>
  new Set(f.lines.flatMap((l) => l.spans.map((s) => s.bg.toInts().slice(0, 3).join())));
const rgb = (hex: string): string =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join();
/**
 * HAS A MODEL LIST FINISHED PAINTING? The filter row's `newest first` is drawn by
 * the list phase and by nothing else — not by the loading dialog, not by the
 * provider list — so it is the one string that separates "the view flipped" from
 * "the view flipped and the rows are there".
 *
 * `▶` would not do: every list in this picker draws a cursor, including the one the
 * keystroke just left, so a predicate on it is satisfied before anything has
 * happened and waits for nothing.
 */
const listPainted = (t: string[]): boolean => t.join("").includes("newest first");
const providerListPainted = (t: string[]): boolean => t.join("").includes("choose a provider");
/** Rows that carry painted content — the dialog's actual footprint. */
const painted = (text: string[]): string[] => text.filter((l) => l.trim() !== "");
/**
 * The frame with its border glyphs and line breaks flattened away.
 *
 * A wrapped sentence is still ONE sentence to the reader, and an assertion that
 * cannot see across a wrap would pass a build that had truncated the half that
 * matters.
 */
const flat = (text: string[]): string =>
  text
    .join(" ")
    .replace(/[│┃▌╭╮╰╯─]/g, " ")
    .replace(/\s+/g, " ");

// ── the shape of the thing ───────────────────────────────────────────────────────

describe("the dialog", () => {
  test("is COMPACT and INLINE — it does not fill a 45-row terminal", async () => {
    // The whole correction, in one assertion. The rejected build was
    // `height={terminalHeight}` on the alternate screen; this one is a box that
    // leaves the user's shell on screen around it.
    const d = await draw(<ModelPicker source={fakeSource()} onDone={() => {}} />, 145, 45);
    try {
      expect(painted(d.text).length).toBeLessThanOrEqual(20);
      // …and it is horizontally bounded too, not a full-width strip.
      expect(Math.max(...painted(d.text).map((l) => l.trimEnd().length))).toBeLessThan(145);
    } finally {
      d.destroy();
    }
  });

  test("has EXACTLY ONE cursor — the direct answer to “unclear what is happening”", async () => {
    // Two panes each held a cursor and only a border colour said which one the arrow
    // keys drove. One list, one `▶` — on the landing screen and inside a list alike.
    const roster = ["openrouter", "kimi", "google"].map((v) =>
      provider({ value: v, label: v, shortcut: `${v}@`, hasDiscovery: false })
    );
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster, served: [model({ id: "a" }), model({ id: "b" })] })}
        onDone={() => {}}
      />
    );
    try {
      expect(joined(d.text).split("▶").length - 1).toBe(1);
      await d.press(["a"]);
      await d.until(listPainted);
      expect(joined(d.recapture().text).split("▶").length - 1).toBe(1);
    } finally {
      d.destroy();
    }
  });

  test("NO list row carries a bar, a gradient or a block fill", async () => {
    // The rejected build put a context meter and a price meter on every row because a
    // whole-frame graphics-density gate counted a row with a bar as a graphics row.
    // Of 32 visible rows, 19 read `1M` and their bars were indistinguishable.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: [provider({ hasDiscovery: false })],
          served: [
            model({ id: "a", contextLength: 1_000_000, context: "1M" }),
            model({ id: "b", contextLength: 8_000, context: "8K" }),
          ],
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["a"]);
      await d.until(listPainted);
      const rows = d.recapture().text.filter((l) => /\ba\b|\bb\b/.test(l));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toMatch(/[█▓▒░╌]/);
    } finally {
      d.destroy();
    }
  });

  test("no rendered row exceeds the frame width, at 80 and at 145", async () => {
    for (const [width, height] of [
      [80, 24],
      [145, 45],
    ] as const) {
      const d = await draw(<ModelPicker source={fakeSource()} onDone={() => {}} />, width, height);
      try {
        expect({ width, over: d.text.filter((l) => l.length > width) }).toEqual({
          width,
          over: [],
        });
        await d.press(["a"]);
        await d.until(listPainted);
        expect({
          width,
          over: d.recapture().text.filter((l) => l.length > width),
        }).toEqual({ width, over: [] });
      } finally {
        d.destroy();
      }
    }
  });

  test("the key hints are present and unclipped at 80×24, in BOTH lists", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster: [provider({ hasDiscovery: false })] })}
        onDone={() => {}}
      />
    );
    try {
      // The hints row is the last PAINTED row above the bottom border.
      const footer = (): string => painted(d.recapture().text).at(-2) ?? "";
      for (const hint of ["move", "open", "all models", "custom", "quit"]) {
        expect(footer()).toContain(hint);
      }
      await d.press(["a"]);
      await d.until(listPainted);
      for (const hint of ["move", "select", "filter", "custom", "providers"]) {
        expect(footer()).toContain(hint);
      }
    } finally {
      d.destroy();
    }
  });
});

// ── the landing screen, and everything it does NOT do ────────────────────────────

describe("the picker opens on the PROVIDER list", () => {
  const roster = [
    provider({
      value: "openrouter",
      label: "OpenRouter",
      shortcut: "or@",
      envVar: "OPENROUTER_API_KEY",
      hasDiscovery: false,
    }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: true }),
  ];

  test("lands on providers — not on a 574-row list of every model", async () => {
    // The owner, verbatim: "we should not show the full list of models, we should
    // show a list of providers by default and only when we go inside we load and
    // resolve all models".
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster, byProvider: { openrouter: [model({ id: "glm-5.3" })] } })}
        onDone={() => {}}
      />
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("choose a provider");
      expect(all).toContain("OpenRouter");
      // Not one model id, because nothing has been asked for one.
      expect(all).not.toContain("glm-5.3");
    } finally {
      d.destroy();
    }
  });

  test("FETCHES NOTHING before the user asks — no catalog, no roster, no descriptions", async () => {
    // "why we prefetching? we should not, as we show on demand". The build this
    // replaces warmed the cloud catalog AND fanned out one roster request per
    // credentialled provider, on a screen that could show neither.
    const source = fakeSource({ roster });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      expect(source.calls).toEqual({ catalog: 0, descriptions: 0, discover: [] });
      // …and the screen does not claim to be doing any of it.
      expect(joined(d.text)).not.toContain("cloud catalog");
      expect(joined(d.text)).not.toContain("live rosters");
    } finally {
      d.destroy();
    }
  });

  test("a provider with NO credential is not on the list, and the omission is counted", async () => {
    // "we should not show unsetted providers, just active". Not deleted — counted,
    // with the key that brings them back, because an unexplained absence is the
    // defect class this feature exists to remove.
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster, ready: { openrouter: true, "kimi-coding": false } })}
        onDone={() => {}}
      />
    );
    try {
      const before = joined(d.text);
      expect(before).toContain("OpenRouter");
      expect(before).not.toContain("Kimi Coding");
      expect(before).not.toContain("MOONSHOT_API_KEY");
      expect(before).toContain("+1 more need a key");

      await d.press(["k"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("Kimi Coding");
      // Revealed WITH the exact variable to inspect, which is the whole value of
      // showing them at all.
      expect(after).toContain("MOONSHOT_API_KEY");
    } finally {
      d.destroy();
    }
  });

  test("NO model count is printed for a provider nothing has counted yet", async () => {
    // "we could not show number of models for some of them". A `0`, a `—` or a guess
    // in that column is a claim; silence is not.
    const d = await draw(<ModelPicker source={fakeSource({ roster })} onDone={() => {}} />);
    try {
      const row = d.text.find((l) => l.includes("OpenRouter")) ?? "";
      expect(row).toContain("OpenRouter");
      expect(row).not.toMatch(/\bmodels?\b/);
      expect(row).not.toContain("—");
    } finally {
      d.destroy();
    }
  });

  test("Escape on the landing screen CANCELS by returning null — never `process.exit`", async () => {
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["ESCAPE"]);
      expect(got).toBeNull();
    } finally {
      d.destroy();
    }
  });
});

// ── entering a provider is what fetches it ───────────────────────────────────────

describe("entering a provider loads THAT provider, on demand", () => {
  const roster = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "devin", label: "Devin", shortcut: "dv@", hasDiscovery: true }),
  ];

  test("`⏎` asks the provider under the cursor, and ONLY that one", async () => {
    const source = fakeSource({
      roster,
      byProvider: { openrouter: [model({ id: "glm-5.3" })], devin: [] },
      outcomes: {
        devin: { kind: "rows", rows: [model({ id: "devin-1" })], servedCount: 1, chatCount: 1 },
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["ARROW_DOWN"]);
      await d.press(["RETURN"]);
      await d.until(listPainted);
      expect(source.calls.discover).toEqual(["devin"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("Devin");
      expect(all).toContain("devin-1");
    } finally {
      d.destroy();
    }
  });

  test("inside one provider a model appears exactly ONCE", async () => {
    // The owner's rule: "if we enter to provider catalog, not all models — then the
    // model will be just one".
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: [provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false })],
          byProvider: {
            openrouter: [model({ id: "gpt-6-astra" }), model({ id: "gpt-6-astra" })],
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["RETURN"]);
      await d.until(listPainted);
      const rows = d.recapture().text.filter((l) => l.includes("gpt-6-astra"));
      // One list row, plus the detail line under the list that prints the spec.
      expect(rows.filter((l) => l.includes("OpenRouter")).length).toBe(1);
    } finally {
      d.destroy();
    }
  });

  test("`esc` comes back to the provider list rather than quitting", async () => {
    let got: string | null | undefined = undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(listPainted);
      await d.press(["ESCAPE"]);
      // A LONE `\x1B` IS AMBIGUOUS UNTIL THE NEXT BYTE OR A TIMEOUT: the parser has
      // to wait to see whether it is the head of `\x1B[B`. One more render pass
      // after that timeout is what makes a bare Escape observable in a test — a
      // real keyboard gets the same delay and nobody notices.
      await d.press([]);
      await d.until(providerListPainted);
      expect(joined(d.recapture().text)).toContain("choose a provider");
      expect(got).toBeUndefined();
    } finally {
      d.destroy();
    }
  });

  test("Enter returns the provider-scoped spec, never a bare model id", async () => {
    // A bare Claude-shaped name reaching `route()` degrades to OpenRouter, so the
    // picker must never emit one.
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: [provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false })],
          byProvider: { openrouter: [model({ id: "gpt-6" })] },
        })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(listPainted);
      await d.press(["RETURN"]);
      // `openrouter@`, not the column's `or@`: `buildExplicitModelSpec` applies the
      // readability OVERRIDES because this is the string the user copies off their
      // screen, while a fixed-width column wants the short form. Both parse back to
      // the same provider — `providerShortcut` records why they differ.
      expect(got).toBe("openrouter@gpt-6");
    } finally {
      d.destroy();
    }
  });

  test("typing filters immediately — there is no search mode to enter", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: [provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false })],
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" }), model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(listPainted);
      await d.press(["g", "l", "m"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
    } finally {
      d.destroy();
    }
  });

  test("`/` makes the letter commands typeable — `codex` is a real model name", async () => {
    // The one collision filter-first creates: `c` opens the custom-spec dialog, so
    // the first keystroke of `codex` would navigate instead of filter. `/` is the
    // escape hatch, and without a test it is the kind of thing that quietly stops
    // working.
    const source = (): PickerDataSource =>
      fakeSource({
        roster: [provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false })],
        byProvider: { openrouter: [model({ id: "codex-2" }), model({ id: "kimi-k3" })] },
      });
    const d = await draw(<ModelPicker source={source()} onDone={() => {}} />);
    try {
      await d.press(["RETURN"]);
      await d.until(listPainted);
      // Bare `c` NAVIGATES — that is the collision, asserted so the escape hatch has
      // something to be an escape from.
      await d.press(["c"]);
      expect(joined(d.recapture().text)).toContain("type a model spec");
      d.destroy();
    } finally {
      /* destroyed above; the second half needs a fresh tree */
    }
    const e = await draw(<ModelPicker source={source()} onDone={() => {}} />);
    try {
      await e.press(["RETURN"]);
      await e.until(listPainted);
      await e.press(["/"]);
      await e.press(["c"]);
      await e.press(["o"]);
      const all = joined(e.recapture().text);
      expect(all).toContain("codex-2");
      expect(all).not.toContain("kimi-k3");
    } finally {
      e.destroy();
    }
  });
});

// ── the cross-provider list, which is no longer the default ──────────────────────

describe("`a` opens the cross-provider list", () => {
  const roster = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: false }),
  ];

  test("it is ONE cached catalog fetch, not a fan-out across providers", async () => {
    const source = fakeSource({
      roster,
      byProvider: {
        openrouter: [model({ id: "glm-5.3-flash" })],
        "kimi-coding": [model({ id: "kimi-k3" })],
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["a"]);
      await d.until(listPainted);
      const all = joined(d.recapture().text);
      expect(all).toContain("all models");
      expect(all).toContain("glm-5.3-flash");
      expect(all).toContain("kimi-k3");
      // ONE warm. And not a single roster request: no provider was opened.
      expect(source.calls.catalog).toBe(1);
      expect(source.calls.discover).toEqual([]);
    } finally {
      d.destroy();
    }
  });

  test("one model on two providers is TWO rows, and the title counts both honestly", async () => {
    // The owner's rule for this list, and the count that goes with it: the rows are
    // ROUTES, so labelling their number "models" would be off by exactly the amount
    // that makes the list useful.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          byProvider: {
            openrouter: [model({ id: "gpt-6-astra" })],
            "kimi-coding": [model({ id: "gpt-6-astra" })],
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["a"]);
      await d.until(listPainted);
      const all = joined(d.recapture().text);
      expect(all).toContain("1 models · 2 routes");
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Kimi Coding");
    } finally {
      d.destroy();
    }
  });

  test("a provider with no credential contributes NO rows, and the count says so", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          ready: { openrouter: true, "kimi-coding": false },
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" })],
            "kimi-coding": [model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["a"]);
      await d.until(listPainted);
      const all = joined(d.recapture().text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
      // The absence is EXPLAINED, in the title, rather than silent.
      expect(all).toContain("1/2 providers");
    } finally {
      d.destroy();
    }
  });

  test("A ROSTER ALREADY OPENED IS MERGED IN — and one not opened costs no request", async () => {
    // The `gemini` report — "why i search gemini i see only open router models, no
    // models from antigravity and devin and subscriptions" — was first answered by
    // fetching every roster at startup, which the owner then rejected as
    // prefetching. This is the answer that survives both: a roster fetched because
    // he OPENED that provider improves this list for free, and a provider he never
    // opened is simply not represented here.
    const withDiscovery = [
      provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
      provider({
        value: "antigravity",
        label: "Antigravity",
        shortcut: "ag@",
        billing: "sub",
        envVar: "",
        hasDiscovery: true,
      }),
    ];
    const source = fakeSource({
      roster: withDiscovery,
      byProvider: {
        openrouter: [model({ id: "gemini-3.8-flash" })],
        // No catalog entries whatsoever — the real Antigravity's situation.
        antigravity: [],
      },
      outcomes: {
        antigravity: {
          kind: "rows",
          rows: [model({ id: "gemini-3.8-flash-tiered", context: "1M" })],
          servedCount: 1,
          chatCount: 1,
        },
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />, 145, 45);
    try {
      // Open Antigravity, look at it, come back out, then ask for all models.
      await d.press(["ARROW_DOWN"]);
      await d.press(["RETURN"]);
      await d.until(listPainted);
      await d.press(["ESCAPE"]);
      // The bare-Escape flush — see the `esc comes back` test. Without it the
      // NEXT key is read as `\x1B` + `a`, which is alt-a and not two keystrokes.
      await d.press([]);
      await d.until(providerListPainted);
      await d.press(["a"]);
      await d.until(listPainted);
      await d.press(["g", "e", "m", "i", "n", "i"]);
      const all = joined(d.recapture().text);
      // BOTH routes, from two different sources, in one filtered list.
      expect(all).toContain("gemini-3.8-flash");
      expect(all).toContain("gemini-3.8-flash-tiered");
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Antigravity");
      // Exactly one roster request, and it was the one he opened.
      expect(source.calls.discover).toEqual(["antigravity"]);
    } finally {
      d.destroy();
    }
  });
});

// ── provenance: the user's actual complaint ──────────────────────────────────────

describe("a fallback list says it is a fallback — and that it may not work", () => {
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
    fallbackRows: [model(), model({ id: "kimi-k2.6" })],
  };

  /**
   * Reach the scoped view: Enter on the first provider.
   *
   * ONE PRESS, and the failure it renders is now a failure the user ASKED for —
   * which is the round-two improvement that came free with on-demand loading. The
   * red panel, the `catalog` rows and `r retry` are unchanged; only the moment
   * they appear is.
   */
  async function scoped(outcome: PickerDiscoveryOutcome, width = 80, height = 24): Promise<Drawn> {
    const d = await draw(
      <ModelPicker source={fakeSource({ outcome })} onDone={() => {}} />,
      width,
      height
    );
    await d.press(["RETURN"]);
    await d.until(listPainted);
    return { ...d, ...d.recapture() };
  }

  test("the title, the per-row mark and the banner all say it", async () => {
    const d = await scoped(failed);
    try {
      const all = joined(d.text);
      expect(all).toContain("live roster unavailable");
      expect(all).toContain("catalog");
      // The sentence WRAPS across two rows, so it is matched against the frame with
      // its border glyphs and line breaks flattened away. A substring test over raw
      // rows would fail on the wrap and say nothing about whether a reader can read
      // it.
      expect(flat(d.text)).toContain("not Kimi / Moonshot's live roster");
    } finally {
      d.destroy();
    }
  });

  test("THE HONESTY LINE IS ON SCREEN AT 80 COLUMNS", async () => {
    // Neither the shipped build nor the rejected one said this. Catalog rows are not
    // merely differently-sourced: discovery failed on the credential, so nothing has
    // confirmed the account can call any of them.
    const d = await scoped(failed);
    try {
      expect(joined(d.text)).toContain("may still fail");
    } finally {
      d.destroy();
    }
  });

  test("the banner names the provider, the cause, the env var and the key URL", async () => {
    const d = await scoped(failed, 145, 45);
    try {
      const all = joined(d.text);
      expect(all).toContain("Kimi / Moonshot");
      expect(all).toContain("the API key was rejected");
      expect(all).toContain("MOONSHOT_API_KEY");
      expect(all).toContain("platform.moonshot.cn");
    } finally {
      d.destroy();
    }
  });

  test("`r retry` is offered — the rejected build had no way back from a failure", async () => {
    const d = await scoped(failed);
    try {
      expect(joined(d.text)).toContain("retry");
    } finally {
      d.destroy();
    }
  });

  test("a LIVE roster carries no mark — which is what makes the mark a signal", async () => {
    const d = await scoped({
      kind: "rows",
      rows: [model()],
      servedCount: 1,
      chatCount: 1,
    });
    try {
      expect(joined(d.text)).not.toContain("catalog");
    } finally {
      d.destroy();
    }
  });

  test("a banner NEVER makes the dialog taller — its rows come out of the list's", async () => {
    // The inline-mode bound. `main-screen` reserves rows by scrolling the user's
    // terminal, so the dialog is allowed to shrink below its cap (a four-row
    // fallback list should look like four rows) but never to exceed it.
    const withBanner = await scoped(failed);
    try {
      expect(painted(withBanner.text).length).toBeLessThanOrEqual(MAX_DIALOG_ROWS);
    } finally {
      withBanner.destroy();
    }
  });

  test("`empty-roster` renders in the NOTICE tier, without the error wash", async () => {
    // `captureCharFrame` is blind to this: the two tiers differ in COLOUR as well as in
    // words, and the colour is the half a reader sees first.
    const failedFrame = await scoped(failed);
    const failedBgs = bgs(failedFrame.frame);
    failedFrame.destroy();
    const emptyFrame = await scoped({
      kind: "empty-roster",
      failure: { kind: "empty-roster", provider: "kimi", endpoint: "https://api.test/v1/models" },
      fallbackRows: [model()],
    });
    try {
      expect(failedBgs.has(rgb(C.bgError))).toBe(true);
      expect(bgs(emptyFrame.frame).has(rgb(C.bgError))).toBe(false);
      expect(joined(emptyFrame.text)).toContain("empty");
    } finally {
      emptyFrame.destroy();
    }
  });
});

// ── what the screen says while it is waiting ─────────────────────────────────────

describe("the loading states", () => {
  test("startup names the ONE thing it is doing, and claims no other", async () => {
    // The screen the owner rejected said `cloud catalog fetching…` and `live rosters
    // 0/11 providers` before he had asked for either. Startup now probes credentials
    // and nothing else, and the screen says so.
    const d = await draw(
      <ModelPicker source={fakeSource({ hang: true })} onDone={() => {}} />,
      80,
      24,
      0
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("credentials");
      expect(all).toContain("checking");
      expect(all).not.toContain("cloud catalog");
      expect(all).not.toContain("live rosters");
    } finally {
      d.destroy();
    }
  });

  test("a provider still being listed says which provider, and for how long", async () => {
    // The per-provider in-flight state, which is now reachable because the fetch
    // happens in response to a keystroke.
    const d = await draw(
      <ModelPicker
        source={{
          ...fakeSource({ roster: [provider({ label: "Kimi / Moonshot" })] }),
          discoverRoster: () => new Promise<never>(() => {}),
        }}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["RETURN"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("Kimi / Moonshot");
      expect(all).toContain("deadline");
    } finally {
      d.destroy();
    }
  });
});
