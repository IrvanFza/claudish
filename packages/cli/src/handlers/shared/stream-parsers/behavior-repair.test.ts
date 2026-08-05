import { describe, expect, it } from "bun:test";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";
import { createGeminiSseStream } from "./gemini-sse.js";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

const TARGET_TOOL = "target_tool";
const UNTARGETED_TOOL = "untargeted_tool";
const ORIGINAL_VALUE = "model-original";
const REPAIRED_VALUE = "behavior-repaired";
const ORIGINAL_ARGS = JSON.stringify({ value: ORIGINAL_VALUE });
const REPAIRED_ARGS = JSON.stringify({ value: REPAIRED_VALUE });

const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const dataFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const anthropicFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function fakeSession() {
  const repair = (name: string, _argsJson: string) =>
    name === TARGET_TOOL ? REPAIRED_ARGS : undefined;

  return {
    shouldBufferTool: (name: string) => name === TARGET_TOOL,
    onToolCall: repair,
    repairToolArgs: repair,
  };
}

const toolSchemas = [TARGET_TOOL, UNTARGETED_TOOL].map((name) => ({
  name,
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
}));

function openAiToolFrames(name: string, args = ORIGINAL_ARGS): string[] {
  return [
    dataFrame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_openai_0",
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ];
}

function parseOpenAiTool(name: string, behavior = fakeSession(), args = ORIGINAL_ARGS): Response {
  return createStreamingResponseHandler(
    ctx,
    sseResponse(openAiToolFrames(name, args)),
    {},
    "test-model",
    null,
    undefined,
    toolSchemas,
    undefined,
    undefined,
    behavior
  );
}

function responsesToolFrames(name: string, fragments = [ORIGINAL_ARGS]): string[] {
  const item = {
    type: "function_call",
    id: "fc_responses_item_0",
    call_id: "responses_call_0",
    name,
  };

  return [
    dataFrame({ type: "response.output_item.added", item }),
    ...fragments.map((delta) =>
      dataFrame({
        type: "response.function_call_arguments.delta",
        call_id: item.call_id,
        item_id: item.id,
        delta,
      })
    ),
    dataFrame({ type: "response.output_item.done", item }),
    dataFrame({
      type: "response.completed",
      response: { usage: { input_tokens: 5, output_tokens: 3 } },
    }),
  ];
}

function parseResponsesTool(
  name: string,
  fragments = [ORIGINAL_ARGS],
  session = fakeSession()
): Response {
  return createResponsesStreamHandler(ctx, sseResponse(responsesToolFrames(name, fragments)), {
    modelName: "test-model",
    shouldBufferTool: session.shouldBufferTool,
    onToolCall: session.onToolCall,
  });
}

function anthropicToolFrames(name: string, fragments = [ORIGINAL_ARGS]): string[] {
  return [
    anthropicFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_anthropic_0", name, input: {} },
    }),
    ...fragments.map((partial_json) =>
      anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })
    ),
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ];
}

function parseAnthropicTool(
  name: string,
  fragments = [ORIGINAL_ARGS],
  withBehavior = true
): Response {
  const session = fakeSession();
  return createAnthropicPassthroughStream(ctx, sseResponse(anthropicToolFrames(name, fragments)), {
    modelName: "test-model",
    ...(withBehavior
      ? {
          shouldBufferTool: session.shouldBufferTool,
          repairToolArgs: session.repairToolArgs,
        }
      : {}),
  });
}

function geminiToolFrames(name: string): string[] {
  return [
    dataFrame({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name, args: { value: ORIGINAL_VALUE } } }],
          },
          finishReason: "STOP",
        },
      ],
    }),
  ];
}

function inputJsonDeltas(wire: string): string[] {
  const deltas: string[] = [];
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
        deltas.push(data.delta.partial_json);
      }
    } catch {}
  }
  return deltas;
}

function stripPingFrames(wire: string): string {
  return wire.replaceAll('event: ping\ndata: {"type":"ping"}\n\n', "");
}

