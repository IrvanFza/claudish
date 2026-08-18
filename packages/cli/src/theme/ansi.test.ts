import { afterEach, describe, expect, it } from "bun:test";
import { bgHex, cliAnsi, fgHex } from "./ansi.js";
import { resetThemeModeForTests, setThemeMode } from "./theme-mode.js";

afterEach(() => {
  resetThemeModeForTests();
});

function withNoColor(value: string | undefined, assertion: () => void): void {
  const previous = process.env.NO_COLOR;
  try {
    if (value === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = value;
    assertion();
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
}

describe("cliAnsi", () => {
  it("returns the classic escapes while the theme mode is unknown", () => {
    resetThemeModeForTests();

    withNoColor(undefined, () => {
      const ansi = cliAnsi();
      expect(ansi.GREEN).toBe("\x1b[32m");
      expect(ansi.GRAY).toBe("\x1b[90m");
      expect(ansi.STRONG).toBe("\x1b[37m");
      expect(ansi.RESET).toBe("\x1b[0m");
    });
  });

  it("returns the deep truecolor light-theme escapes", () => {
    setThemeMode("light");

    withNoColor(undefined, () => {
      const ansi = cliAnsi();
      expect(ansi.GREEN).toBe(fgHex("#15803d"));
      expect(ansi.STRONG).toBe(fgHex("#111827"));
      expect(ansi.RESET).toBe("\x1b[0m");
    });
  });

  it("honors NO_COLOR for every field", () => {
    setThemeMode("light");

    withNoColor("1", () => {
      for (const ansiCode of Object.values(cliAnsi())) {
        expect(ansiCode).toBe("");
      }
    });
  });
});

describe("truecolor helpers", () => {
  it("encodes foreground and background RGB escapes", () => {
    expect(fgHex("#ff0080")).toBe("\x1b[38;2;255;0;128m");
    expect(bgHex("#0e7490")).toBe("\x1b[48;2;14;116;144m");
  });
});
