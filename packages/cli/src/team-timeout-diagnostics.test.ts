import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModels, setupSession } from "./team-orchestrator.js";

// Retries are enabled here because these tests spawn short-lived real subprocesses
// that can lose races under load. They are deliberately not used on expensive
// real-Claude-Code/real-model tests, where a retry costs minutes and starves neighbouring tests.

const STDERR_BEFORE_TIMEOUT = "diagnostic written before hanging";
const STDOUT_BEFORE_TIMEOUT = "partial stdout written before hanging";

let sessionDir: string;
let fakeClaudishDir: string;
let originalPath: string | undefined;

function makeHangingFakeClaudish(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claudish-timeout-"));
  const script = join(dir, "claudish");
  writeFileSync(
    script,
    `#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(STDOUT_BEFORE_TIMEOUT)});
process.stderr.write(${JSON.stringify(STDERR_BEFORE_TIMEOUT)});
setInterval(() => {}, 1_000);
`,
    "utf-8"
  );
  chmodSync(script, 0o755);
  return dir;
}

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "team-timeout-diagnostics-"));
  fakeClaudishDir = makeHangingFakeClaudish();
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeClaudishDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of [sessionDir, fakeClaudishDir]) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runModels timeout diagnostics", () => {
  it("persists stderr and reports the stdout bytes captured before timeout", async () => {
    setupSession(sessionDir, ["hanging-model"], "Analyze this input");

    const status = await runModels(sessionDir, { timeout: 1 });
    const model = Object.values(status.models)[0];

    expect(model.state).toBe("TIMEOUT");
    expect(model.error).toBeDefined();
    expect(model.error?.reason).toBe("timeout");
    expect(model.error?.command).toBe(
      "claudish --model hanging-model -y --stdin --quiet"
    );
    expect(model.error?.stderrSnippet).toContain(STDERR_BEFORE_TIMEOUT);
    expect(model.outputSize).toBe(Buffer.byteLength(STDOUT_BEFORE_TIMEOUT));

    const errorLogPath = model.error?.errorLogPath;
    expect(errorLogPath).toBeDefined();
    expect(existsSync(errorLogPath!)).toBe(true);
    expect(readFileSync(errorLogPath!, "utf-8")).toContain(STDERR_BEFORE_TIMEOUT);
  }, { retry: 2 });
});
