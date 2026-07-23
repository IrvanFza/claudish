import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createResponsesStreamHandler } from "./openai-responses-sse.js";

interface ClaudeEvent {
  data: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
}

const REAL_CONTEXT_LENGTH_ERROR =
  '{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';

const REAL_ERROR_MESSAGE =
  "Your input exceeds the context window of this model. Please adjust your input and try again.";

function contextLengthErrorResponse(): Response {
  const realFixture = readFileSync(
    new URL(
      "../../../test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse",
      import.meta.url
    ),
    "utf8"
  );
  const responseCreatedOpening = realFixture.split("\n\n", 1)[0];
  const sse = `${responseCreatedOpening}\n\ndata: ${REAL_CONTEXT_LENGTH_ERROR}\n\n`;

  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createMockContext(): any {
  return {
    json() {
      throw new Error("Unexpected no-body error path");
    },
  };
}

async function parseClaudeSseStream(response: Response): Promise<ClaudeEvent[]> {
  const wire = await response.text();

  return wire
    .split("\n\n")
    .map((part) => part.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line) && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as ClaudeEvent["data"])
    .map((data) => ({ data }));
}

function extractText(events: ClaudeEvent[]): string {
  return events
    .filter(
      (event) =>
        event.data.type === "content_block_delta" && event.data.delta?.type === "text_delta"
    )
    .map((event) => event.data.delta?.text ?? "")
    .join("");
}

describe("OpenAI Responses SSE context overflow", () => {
  test("emits actionable text with the backend cap and signals the API error", async () => {
    const onApiError = mock((_code: string, _message: string) => {});
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      contextLengthErrorResponse(),
      {
        modelName: "gpt-5.6-sol",
        contextWindow: 372000,
        onApiError,
      }
    );

    const text = extractText(await parseClaudeSseStream(parsedResponse));

    expect(text).toContain("Context limit reached");
    expect(text).toContain("/clear");
    expect(text).toContain("oai@gpt-5.6-sol");
    expect(text).toContain("372K");
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenCalledWith("context_length_exceeded", REAL_ERROR_MESSAGE);
  });

  test("omits an invalid cap when contextWindow is unavailable", async () => {
    const parsedResponse = createResponsesStreamHandler(
      createMockContext(),
      contextLengthErrorResponse(),
      {
        modelName: "gpt-5.6-sol",
      }
    );

    const text = extractText(await parseClaudeSseStream(parsedResponse));

    expect(text).toContain("Context limit reached");
    expect(text).toContain("/clear");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });
});
