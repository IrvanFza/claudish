import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MIN_OUTPUT_BYTES,
  STDOUT_TAIL_LIMIT,
  classifyRunOutput,
} from "./team-orchestrator.js";

const CLEAN_LARGE_OUTPUT = "A".repeat(STDOUT_TAIL_LIMIT);

describe("classifyRunOutput", () => {
  it("classifies an API error printed to stdout", () => {
    const result = classifyRunOutput({
      outputSize: 98,
      stdoutTail:
        "[API Error: server_is_overloaded Our servers are currently overloaded. Please try again later.]",
      stderr: "",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe("api_error");
    expect(result?.detail).toContain(
      "server_is_overloaded Our servers are currently overloaded. Please try again later."
    );
  });

  it("classifies Claude Code's background-task wait ceiling", () => {
    const result = classifyRunOutput({
      outputSize: 195,
      stdoutTail: "A short preamble that is not a complete model response.",
      stderr:
        "Background tasks still running after 600s; terminating. " +
        "Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe("background_task_ceiling");
    expect(result?.detail).toContain("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS");
  });

  it("classifies output below the configured minimum as empty", () => {
    const shortOutput = "A".repeat(300);
    const result = classifyRunOutput({
      outputSize: 300,
      stdoutTail: shortOutput,
      stderr: "",
      minOutputBytes: 500,
    });

    expect(result?.reason).toBe("empty_output");
    expect(result?.detail).toContain("caller required at least 500 B");
    expect(
      classifyRunOutput({
        outputSize: 300,
        stdoutTail: shortOutput,
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      })
    ).toBeNull();
  });

  it.each([
    {
      outputSize: 141,
      stdoutTail:
        "Observability provides visibility into complex system behaviors, enabling rapid diagnosis and resolution of issues before they impact users.",
    },
    {
      outputSize: 96,
      stdoutTail:
        "Observability matters because it turns opaque failures into diagnosable signals you can act on.",
    },
  ])(
    "accepts the measured $outputSize B regression answer at default",
    ({ outputSize, stdoutTail }) => {
      expect(
        classifyRunOutput({
          outputSize,
          stdoutTail,
          stderr: "",
          minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
        })
      ).toBeNull();
    }
  );

  it.each([
    { name: "a newline", outputSize: 1, stdoutTail: "\n" },
    {
      name: "mixed spaces, newline, and tab",
      outputSize: Buffer.byteLength("   \n\t "),
      stdoutTail: "   \n\t ",
    },
    { name: "zero bytes", outputSize: 0, stdoutTail: "" },
  ])("classifies $name as empty at default", ({ outputSize, stdoutTail }) => {
    const result = classifyRunOutput({
      outputSize,
      stdoutTail,
      stderr: "",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe("empty_output");
  });

  it("accepts large clean output", () => {
    expect(
      classifyRunOutput({
        outputSize: Buffer.byteLength(CLEAN_LARGE_OUTPUT),
        stdoutTail: CLEAN_LARGE_OUTPUT,
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      })
    ).toBeNull();
  });

  it("does not treat a large answer with a whitespace-only retained tail as empty", () => {
    expect(
      classifyRunOutput({
        outputSize: 30_000,
        stdoutTail: "   \n  ",
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      })
    ).toBeNull();
  });

  it("classifies whitespace-only output at the retained-tail boundary as empty", () => {
    const result = classifyRunOutput({
      outputSize: STDOUT_TAIL_LIMIT,
      stdoutTail: " ".repeat(STDOUT_TAIL_LIMIT),
      stderr: "",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe("empty_output");
  });

  it("gives an API error precedence over empty output", () => {
    const apiError = "[API Error: request failed]";
    const result = classifyRunOutput({
      outputSize: Buffer.byteLength(apiError),
      stdoutTail: apiError,
      stderr: "",
      minOutputBytes: 500,
    });

    expect(result?.reason).toBe("api_error");
  });

  it("gives the background-task ceiling precedence over whitespace-only output", () => {
    const result = classifyRunOutput({
      outputSize: 1,
      stdoutTail: "\n",
      stderr: "Background tasks still running after 600s; terminating.",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe("background_task_ceiling");
  });

  it.each([
    {
      name: "API error in stdout",
      stdoutTail: `${CLEAN_LARGE_OUTPUT}[API Error: rate limit exceeded]`,
      stderr: "",
      reason: "api_error",
    },
    {
      name: "background-task ceiling in stderr",
      stdoutTail: CLEAN_LARGE_OUTPUT,
      stderr: "Background tasks still running after 600s; terminating.",
      reason: "background_task_ceiling",
    },
  ])("detects $name even when outputSize is large", ({ stdoutTail, stderr, reason }) => {
    const result = classifyRunOutput({
      outputSize: 10_000,
      stdoutTail,
      stderr,
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
    });

    expect(result?.reason).toBe(reason);
  });
});
