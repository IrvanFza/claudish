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
 * THE DATA SOURCE IS A PARAMETER, NEVER `mock.module()`: mocking shared
 * infrastructure bleeds across Bun's module registry and breaks sibling e2e files.
 */
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import type { ModelInfo, PickerDiscoveryOutcome, PreloadedRoster } from "../model-selector.js";
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
  /** Per-provider served lists; falls back to `served`. */
  byProvider?: Record<string, ModelInfo[]>;
  served?: ModelInfo[];
  /** Per-provider LIVE roster outcomes, for the cross-provider merge. */
  liveRosters?: Record<string, PreloadedRoster>;
  /** `modelId` → prose sentence, as the description index answers. */
  descriptions?: Record<string, string>;
  /** Never settles — the in-flight states. */
  hang?: boolean;
}

function fakeSource(opts: FakeOpts = {}): PickerDataSource {
  const roster = opts.roster ?? [provider()];
  const never = new Promise<never>(() => {});
  const descriptions = opts.descriptions ?? {};
  return {
    providerRoster: () => roster,
    notEnabledLocalProviders: () => [],
    displayName: (p) => roster.find((r) => r.value === p)?.label ?? p,
    async *probeCredentials(names) {
      if (opts.hang) await never;
      for (const n of names) yield [n, opts.ready?.[n] ?? true] as [string, boolean];
    },
    ensureCatalog: (): Promise<void> => (opts.hang ? never : Promise.resolve()),
    servedModels: (p) => opts.byProvider?.[p] ?? opts.served ?? [model()],
    discoverRoster: (): Promise<PickerDiscoveryOutcome> =>
      opts.hang
        ? never
        : Promise.resolve(
            opts.outcome ?? { kind: "rows", rows: [model()], servedCount: 1, chatCount: 1 }
          ),
    rosterRows: (p): Promise<PreloadedRoster> =>
      opts.hang
        ? never
        : Promise.resolve(
            opts.liveRosters?.[p] ?? { kind: "empty", reason: "unsupported" as const }
          ),
    descriptions: (): Promise<DescriptionIndex> =>
      opts.hang
        ? never
        : Promise.resolve({
            get: (id: string) => descriptions[id],
            size: Object.keys(descriptions).length,
          }),
  };
}

interface Drawn {
  text: string[];
  frame: CapturedFrame;
  press: (keys: string[]) => Promise<void>;
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
    recapture,
    destroy: () => renderer.destroy(),
  };
}

const joined = (text: string[]): string => text.join("\n");
const bgs = (f: CapturedFrame): Set<string> =>
  new Set(f.lines.flatMap((l) => l.spans.map((s) => s.bg.toInts().slice(0, 3).join())));
const rgb = (hex: string): string =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join();
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
    // keys drove. One list, one `▶`.
    const roster = ["openrouter", "kimi", "google"].map((v) =>
      provider({ value: v, label: v, shortcut: `${v}@`, hasDiscovery: false })
    );
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          served: [model({ id: "a" }), model({ id: "b" })],
        })}
        onDone={() => {}}
      />
    );
    try {
      expect(joined(d.text).split("▶").length - 1).toBe(1);
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
          served: [
            model({ id: "a", contextLength: 1_000_000, context: "1M" }),
            model({ id: "b", contextLength: 8_000, context: "8K" }),
          ],
        })}
        onDone={() => {}}
      />
    );
    try {
      const rows = d.text.filter((l) => /\ba\b|\bb\b/.test(l));
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
        const over = d.text.filter((l) => l.length > width);
        expect({ width, over }).toEqual({ width, over: [] });
      } finally {
        d.destroy();
      }
    }
  });

  test("the key hints are present and unclipped at 80×24", async () => {
    const d = await draw(<ModelPicker source={fakeSource()} onDone={() => {}} />);
    try {
      // The hints row is the last PAINTED row above the bottom border.
      const footer = painted(d.text).at(-2) ?? "";
      for (const hint of ["move", "select", "providers", "custom", "cancel"]) {
        expect(footer).toContain(hint);
      }
    } finally {
      d.destroy();
    }
  });
});

