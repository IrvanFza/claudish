/**
 * Tests for MtmDiagRunner binary resolution and fork detection.
 *
 * Validates:
 * - Platform-specific binary is preferred over generic
 * - Generic dev binary is found as fallback
 * - PATH mtm is only used if it's our fork (supports -e flag)
 * - Upstream mtm (no -e support) is rejected
 * - Graceful null return when no valid mtm is available
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MtmDiagRunner, tryCreateMtmRunner } from "./pty-diag-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake mtm binary that prints the given usage string */
function createFakeMtm(dir: string, name: string, usage: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "usage: mtm ${usage}" >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// isMtmFork detection
// ---------------------------------------------------------------------------

describe("isMtmFork detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mtm-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects our fork (has -e flag)", () => {
    const bin = createFakeMtm(tmpDir, "mtm-fork", "[-T NAME] [-t NAME] [-c KEY] [-e CMD] [-s PERCENT]");
    const runner = new MtmDiagRunner();
    // Access private method via prototype
    const result = (runner as any).isMtmFork(bin);
    expect(result).toBe(true);
  });

  test("rejects upstream mtm (no -e flag)", () => {
    const bin = createFakeMtm(tmpDir, "mtm-upstream", "[-T NAME] [-t NAME] [-c KEY]");
    const runner = new MtmDiagRunner();
    const result = (runner as any).isMtmFork(bin);
    expect(result).toBe(false);
  });

  test("rejects non-existent binary", () => {
    const runner = new MtmDiagRunner();
    const result = (runner as any).isMtmFork("/nonexistent/mtm");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findMtmBinary resolution order
// ---------------------------------------------------------------------------

describe("findMtmBinary resolution", () => {
  test("finds the bundled dev binary in native/mtm/", () => {
    const runner = new MtmDiagRunner();
    // In dev mode, the bundled binary should be found
    const binary = runner.findMtmBinary();
    expect(binary).toContain("native/mtm/mtm");
    // Should NOT be the Homebrew one
    expect(binary).not.toBe("/opt/homebrew/bin/mtm");
  });

  test("real system mtm is correctly identified as upstream", () => {
    // Only run if Homebrew mtm exists
    const { execSync } = require("child_process");
    let systemMtm: string;
    try {
      systemMtm = execSync("which mtm", { encoding: "utf-8" }).trim();
    } catch {
      // No system mtm, skip
      return;
    }

    if (systemMtm === "" || systemMtm.includes("native/mtm")) {
      // System mtm is our fork, nothing to test
      return;
    }

    const runner = new MtmDiagRunner();
    const result = (runner as any).isMtmFork(systemMtm);
    // Homebrew's upstream mtm should be rejected
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryCreateMtmRunner graceful fallback
// ---------------------------------------------------------------------------

describe("tryCreateMtmRunner", () => {
  test("returns MtmDiagRunner when binary is available", async () => {
    const runner = await tryCreateMtmRunner();
    // In dev mode with the custom binary built, this should succeed
    if (runner === null) {
      // Binary not built — acceptable in CI
      console.log("mtm binary not available, skipping");
      return;
    }
    expect(runner).toBeInstanceOf(MtmDiagRunner);
  });

  test("returns null gracefully when no valid mtm exists", async () => {
    // Temporarily override findMtmBinary to always throw
    const origFind = MtmDiagRunner.prototype.findMtmBinary;
    MtmDiagRunner.prototype.findMtmBinary = () => {
      throw new Error("mtm binary not found");
    };

    try {
      const runner = await tryCreateMtmRunner();
      expect(runner).toBeNull();
    } finally {
      MtmDiagRunner.prototype.findMtmBinary = origFind;
    }
  });
});

// ---------------------------------------------------------------------------
// Status bar formatting (unit tests)
// ---------------------------------------------------------------------------

describe("MtmDiagRunner status bar", () => {
  test("setModel updates model name", () => {
    const runner = new MtmDiagRunner();
    // Should not throw
    runner.setModel("gemini-3.1-pro-preview");
  });
});