describe("openai-sse behavior repair", () => {
  it("rewrites arguments for a targeted tool", async () => {
    const out = await parseOpenAiTool(TARGET_TOOL).text();

    expect(out).toContain(REPAIRED_VALUE);
    expect(out).not.toContain(ORIGINAL_VALUE);
  });

  it("passes an untargeted tool through unchanged", async () => {
    const out = await parseOpenAiTool(UNTARGETED_TOOL).text();

    expect(out).toContain(ORIGINAL_VALUE);
    expect(out).not.toContain(REPAIRED_VALUE);
  });

  it("emits the model arguments when a repair rule throws", async () => {
    const session = fakeSession();
    const out = await parseOpenAiTool(TARGET_TOOL, {
      ...session,
      onToolCall: () => {
        throw new Error("synthetic repair failure");
      },
    }).text();

    expect(out).toContain(ORIGINAL_VALUE);
    expect(out).not.toContain(REPAIRED_VALUE);
    expect(out).toContain('"type":"message_stop"');
  });
});

describe("openai-responses-sse behavior repair", () => {
  it("rewrites arguments for a targeted tool", async () => {
    const out = await parseResponsesTool(TARGET_TOOL).text();

    expect(out).toContain(REPAIRED_VALUE);
    expect(out).not.toContain(ORIGINAL_VALUE);
  });

  it("passes an untargeted tool through unchanged", async () => {
    const out = await parseResponsesTool(UNTARGETED_TOOL).text();

    expect(out).toContain(ORIGINAL_VALUE);
    expect(out).not.toContain(REPAIRED_VALUE);
  });

  it("keeps untargeted argument fragments incremental", async () => {
    const fragments = ['{"value":"incremental-', 'delivery"}'];
    const out = await parseResponsesTool(UNTARGETED_TOOL, fragments).text();

    expect(inputJsonDeltas(out)).toEqual(fragments);
  });
});

describe("anthropic-sse behavior repair", () => {
  it("reassembles fragmented targeted arguments, repairs them, and emits one delta", async () => {
    const originalFragments = ['{"value":"model-', 'original"}'];
    const out = await parseAnthropicTool(TARGET_TOOL, originalFragments).text();

    expect(inputJsonDeltas(out)).toEqual([REPAIRED_ARGS]);
    expect(out).toContain(REPAIRED_VALUE);
    for (const fragment of originalFragments) expect(out).not.toContain(fragment);
    expect(out).not.toContain(ORIGINAL_VALUE);
  });

  it("passes an untargeted tool through unchanged", async () => {
    const out = await parseAnthropicTool(UNTARGETED_TOOL).text();

    expect(out).toContain(ORIGINAL_VALUE);
    expect(out).not.toContain(REPAIRED_VALUE);
  });

  it("is byte-identical for an untargeted tool after generated pings are stripped", async () => {
    const frames = anthropicToolFrames(UNTARGETED_TOOL, ['{"value":"byte-', 'identical"}']);
    const session = fakeSession();
    const baseline = await createAnthropicPassthroughStream(ctx, sseResponse(frames), {
      modelName: "test-model",
    }).text();
    const withBehavior = await createAnthropicPassthroughStream(ctx, sseResponse(frames), {
      modelName: "test-model",
      shouldBufferTool: session.shouldBufferTool,
      repairToolArgs: session.repairToolArgs,
    }).text();

    expect(stripPingFrames(withBehavior)).toBe(stripPingFrames(baseline));
  });
});

describe("gemini-sse behavior repair", () => {
  it("rewrites arguments for a targeted tool", async () => {
    const session = fakeSession();
    const out = await createGeminiSseStream(ctx, sseResponse(geminiToolFrames(TARGET_TOOL)), {
      modelName: "test-model",
      repairToolArgs: session.repairToolArgs,
    }).text();

    expect(out).toContain(REPAIRED_VALUE);
    expect(out).not.toContain(ORIGINAL_VALUE);
  });

  it("passes an untargeted tool through unchanged", async () => {
    const session = fakeSession();
    const out = await createGeminiSseStream(ctx, sseResponse(geminiToolFrames(UNTARGETED_TOOL)), {
      modelName: "test-model",
      repairToolArgs: session.repairToolArgs,
    }).text();

    expect(out).toContain(ORIGINAL_VALUE);
    expect(out).not.toContain(REPAIRED_VALUE);
  });
});
