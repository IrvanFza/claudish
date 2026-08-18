import { afterEach, describe, expect, it } from "bun:test";
import {
  classifyOscBackground,
  detectAndSetThemeModeSync,
  getThemeMode,
  onThemeModeChange,
  relativeLuminance,
  resetThemeModeForTests,
  setThemeMode,
  themeModeFromColorFgBg,
  themeModeOverride,
} from "./theme-mode.js";

afterEach(() => {
  resetThemeModeForTests();
});

describe("themeModeOverride", () => {
  it("accepts light and dark case-insensitively", () => {
    expect(themeModeOverride({ CLAUDISH_THEME: "light" })).toBe("light");
    expect(themeModeOverride({ CLAUDISH_THEME: "dark" })).toBe("dark");
    expect(themeModeOverride({ CLAUDISH_THEME: "LIGHT" })).toBe("light");
  });

  it("rejects unsupported and missing values", () => {
    expect(themeModeOverride({ CLAUDISH_THEME: "garbage" })).toBeNull();
    expect(themeModeOverride({})).toBeNull();
  });
});

describe("themeModeFromColorFgBg", () => {
  it("classifies the final ANSI background slot", () => {
    expect(themeModeFromColorFgBg({ COLORFGBG: "15;0" })).toBe("dark");
    expect(themeModeFromColorFgBg({ COLORFGBG: "0;15" })).toBe("light");
    expect(themeModeFromColorFgBg({ COLORFGBG: "12;default;7" })).toBe("light");
    expect(themeModeFromColorFgBg({ COLORFGBG: "1;2" })).toBe("dark");
  });

  it("returns null when the background is missing or unclassifiable", () => {
    expect(themeModeFromColorFgBg({ COLORFGBG: "" })).toBeNull();
    expect(themeModeFromColorFgBg({})).toBeNull();
    expect(themeModeFromColorFgBg({ COLORFGBG: "abc;def" })).toBeNull();

    for (let slot = 9; slot <= 14; slot += 1) {
      expect(themeModeFromColorFgBg({ COLORFGBG: `0;${slot}` })).toBeNull();
    }
  });
});

describe("classifyOscBackground", () => {
  it("parses bright and dark OSC 11 replies with either terminator", () => {
    expect(classifyOscBackground("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
    expect(classifyOscBackground("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe("dark");
    expect(classifyOscBackground("]11;rgb:ff/ff/ff\x07")).toBe("light");
  });

  it("honors the midpoint boundary", () => {
    expect(classifyOscBackground("]11;rgb:8080/8080/8080\x07")).toBe("light");
    expect(classifyOscBackground("]11;rgb:7f7f/7f7f/7f7f\x07")).toBe("dark");
  });

  it("rejects malformed replies", () => {
    expect(classifyOscBackground("\x1b]11;rgb:not/a/color\x07")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("returns the WCAG endpoints for white and black", () => {
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1);
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0);
  });
});

describe("theme mode listeners", () => {
  it("receives the current mode immediately and every published change", () => {
    const modes: Array<"light" | "dark" | null> = [];
    setThemeMode("dark");

    onThemeModeChange((mode) => modes.push(mode));
    expect(modes).toEqual(["dark"]);

    setThemeMode("light");
    expect(modes).toEqual(["dark", "light"]);

    resetThemeModeForTests();
    expect(modes).toEqual(["dark", "light", null]);
  });
});

describe("detectAndSetThemeModeSync", () => {
  it("publishes and returns a CLAUDISH_THEME override", () => {
    const previous = process.env.CLAUDISH_THEME;
    try {
      process.env.CLAUDISH_THEME = "LIGHT";
      expect(detectAndSetThemeModeSync()).toBe("light");
      expect(getThemeMode()).toBe("light");
    } finally {
      if (previous === undefined) delete process.env.CLAUDISH_THEME;
      else process.env.CLAUDISH_THEME = previous;
    }
  });
});
