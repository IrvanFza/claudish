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

describe("classifyRunOutput — requirePattern", () => {
  const requirePattern = "```vote";

  // These are the three real epilogues that replaced complete answers in the
  // measured dropout runs. Their byte counts are deliberately derived from the
  // captured text so the fixtures cannot drift away from what is classified.
  const dropoutFixtures = [
    {
      name: "repro4 response-01 from gc@glm-5.2",
      text: 'The background agent finished: it counted **99** `.ts` files under `packages/cli/src/` containing "timeout" (case-insensitive; 77 for strict-lowercase). That was step 1\'s parallel task — the review and vote above are complete and unaffected by it.\n',
    },
    {
      name: "repro4 response-02 from kc@k3",
      text:
        'The background agent from step 1 has finished: it found **99 `.ts` files** under `packages/cli/src/` containing the word "timeout" (case-insensitive; 77 if matched strictly lowercase), verified with two independent search tools.\n\n' +
        "The review and vote above stand as delivered — the classification logic in `team-orchestrator.ts` is approved with the bounded-tail caveat on the API-error marker.\n",
    },
    {
      name: "the original glm-5.2 incident",
      text:
        "The stray agent was already stopped — that notification just confirms the kill I issued.\n" +
        "Nothing further needed on that front.\n\n" +
        "My review is complete and stands. No new user input has arrived, so I'm not taking any\n" +
        "additional action.\n",
    },
  ];

  it.each(dropoutFixtures)("classifies $name as a shape mismatch", ({ text }) => {
    const outputSize = Buffer.byteLength(text);
    const result = classifyRunOutput({
      outputSize,
      stdoutTail: text,
      stderr: "",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      requirePattern,
    });

    expect(result?.reason).toBe("shape_mismatch");
    expect(result?.detail).toContain(requirePattern);
    expect(result?.detail).toContain(`${outputSize} B`);
  });

  it("accepts output that contains the required shape", () => {
    const text = [
      "The review is complete.",
      "```vote",
      "RESPONSE: 01",
      "VERDICT: APPROVE",
      "```",
    ].join("\n");

    expect(
      classifyRunOutput({
        outputSize: Buffer.byteLength(text),
        stdoutTail: text,
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
        requirePattern,
      })
    ).toBeNull();
  });

  it("leaves shape validation off when requirePattern is omitted", () => {
    const text = dropoutFixtures[0].text;

    expect(
      classifyRunOutput({
        outputSize: Buffer.byteLength(text),
        stdoutTail: text,
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      })
    ).toBeNull();
  });

  it("matches the complete output when the required marker is outside the bounded tail", () => {
    // The answer contract can appear near the start of a multi-KB response. The
    // retained tail alone recreates the exact false failure fullOutput prevents.
    const text = `Review complete.\n${requirePattern}\n${"A".repeat(STDOUT_TAIL_LIMIT + 100)}`;
    const stdoutTail = text.slice(-STDOUT_TAIL_LIMIT);
    const opts = {
      outputSize: Buffer.byteLength(text),
      stdoutTail,
      stderr: "",
      minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      requirePattern,
    };

    expect(stdoutTail).not.toContain(requirePattern);
    expect(classifyRunOutput({ ...opts, fullOutput: text })).toBeNull();
    expect(classifyRunOutput(opts)?.reason).toBe("shape_mismatch");
  });

  it.each([
    {
      name: "an API error in stdout",
      expectedReason: "api_error",
      opts: {
        outputSize: Buffer.byteLength("[API Error: server_is_overloaded ...]"),
        stdoutTail: "[API Error: server_is_overloaded ...]",
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      },
    },
    {
      name: "the background-task ceiling in stderr",
      expectedReason: "background_task_ceiling",
      opts: {
        outputSize: Buffer.byteLength("A real response was started."),
        stdoutTail: "A real response was started.",
        stderr: "Background tasks still running after 600s; terminating",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      },
    },
    {
      name: "zero-byte output",
      expectedReason: "empty_output",
      opts: {
        outputSize: 0,
        stdoutTail: "",
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      },
    },
    {
      name: "whitespace-only output",
      expectedReason: "empty_output",
      opts: {
        outputSize: Buffer.byteLength("\n"),
        stdoutTail: "\n",
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
      },
    },
    {
      name: "output below the caller's minimum",
      expectedReason: "empty_output",
      opts: {
        outputSize: Buffer.byteLength("A short but non-empty response."),
        stdoutTail: "A short but non-empty response.",
        stderr: "",
        minOutputBytes: 500,
      },
    },
  ])("gives $name precedence over shape validation", ({ expectedReason, opts }) => {
    const result = classifyRunOutput({ ...opts, requirePattern });

    expect(result?.reason).toBe(expectedReason);
    expect(result?.reason).not.toBe("shape_mismatch");
  });

  it("does not fail an otherwise-good run when called directly with an invalid regex", () => {
    const text = "A complete response with substantive analysis and a clear conclusion.";
    let result: ReturnType<typeof classifyRunOutput> | undefined;

    expect(() => {
      result = classifyRunOutput({
        outputSize: Buffer.byteLength(text),
        stdoutTail: text,
        stderr: "",
        minOutputBytes: DEFAULT_MIN_OUTPUT_BYTES,
        requirePattern: "(",
      });
    }).not.toThrow();
    expect(result).toBeNull();
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
    "still accepts the measured $outputSize B answer when requirePattern is omitted",
    ({ outputSize, stdoutTail }) => {
      // These real short answers exposed the old minimum-size false positive.
      // The opt-in shape contract must not recreate that failure by default.
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
});
