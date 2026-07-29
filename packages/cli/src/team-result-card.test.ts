import { describe, expect, it } from "bun:test";
import { formatTeamResult } from "./mcp-server.js";
import type {
  FailureReason,
  ModelError,
  ModelState,
  ModelStatus,
  TeamStatus,
} from "./team-orchestrator.js";

const SESSION_PATH = "/tmp/team-result-card";
const STARTED_AT = "2026-07-30T00:00:00.000Z";
const COMPLETED_AT = "2026-07-30T00:01:00.000Z";

function modelStatus(
  state: ModelState,
  options: {
    id?: string;
    outputSize?: number;
    reason?: FailureReason;
    stderrSnippet?: string;
    stdoutSnippet?: string;
    withError?: boolean;
  } = {}
): ModelStatus {
  const id = options.id ?? "01";
  const isCompleted = state === "COMPLETED";
  const isFailure = state === "FAILED" || state === "TIMEOUT" || state === "EMPTY";
  const withError = options.withError ?? isFailure;

  let error: ModelError | undefined;
  if (withError) {
    const reason = options.reason ?? "nonzero_exit";
    error = {
      model: id,
      command: `claudish --model test-${id}`,
      reason,
      detail: `diagnostic detail for ${reason}`,
      stderrSnippet: options.stderrSnippet,
      stdoutSnippet: options.stdoutSnippet,
      errorLogPath: `${SESSION_PATH}/errors/${id}.log`,
      workDir: `${SESSION_PATH}/work/${id}`,
    };
  }

  return {
    state,
    exitCode: isCompleted ? 0 : state === "TIMEOUT" ? null : 1,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    outputSize: options.outputSize ?? (isCompleted ? 1024 : 0),
    error,
  };
}

function status(models: Record<string, ModelStatus>): TeamStatus {
  return {
    startedAt: STARTED_AT,
    models,
  };
}

