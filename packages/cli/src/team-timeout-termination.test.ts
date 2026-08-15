import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModels, setupSession } from "./team-orchestrator.js";

// Retries are enabled here because these tests spawn short-lived real subprocesses
// that can lose races under load. They are deliberately not used on expensive
// real-Claude-Code/real-model tests, where a retry costs minutes and starves neighbouring tests.

const PROGRESS_ANSWER = "The child completed its full answer while grace was active.\n";
const SHUTDOWN_ANSWER = "The child flushed this complete answer during shutdown.\n";

let sessionDir: string;
let fakeClaudishDir: string;
let originalPath: string | undefined;
let originalClaudishBin: string | undefined;
let grandchildPid: number | undefined;
let grandchildPidPath: string | undefined;

function writeShim(source: string): void {
  const script = join(fakeClaudishDir, "claudish");
  writeFileSync(script, `#!/usr/bin/env bun\n${source}\n`, "utf-8");
  chmodSync(script, 0o755);
}

function statsWriterSource(): string {
  return `
const { writeFileSync } = require("node:fs");
const tokenFile = process.env.CLAUDISH_TOKEN_FILE;
if (!tokenFile) throw new Error("CLAUDISH_TOKEN_FILE was not set");
const started_at = Date.now();
let output_tokens = 0;
const writeStats = () => {
  output_tokens += 1;
  writeFileSync(tokenFile, JSON.stringify({
    input_tokens: 1,
    output_tokens,
    total_tokens: 1 + output_tokens,
    total_cost: 0,
    updated_at: Date.now(),
    started_at,
    provider_name: "test-provider",
    model_name: "some-model",
  }));
};
`;
}

function writeProgressingShim(answer?: string): void {
  const finish =
    answer === undefined
      ? ""
      : `
setTimeout(() => {
  clearInterval(statsTimer);
  process.stdout.write(${JSON.stringify(answer)}, () => process.exit(0));
}, 4_000);
`;

  writeShim(`${statsWriterSource()}
writeStats();
const statsTimer = setInterval(writeStats, 250);
${finish}`);
}

function writeStalledShim(): void {
  writeShim(`${statsWriterSource()}
writeStats();
setInterval(() => {}, 1_000);`);
}

function modelStatus(status: Awaited<ReturnType<typeof runModels>>) {
  return status.models["01"];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "team-timeout-termination-"));
  fakeClaudishDir = mkdtempSync(join(tmpdir(), "fake-claudish-termination-"));
  originalPath = process.env.PATH;
  originalClaudishBin = process.env.CLAUDISH_BIN;
  // CLAUDISH_BIN outranks PATH in resolveClaudishSpawn, so leaving it set would defeat the fake shim.
  delete process.env.CLAUDISH_BIN;
  process.env.PATH = `${fakeClaudishDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  if (grandchildPid === undefined && grandchildPidPath !== undefined) {
    try {
      const pid = Number.parseInt(readFileSync(grandchildPidPath, "utf-8").trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) grandchildPid = pid;
    } catch {
      // The grandchild never reached its PID write.
    }
  }
  if (grandchildPid !== undefined) {
    try {
      process.kill(grandchildPid, 0);
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // Already dead.
    }
    grandchildPid = undefined;
  }
  grandchildPidPath = undefined;

  process.env.PATH = originalPath;
  if (originalClaudishBin === undefined) {
    delete process.env.CLAUDISH_BIN;
  } else {
    process.env.CLAUDISH_BIN = originalClaudishBin;
  }
  for (const dir of [sessionDir, fakeClaudishDir]) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runModels timeout termination", () => {
  it(
    "progress earns grace",
    async () => {
      writeProgressingShim(PROGRESS_ANSWER);
      setupSession(sessionDir, ["some-model"], "prompt");

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("COMPLETED");
      expect(modelStatus(status).outputSize).toBe(Buffer.byteLength(PROGRESS_ANSWER));
      expect(readFileSync(join(sessionDir, "response-01.md"), "utf-8")).toBe(PROGRESS_ANSWER);
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "no stats file earns no grace",
    async () => {
      writeShim("setInterval(() => {}, 1_000);");
      setupSession(sessionDir, ["some-model"], "prompt");

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("TIMEOUT");
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "a stalled child is terminated",
    async () => {
      writeStalledShim();
      setupSession(sessionDir, ["some-model"], "prompt");

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("TIMEOUT");
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "graceExtension false is a hard ceiling",
    async () => {
      writeProgressingShim(PROGRESS_ANSWER);
      setupSession(sessionDir, ["some-model"], "prompt");

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: false,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("TIMEOUT");
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "grace is capped",
    async () => {
      writeProgressingShim();
      setupSession(sessionDir, ["some-model"], "prompt");
      const startedAt = Date.now();

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 3,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("TIMEOUT");
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "an answer flushed during shutdown is recovered",
    async () => {
      writeShim(`
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(${JSON.stringify(SHUTDOWN_ANSWER)}, () => process.exit(0));
});
setInterval(() => {}, 1_000);
`);
      setupSession(sessionDir, ["some-model"], "prompt");

      const status = await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      expect(modelStatus(status).state).toBe("COMPLETED");
      expect(modelStatus(status).outputSize).toBe(Buffer.byteLength(SHUTDOWN_ANSWER));
      expect(readFileSync(join(sessionDir, "errors", "01.log"), "utf-8")).toContain("RECOVERED");
    },
    { retry: 2, timeout: 15_000 }
  );

  it(
    "nothing is written after runModels returns",
    async () => {
      const pidPath = join(sessionDir, "grandchild.pid");
      grandchildPidPath = pidPath;
      const grandchild = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`;
      writeShim(`
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });
setInterval(() => {}, 1_000);
`);
      setupSession(sessionDir, ["some-model"], "prompt");

      await runModels(sessionDir, {
        timeout: 1,
        stallSeconds: 1,
        maxGraceSeconds: 20,
        graceExtension: true,
        spawnPlanner: async () => ({ pinned: new Map() }),
      });

      const pidFileDeadline = Date.now() + 2_000;
      while (!existsSync(pidPath) && Date.now() < pidFileDeadline) {
        await wait(25);
      }
      if (!existsSync(pidPath)) {
        throw new Error(
          `Grandchild PID file was not written within 2s: ${pidPath}. ` +
            "The leak test did not exercise a grandchild."
        );
      }

      grandchildPid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isSafeInteger(grandchildPid) || grandchildPid <= 0) {
        throw new Error(`Grandchild wrote an invalid PID: ${grandchildPid}`);
      }

      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }

      expect(alive).toBe(false);
    },
    { retry: 2, timeout: 25_000 }
  );
});
