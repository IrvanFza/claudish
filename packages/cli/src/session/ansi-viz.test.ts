import { describe, expect, test } from "bun:test";
import { displayWidth } from "../tui/viz/text.js";
import {
  RESET,
  badge,
  clipStyled,
  compact,
  duration,
  meter,
  padVisible,
  paint,
  stackedBar,
  stripAnsi,
  usd,
  visibleWidth,
} from "./ansi-viz.js";

const columns = (s: string): number => displayWidth(stripAnsi(s));

describe("meter", () => {
  test("always paints exactly the requested number of display columns", () => {
    for (const [pct, width] of [
      [0, 10],
      [50, 10],
      [100, 10],
      [150, 10],
      [-20, 10],
      [50, 1],
    ] as const) {
      expect(columns(meter(pct, width))).toBe(width);
    }
  });

  test("keeps absent data visually distinct from a healthy zero", () => {
    const dead = meter(Number.NaN, 8);
    const idle = meter(0, 8);

    expect(stripAnsi(dead)).toBe("╌".repeat(8));
    expect(dead).not.toBe(idle);
    expect(columns(dead)).toBe(8);
  });

  test("uses a real per-cell gradient for a full meter", () => {
    const full = meter(100, 40);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the invariant is encoded in ANSI SGR bytes
    const truecolorForeground = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;
    const foregrounds = new Set([...full.matchAll(truecolorForeground)].map((m) => m[0]));

    expect(columns(full)).toBe(40);
    expect(foregrounds.size).toBeGreaterThanOrEqual(12);
  });
});

describe("stackedBar and badge", () => {
  test("stacked bars keep their exact width for every distribution shape", () => {
    const cases = [
      {
        width: 12,
        segments: [
          { value: 6, color: "#ff0000" },
          { value: 4, color: "#00ff00" },
          { value: 2, color: "#0000ff" },
        ],
      },
      {
        width: 9,
        segments: [
          { value: 0, color: "#ff0000" },
          { value: 0, color: "#00ff00" },
        ],
      },
      {
        width: 3,
        segments: [
          { value: 1, color: "#ff0000" },
          { value: 1, color: "#00ff00" },
          { value: 1, color: "#0000ff" },
          { value: 1, color: "#ffff00" },
          { value: 1, color: "#00ffff" },
        ],
      },
      { width: 7, segments: [{ value: 42, color: "#ff00ff" }] },
    ];

    for (const { segments, width } of cases) {
      expect(columns(stackedBar(segments, width))).toBe(width);
    }
    expect(stripAnsi(stackedBar(cases[1]!.segments, cases[1]!.width))).toBe("░".repeat(9));
  });

  test("a badge adds exactly one visible padding cell on each side", () => {
    const label = "日本";
    const chip = badge(label, "#336699");

    expect(chip).toContain(label);
    expect(visibleWidth(chip)).toBe(displayWidth(label) + 2);
  });
});

describe("styled display-cell helpers", () => {
  test("clipStyled preserves SGR, resets clipped output, and never exceeds its width", () => {
    const clipped = clipStyled(paint("abcdefgh", "#123456", true), 4);

    expect(visibleWidth(clipped)).toBeLessThanOrEqual(4);
    expect(clipped).toContain("\x1b[");
    expect(clipped.endsWith(RESET)).toBe(true);
  });

  test("clipStyled never splits a wide glyph", () => {
    const clipped = clipStyled(paint("日本語", "#123456"), 3);

    expect(stripAnsi(clipped)).toBe("日");
    expect(visibleWidth(clipped)).toBe(2);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(3);
  });

  test("clipStyled returns an already-fitting string unchanged", () => {
    const fitting = paint("ok", "#123456");
    expect(clipStyled(fitting, 2)).toBe(fitting);
  });

  test("padVisible is exact when padding short input and clipping long input", () => {
    const short = padVisible(paint("tool", "#123456"), 10);
    const long = padVisible("mcp__some-really-long-server-name__a_very_long_tool_name", 10);

    expect(visibleWidth(short)).toBe(10);
    expect(visibleWidth(long)).toBe(10);
    expect(stripAnsi(short)).toBe("tool      ");
  });

  test("visibleWidth ignores ANSI and measures wide Unicode by terminal cells", () => {
    const cjk = "日本語";
    const emoji = "👨‍👩‍👧";

    expect(visibleWidth(paint(cjk, "#123456"))).toBe(6);
    expect(visibleWidth(cjk)).not.toBe(cjk.length);
    expect(visibleWidth(emoji)).toBe(2);
    expect(visibleWidth(emoji)).not.toBe(emoji.length);
  });
});

describe("formatters", () => {
  test("compact formats thousands and millions", () => {
    expect(compact(999)).toBe("999");
    expect(compact(1_000)).toBe("1.0K");
    expect(compact(1_500_000)).toBe("1.5M");
  });

  test("duration formats absent, second, minute, and hour ranges", () => {
    expect(duration(0)).toBe("—");
    expect(duration(-1)).toBe("—");
    expect(duration(45_000)).toBe("45s");
    expect(duration(754_000)).toBe("12m 34s");
    expect(duration(3_720_000)).toBe("1h 02m");
  });

  test("usd chooses precision by magnitude", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.0004)).toBe("$0.0004");
    expect(usd(0.5)).toBe("$0.500");
    expect(usd(12.5)).toBe("$12.50");
  });
});