// ── one flat list, provider as a COLUMN ──────────────────────────────────────────

describe("the flat cross-provider list", () => {
  const roster = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: false }),
  ];

  test("merges every credentialled provider and NAMES the provider on each row", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" })],
            "kimi-coding": [model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).toContain("kimi-k3");
      // THE COLUMN IS A NAME, NOT A SHORTCUT. It printed `or@` / `kc@` and the
      // owner's question on a live run was "what is 'or' means" — a routing
      // shortcut only reads as information to someone who already knows it.
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
      const all = joined(d.text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
      // The absence is EXPLAINED, in the title, rather than silent.
      expect(all).toContain("1/2 providers");
    } finally {
      d.destroy();
    }
  });

  test("A LIVE ROSTER IS MERGED INTO THE FLAT LIST — the `gemini` bug, as an assertion", async () => {
    // The owner filtered `gemini` on a live run and got eleven rows, every one of
    // them `or@`, while Antigravity was serving gemini models on a FLAT-RATE
    // subscription — invisible, because the flat list was the cloud catalog alone
    // and Antigravity has no catalog entries at all. The subscription route is the
    // one most worth finding, so its absence was the worst possible absence.
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
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: withDiscovery,
          byProvider: {
            openrouter: [model({ id: "gemini-3.8-flash" })],
            // No catalog entries whatsoever — the real Antigravity's situation.
            antigravity: [],
          },
          liveRosters: {
            antigravity: {
              kind: "rows",
              rows: [model({ id: "gemini-3.8-flash-tiered", context: "1M" })],
            },
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["g", "e", "m", "i", "n", "i"]);
      const all = joined(d.recapture().text);
      // BOTH routes, from two different sources, in one filtered list.
      expect(all).toContain("gemini-3.8-flash");
      expect(all).toContain("gemini-3.8-flash-tiered");
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Antigravity");
    } finally {
      d.destroy();
    }
  });

  test("one model on two providers is TWO rows, and the title counts both honestly", async () => {
    // The owner's rule for the flat list, and the count that goes with it: the
    // rows are ROUTES, so labelling their number "models" would be off by exactly
    // the amount that makes the list useful.
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
      const all = joined(d.text);
      expect(all).toContain("1 models · 2 routes");
      // Two rows, one per provider, each naming its own provider.
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Kimi Coding");
    } finally {
      d.destroy();
    }
  });

  test("a provider whose roster FAILS is counted, not silently absent", async () => {
    // The aggregate shape: once the list queries every ready provider at once, a
    // banner per failure would push the list off the screen and a banner for the
    // first one would speak for the rest.
    const withDiscovery = [
      provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
      provider({ value: "devin", label: "Devin", shortcut: "dv@", hasDiscovery: true }),
    ];
    const failures: string[] = [];
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster: withDiscovery,
          byProvider: { openrouter: [model({ id: "glm-5.3-flash" })], devin: [] },
          liveRosters: {
            devin: {
              kind: "failed",
              failure: { kind: "unreachable", provider: "devin", detail: "timeout" },
              notice: ["\n⚠ Devin could not list its models: timeout\n"],
            },
          },
        })}
        onDone={() => {}}
        onDiscoveryFailure={(p) => failures.push(p)}
      />
    );
    try {
      expect(joined(d.recapture().text)).toContain("could not be listed");
      // The full diagnostic still reaches the ONE post-teardown stderr write.
      expect(failures).toEqual(["devin"]);
    } finally {
      d.destroy();
    }
  });

  test("typing filters immediately — there is no search mode to enter", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" })],
            "kimi-coding": [model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["g", "l", "m"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
    } finally {
      d.destroy();
    }
  });

  test("`/` makes the three letter commands typeable — `phi3` is a real model", async () => {
    // The one collision filter-first creates: `p` opens the provider dialog, so the
    // first keystroke of `phi3` would navigate instead of filter. `/` is the escape
    // hatch, and without a test it is the kind of thing that quietly stops working.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          byProvider: {
            openrouter: [model({ id: "phi3" }), model({ id: "kimi-k3" })],
            "kimi-coding": [],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      // Bare `p` NAVIGATES — that is the collision, asserted so the escape hatch has
      // something to be an escape from.
      await d.press(["p"]);
      expect(joined(d.recapture().text)).toContain("have credentials");
      d.destroy();
    } finally {
      /* destroyed above; the second half needs a fresh tree */
    }
    const e = await draw(
      <ModelPicker
        source={fakeSource({
          roster,
          byProvider: {
            openrouter: [model({ id: "phi3" }), model({ id: "kimi-k3" })],
            "kimi-coding": [],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await e.press(["/"]);
      await e.press(["p"]);
      await e.press(["h"]);
      const all = joined(e.recapture().text);
      expect(all).toContain("phi3");
      expect(all).not.toContain("kimi-k3");
    } finally {
      e.destroy();
    }
  });

  test("Enter returns the provider-scoped spec, never a bare model id", async () => {
    // A bare Claude-shaped name reaching `route()` degrades to OpenRouter, so the
    // picker must never emit one.
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster, byProvider: { openrouter: [model({ id: "gpt-6" })] } })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
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

  test("Escape with an empty filter CANCELS by returning null — never `process.exit`", async () => {
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

  /** Reach the scoped view: `p` opens the provider dialog, Enter scopes to row one. */
  async function scoped(outcome: PickerDiscoveryOutcome, width = 80, height = 24): Promise<Drawn> {
    const d = await draw(
      <ModelPicker source={fakeSource({ outcome })} onDone={() => {}} />,
      width,
      height
    );
    // TWO presses, not one batch: `useKeyboard` reads `view` from the render that
    // subscribed, so a batched `p`+Enter is handled entirely by the MODEL view's
    // closure and the provider dialog never sees the Enter. A real keyboard cannot
    // do that; `pressKeys` with no delay can.
    await d.press(["p"]);
    await d.press(["RETURN"]);
    await new Promise((r) => setTimeout(r, 40));
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

// ── the provider dialog, which replaced the rail ─────────────────────────────────

describe("the provider dialog", () => {
  test("`p` lists every provider at FULL WIDTH, credentials and counts included", async () => {
    // The rail truncated two different providers to the same `opencod…`. A dialog at
    // 76 columns cannot.
    const roster = [
      provider({
        value: "opencode-zen",
        label: "OpenCode Zen",
        shortcut: "zen@",
        hasDiscovery: false,
      }),
      provider({
        value: "opencode-zen-go",
        label: "OpenCode Zen Go",
        shortcut: "zengo@",
        hasDiscovery: false,
      }),
    ];
    const d = await draw(
      <ModelPicker
        source={fakeSource({ roster, ready: { "opencode-zen-go": false } })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["p"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("OpenCode Zen");
      expect(all).toContain("OpenCode Zen Go");
      // The absence is explained with the exact variable to inspect.
      expect(all).toContain("MOONSHOT_API_KEY");
      expect(all).toContain("1 of 2 have credentials");
    } finally {
      d.destroy();
    }
  });
});

// ── the loading dialog ───────────────────────────────────────────────────────────

describe("the loading dialog", () => {
  test("names what it is waiting for rather than spinning", async () => {
    const d = await draw(
      <ModelPicker source={fakeSource({ hang: true })} onDone={() => {}} />,
      80,
      24,
      0
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("credentials");
      expect(all).toContain("cloud catalog");
      expect(all).toContain("models appear as soon as they are ready");
    } finally {
      d.destroy();
    }
  });
});