function sixModelStatus(snippetLength: number): TeamStatus {
  const stderrSnippet = "E".repeat(snippetLength);
  const stdoutSnippet = "O".repeat(snippetLength);

  return status({
    "01": modelStatus("COMPLETED", { id: "01", outputSize: 1200 }),
    "02": modelStatus("FAILED", {
      id: "02",
      reason: "nonzero_exit",
      stderrSnippet,
      stdoutSnippet,
    }),
    "03": modelStatus("COMPLETED", { id: "03", outputSize: 2300 }),
    "04": modelStatus("TIMEOUT", {
      id: "04",
      reason: "timeout",
      stderrSnippet,
      stdoutSnippet,
    }),
    "05": modelStatus("COMPLETED", { id: "05", outputSize: 3400 }),
    "06": modelStatus("EMPTY", {
      id: "06",
      reason: "empty_output",
      stderrSnippet,
      stdoutSnippet,
    }),
  });
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("formatTeamResult", () => {
  it("never emits stderr or stdout snippets", () => {
    const stderrMarker = "UNIQUE-STDERR-MARKER-7F3A";
    const stdoutMarker = "UNIQUE-STDOUT-MARKER-91BC";
    const output = formatTeamResult(
      status({
        "01": modelStatus("FAILED", {
          id: "01",
          reason: "nonzero_exit",
          stderrSnippet: `before ${stderrMarker} after`,
          stdoutSnippet: `before ${stdoutMarker} after`,
        }),
      }),
      SESSION_PATH
    );

    expect(occurrences(output, stderrMarker)).toBe(0);
    expect(occurrences(output, stdoutMarker)).toBe(0);
    expect(output).not.toContain("stderrSnippet");
    expect(output).not.toContain("stdoutSnippet");
  });

  it("stays under 2,500 bytes for six models and three capped failures", () => {
    const output = formatTeamResult(sixModelStatus(2000), SESSION_PATH);

    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(2500);
  });

  it("is byte-identical regardless of snippet size", () => {
    const shortSnippetOutput = formatTeamResult(sixModelStatus(10), SESSION_PATH);
    const cappedSnippetOutput = formatTeamResult(sixModelStatus(2000), SESSION_PATH);

    expect(cappedSnippetOutput).toBe(shortSnippetOutput);
    expect(Buffer.from(cappedSnippetOutput)).toEqual(Buffer.from(shortSnippetOutput));
  });

  it("is self-delimiting", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
      }),
      SESSION_PATH
    );

    expect(output.startsWith("<<<TEAM_RESULT")).toBe(true);
    expect(output.endsWith("<<<END_TEAM_RESULT>>>")).toBe(true);
  });

  it("counts EMPTY, FAILED, and TIMEOUT as failures", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
        "02": modelStatus("FAILED", { id: "02", reason: "nonzero_exit" }),
        "03": modelStatus("TIMEOUT", { id: "03", reason: "timeout" }),
        "04": modelStatus("EMPTY", { id: "04", reason: "empty_output" }),
      }),
      SESSION_PATH
    );
    const failures = output.split("failures:\n")[1]?.split("\nactions:")[0] ?? "";

    expect(output).toContain("status: partial — 1/4 succeeded");
    expect(failures).toContain("02  FAILED");
    expect(failures).toContain("03  TIMEOUT");
    expect(failures).toContain("04  EMPTY");
  });

  it.each([
    "nonzero_exit",
    "timeout",
    "api_error",
    "background_task_ceiling",
    "empty_output",
  ] as const)("includes reason, next step, and evidence for %s", (reason) => {
    const output = formatTeamResult(
      status({
        "01": modelStatus(reason === "timeout" ? "TIMEOUT" : "FAILED", {
          id: "01",
          reason,
        }),
      }),
      SESSION_PATH
    );

    expect(output).toContain(`reason=${reason}`);
    expect(output).toMatch(/^\s+next:\s+\S.+$/m);
    expect(output).toContain(`evidence: ${SESSION_PATH}/errors/01.log`);

    if (reason === "background_task_ceiling") {
      expect(output).toContain("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS");
    }
    if (reason === "api_error") {
      expect(output).toContain("or@");
    }
  });

  it("calls out missing diagnostics and tells the caller to report_error", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("FAILED", { id: "01", withError: false }),
      }),
      SESSION_PATH
    );

    expect(output).toMatch(/^\s+evidence:.*NONE CAPTURED.*report_error$/m);
  });

  it("keeps all-succeeded runs tiny and omits failures", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01", outputSize: 100 }),
        "02": modelStatus("COMPLETED", { id: "02", outputSize: 2048 }),
        "03": modelStatus("COMPLETED", { id: "03", outputSize: 3_000_000 }),
      }),
      SESSION_PATH
    );

    expect(output).toContain("status: ok — 3/3 succeeded");
    expect(output).not.toContain("failures:");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(400);
  });

  it("distinguishes all-failed from partial runs", () => {
    const allFailed = formatTeamResult(
      status({
        "01": modelStatus("FAILED", { id: "01", reason: "nonzero_exit" }),
        "02": modelStatus("EMPTY", { id: "02", reason: "empty_output" }),
      }),
      SESSION_PATH
    );
    const partial = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
        "02": modelStatus("TIMEOUT", { id: "02", reason: "timeout" }),
      }),
      SESSION_PATH
    );

    expect(allFailed).toContain("status: all-failed — 0/2 succeeded");
    expect(partial).toContain("status: partial — 1/2 succeeded");
  });

  it("sorts model ids regardless of fixture insertion order", () => {
    const output = formatTeamResult(
      status({
        "03": modelStatus("FAILED", { id: "03", reason: "nonzero_exit" }),
        "01": modelStatus("FAILED", { id: "01", reason: "nonzero_exit" }),
        "02": modelStatus("FAILED", { id: "02", reason: "nonzero_exit" }),
      }),
      SESSION_PATH
    );

    const model01 = output.indexOf("  01  FAILED");
    const model02 = output.indexOf("  02  FAILED");
    const model03 = output.indexOf("  03  FAILED");

    expect(model01).toBeGreaterThan(-1);
    expect(model02).toBeGreaterThan(model01);
    expect(model03).toBeGreaterThan(model02);
  });
});
