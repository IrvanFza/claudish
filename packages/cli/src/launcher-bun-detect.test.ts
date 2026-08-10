import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

type LauncherHelpers = {
  findBun: (platform?: string, env?: Record<string, string | undefined>) => string | null;
  lookupCommand: (platform: string) => string;
  bunCandidates: (platform: string, env: Record<string, string | undefined>) => string[];
  installHint: (platform: string) => string;
};

const require = createRequire(import.meta.url);
const { findBun, lookupCommand, bunCandidates, installHint } =
  require("../bin/claudish.cjs") as LauncherHelpers;

describe("npm launcher Bun detection helpers", () => {
  test("requiring the launcher is side-effect free and exposes its helpers", () => {
    expect(findBun).toBeFunction();
    expect(lookupCommand).toBeFunction();
    expect(bunCandidates).toBeFunction();
    expect(installHint).toBeFunction();
  });

  test("lookupCommand uses the platform's command lookup tool", () => {
    // `which` does not exist in cmd or PowerShell; using it was the original
    // bug that made Windows fall through to POSIX-only Bun paths.
    expect(lookupCommand("win32")).toBe("where bun");
    expect(lookupCommand("darwin")).toBe("which bun");
    expect(lookupCommand("linux")).toBe("which bun");
  });

  test("bunCandidates returns native Windows executable paths", () => {
    const candidates = bunCandidates("win32", {
      USERPROFILE: "C:\\Users\\jack",
      LOCALAPPDATA: "C:\\Users\\jack\\AppData\\Local",
    });

    expect(candidates[0]).toBe("C:\\Users\\jack\\.bun\\bin\\bun.exe");
    for (const candidate of candidates) {
      expect(candidate.endsWith("bun.exe")).toBe(true);
      expect(candidate).toContain("\\");
      expect(candidate).not.toContain("/");
    }
  });

  test("bunCandidates does not interpolate missing Windows home variables", () => {
    // HOME is normally unset on Windows, so direct interpolation used to
    // produce the literal path `undefined\\.bun\\bin\\bun.exe`.
    const candidates = bunCandidates("win32", {});

    for (const candidate of candidates) {
      expect(candidate).not.toContain("undefined");
    }
  });

  test("bunCandidates preserves POSIX paths on macOS", () => {
    const candidates = bunCandidates("darwin", { HOME: "/Users/jack" });

    expect(candidates[0]).toBe("/Users/jack/.bun/bin/bun");
    expect(candidates).toContain("/usr/local/bin/bun");
    expect(candidates).toContain("/opt/homebrew/bin/bun");
    for (const candidate of candidates) {
      expect(candidate).not.toContain("\\");
      expect(candidate).not.toContain(".exe");
    }
  });

  test("installHint uses a command suitable for each platform", () => {
    const windowsHint = installHint("win32");
    const macHint = installHint("darwin");

    // Showing `curl ... | bash` in cmd would give Windows users a second dead
    // end immediately after launcher detection failed.
    expect(windowsHint).toContain("powershell");
    expect(windowsHint).not.toContain("| bash");
    expect(macHint).toContain("curl");
    expect(macHint).toContain("bun.sh/install");
  });
});
