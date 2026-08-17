#!/usr/bin/env bun
/**
 * Fake claudish child for the team stream-json recovery regression.
 *
 * It models the real post-answer-turn capture: a substantial answer, a tool
 * round trip, a short background-task epilogue, and a terminal result whose
 * `.result` contains only that epilogue. Without `--output-format stream-json`
 * it behaves like `claude -p` and prints only the terminal result text.
 */

export {};

const LONG_ANSWER = [
  "# Independent review",
  "",
  "The implementation preserves the complete answer even when a late background task creates another assistant turn.",
  "The recovered response still carries the caller's required vote contract and remains suitable for judging.",
  "",
  "```vote",
  "RESPONSE: 01",
  "VERDICT: APPROVE",
  "CONFIDENCE: 9",
  "SUMMARY: The answer-survival behavior is correct and covered by a process-level regression.",
  "KEY_ISSUES: None",
  "```",
  "",
  "This paragraph makes the answer deliberately substantial, so losing it cannot be confused with a harmless formatting change.",
].join("\n");

const BACKGROUND_EPILOGUE =
  "The background task has now finished; its bookkeeping note does not change the vote above.";

const THINKING_DETAIL =
  "I am checking the implementation and keeping private reasoning out of the final answer. ".repeat(
    120
  );
const TOOL_INPUT_DETAIL =
  "Inspect the repository without changing it, then report only the relevant evidence. ".repeat(60);
const TOOL_RESULT_DETAIL =
  "Inspection completed successfully; the requested evidence was collected. ".repeat(60);

function buildStreamJson(): string {
  const events = [
    {
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 12,
      estimated_tokens_delta: 12,
      session_id: "fake-stream-json-session",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: THINKING_DETAIL }],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: LONG_ANSWER }],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_fake_stream_json",
            name: "Bash",
            input: { command: "true", description: TOOL_INPUT_DETAIL },
          },
        ],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fake_stream_json",
            content: TOOL_RESULT_DETAIL,
            is_error: false,
          },
        ],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 4,
      estimated_tokens_delta: 4,
      session_id: "fake-stream-json-session",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "The background task finished, so I should acknowledge it briefly.",
          },
        ],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: BACKGROUND_EPILOGUE }],
      },
      session_id: "fake-stream-json-session",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: BACKGROUND_EPILOGUE,
      session_id: "fake-stream-json-session",
    },
  ];

  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function main() {
  for await (const chunk of process.stdin) {
    void chunk;
  }

  const args = process.argv.slice(2);
  const outputFormatAt = args.indexOf("--output-format");
  const streamJsonRequested = outputFormatAt !== -1 && args[outputFormatAt + 1] === "stream-json";

  process.stdout.write(streamJsonRequested ? buildStreamJson() : `${BACKGROUND_EPILOGUE}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
