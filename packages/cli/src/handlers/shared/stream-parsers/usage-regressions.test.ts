import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";

import { DefaultAPIFormat } from "../../../adapters/base-api-format.js";
import { createGeminiSseStream } from "./gemini-sse.js";
import { messageStartUsage } from "./message-start-usage.js";
import { createOllamaJsonlStream } from "./ollama-jsonl.js";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

interface ClaudeEventData {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
    };
  };
  usage?: Record<string, number>;
}

interface ClaudeEvent {
  event: string;
  data: ClaudeEventData;
}

const OPENAI_FIXTURE = new URL(
  "../../../test-fixtures/sse-responses/SEED-openai-text-only.sse",
  import.meta.url
);
const OPENAI_RESPONSES_FIXTURE = new URL(
  "../../../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse",
  import.meta.url
);

function createMockContext(): Context {
  return {
    body(stream: ReadableStream, init?: ResponseInit) {
      return new Response(stream, init);
    },
    json() {
      throw new Error("Unexpected no-body error path");
    },
  } as unknown as Context;
}

function fixtureToResponse(url: URL, transform?: (wire: string) => string): Response {
  const fixture = readFileSync(url, "utf8");
  const wire = transform ? transform(fixture) : fixture;

  return new Response(wire, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiFixture(promptTokens = 50): Response {
  return fixtureToResponse(OPENAI_FIXTURE, (wire) =>
    wire.replace('"prompt_tokens":50', `"prompt_tokens":${promptTokens}`)
  );
}

function geminiFixture(promptTokens = 456): Response {
  const chunk = {
    candidates: [
      {
        content: { parts: [{ text: "Hello from Gemini" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: 7,
    },
  };

  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function ollamaFixture(promptTokens = 456): Response {
  const wire = [
    JSON.stringify({ message: { content: "Hello from Ollama" }, done: false }),
    JSON.stringify({ done: true, prompt_eval_count: promptTokens, eval_count: 7 }),
    "",
  ].join("\n");

  return new Response(wire, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function parseClaudeSseStream(response: Response): Promise<ClaudeEvent[]> {
  const wire = await response.text();

  return wire
    .split("\n\n")
    .map((part) => {
      const lines = part.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      return { event, data };
    })
    .filter(({ data }) => Boolean(data) && data !== "[DONE]")
    .map(({ event, data }) => ({
      event,
      data: JSON.parse(data!) as ClaudeEventData,
    }));
}

function messageStartInput(events: ClaudeEvent[]): number | undefined {
  return events.find((event) => event.data?.type === "message_start")?.data?.message?.usage
    ?.input_tokens;
}

function closingUsage(events: ClaudeEvent[]): Record<string, number> {
  const usage = events.find((event) => event.data?.type === "message_delta")?.data?.usage;
  expect(usage).toBeDefined();
  if (!usage) throw new Error("Expected closing message_delta usage");
  return usage;
}

function createOpenAiStream(priorInputTokens?: number, promptTokens = 50): Response {
  return createStreamingResponseHandler(
    createMockContext(),
    openAiFixture(promptTokens),
    new DefaultAPIFormat("test-model"),
    "test-model",
    null,
    undefined,
    undefined,
    undefined,
    priorInputTokens
  );
}

function createResponsesStream(priorInputTokens?: number): Response {
  return createResponsesStreamHandler(
    createMockContext(),
    fixtureToResponse(OPENAI_RESPONSES_FIXTURE),
    {
      modelName: "gpt-5.6-sol",
      priorInputTokens,
    }
  );
}

function createGeminiStream(priorInputTokens?: number, promptTokens = 456): Response {
  return createGeminiSseStream(createMockContext(), geminiFixture(promptTokens), {
    modelName: "gemini-test",
    priorInputTokens,
  });
}

function createOllamaStream(priorInputTokens?: number, promptTokens = 456): Response {
  return createOllamaJsonlStream(createMockContext(), ollamaFixture(promptTokens), {
    modelName: "ollama-test",
    priorInputTokens,
  });
}

describe("messageStartUsage", () => {
  test.each([
    [undefined, 100],
    [0, 100],
    [-1, 100],
    [321_000, 321_000],
  ] as const)("maps prior input tokens %p to %p", (priorInputTokens, expected) => {
    expect(messageStartUsage(priorInputTokens)).toEqual({
      input_tokens: expected,
      output_tokens: 1,
    });
  });
});

describe("parser message_start usage", () => {
  const parsers: Array<{
    name: string;
    create: (priorInputTokens?: number) => Response;
  }> = [
    { name: "openai-sse", create: createOpenAiStream },
    { name: "openai-responses-sse", create: createResponsesStream },
    { name: "gemini-sse", create: createGeminiStream },
    { name: "ollama-jsonl", create: createOllamaStream },
  ];

  for (const parser of parsers) {
    test(`${parser.name} carries prior input tokens and falls back to 100`, async () => {
      const withPrior = await parseClaudeSseStream(parser.create(321_000));
      const withoutPrior = await parseClaudeSseStream(parser.create());

      expect(messageStartInput(withPrior)).toBe(321_000);
      expect(messageStartInput(withoutPrior)).toBe(100);
    });
  }
});

describe("closing message_delta usage", () => {
  const parsers: Array<{
    name: string;
    create: (promptTokens: number) => Response;
  }> = [
    { name: "openai-sse", create: (promptTokens) => createOpenAiStream(undefined, promptTokens) },
    {
      name: "gemini-sse",
      create: (promptTokens) => createGeminiStream(undefined, promptTokens),
    },
    {
      name: "ollama-jsonl",
      create: (promptTokens) => createOllamaStream(undefined, promptTokens),
    },
  ];

  for (const parser of parsers) {
    test(`${parser.name} includes positive input tokens and omits zero`, async () => {
      const positive = closingUsage(await parseClaudeSseStream(parser.create(456)));
      const zero = closingUsage(await parseClaudeSseStream(parser.create(0)));

      expect(positive.input_tokens).toBe(456);
      expect(zero).not.toHaveProperty("input_tokens");
    });
  }
});
