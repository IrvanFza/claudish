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
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  return c.body(
    new ReadableStream({
      async start(controller) {
        const sendPing = () => {
          if (!isClosed) {
            controller.enqueue(encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"));
          }
        };

        sendPing();

        pingInterval = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) {
            sendPing();
          }
        }, 1000);

        try {
          const reader = response.body!.getReader();
          let buffer = "";
          let inputTokens = 0;
          let outputTokens = 0;

          let totalLines = 0;
          let textChunks = 0;
          let toolUseBlocks = 0;
          let stopReason: string | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            lastActivity = Date.now();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              totalLines++;
              if (!isClosed) {
                // Pass through SSE events as-is
                controller.enqueue(encoder.encode(line + "\n"));
              }

              // Extract usage and debug info from SSE events
              if (line.startsWith("data: ")) {
                log(`[SSE:anthropic] ${line.slice(6).substring(0, 300)}`);

                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                    outputTokens = data.message.usage.output_tokens || outputTokens;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  // Log text content for debugging
                  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                    const txt = data.delta.text || "";
                    textChunks++;
                    log(
                      `[AnthropicSSE] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                    );
                  }
                  // Track tool_use blocks
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "tool_use"
                  ) {
                    toolUseBlocks++;
                    log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                  }
                  // Track stop reason
                  if (data.type === "message_delta" && data.delta?.stop_reason) {
                    stopReason = data.delta.stop_reason;
                  }
                } catch {}
              }
            }
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}`
          );

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            controller.close();
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            controller.close();
          }
        }
      },
      cancel() {
        isClosed = true;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
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
