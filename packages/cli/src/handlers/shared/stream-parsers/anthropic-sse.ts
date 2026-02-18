/**
 * Anthropic SSE passthrough stream parser.
 *
 * For providers that speak native Anthropic format (MiniMax, Kimi, Z.AI),
 * this is a near-identity transform — the response is already in Claude SSE format.
 * Only light fixups are needed (e.g., ensuring message IDs, merging usage data).
 *
 * Will be extracted from anthropic-compat-handler.ts in Phase 3.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";

/**
 * Pass through an Anthropic-format SSE stream with minimal fixups.
 * The response body is already Claude-compatible SSE events.
 */
export function createAnthropicPassthroughStream(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
  }
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let isClosed = false;

  return c.body(
    new ReadableStream({
      async start(controller) {
        try {
          const reader = response.body!.getReader();
          let buffer = "";
          let inputTokens = 0;
          let outputTokens = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!isClosed) {
                // Pass through SSE events as-is
                controller.enqueue(encoder.encode(line + "\n"));
              }

              // Extract usage from message_delta or message_start events
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                    outputTokens = data.message.usage.output_tokens || outputTokens;
                  }
                  if (data.usage) {
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                } catch {}
              }
            }
          }

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          if (!isClosed) {
            controller.close();
            isClosed = true;
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          if (!isClosed) {
            controller.close();
            isClosed = true;
          }
        }
      },
      cancel() {
        isClosed = true;
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
