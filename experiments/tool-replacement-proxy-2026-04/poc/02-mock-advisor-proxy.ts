#!/usr/bin/env bun
/**
 * PoC Phase 2: Mock Advisor Proxy
 *
 * This proxy does NOT forward to Anthropic. It fabricates a complete
 * SSE response containing synthetic advisor tool blocks, so we can test:
 *   (a) Whether our SSE event sequence is well-formed
 *   (b) Whether downstream clients (Claude Code, Anthropic SDK) accept
 *       proxy-fabricated server_tool_use + advisor_tool_result blocks
 *
 * The response simulates what Anthropic's advisor flow looks like:
 *   1. A text block ("Let me consult the advisor...")
 *   2. A server_tool_use block (the advisor "call")
 *   3. An advisor_tool_result block (the advice itself)
 *   4. A final text block (executor continuation)
 *
 * Usage:
 *   bun run 02-mock-advisor-proxy.ts &
 *   bun run 02-mock-advisor-proxy.ts --self-test   # run a client against it
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const PORT = 8788;

// Constants used by response builders — declared up top so that
// self-test mode (which runs before the main server init path) can
// reference them without hitting the temporal dead zone.
const MESSAGE_ID = "msg_poc_advisor_01";
const ADVISOR_ID = "srvtoolu_poc_advisor_01";
const MODEL = "claude-sonnet-4-6";

// ─────────────────────────────────────────────────────────────
// Self-test mode: run a client against ourselves
// ─────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
  await runSelfTest();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// Server mode
// ─────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 30,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    console.log(`[mock] ${req.method} ${url.pathname}`);

    if (url.pathname !== "/v1/messages") {
      return new Response(JSON.stringify({ error: { type: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const reqBody = req.body ? await req.json() : null;
    appendFileSync(join(LOG_DIR, "mock-requests.ndjson"), JSON.stringify(reqBody) + "\n");

    // Report whether the incoming request has the advisor tool
    const tools = (reqBody as any)?.tools ?? [];
    const hasAdvisor = tools.some((t: any) => t?.type === "advisor_20260301");
    console.log(`[mock]   tools: ${tools.length}, has advisor: ${hasAdvisor}`);

    const stream = req.headers.get("accept")?.includes("text/event-stream") || (reqBody as any)?.stream === true;
    if (!stream) {
      // Non-streaming: return the whole message at once as JSON
      return new Response(JSON.stringify(buildNonStreamingResponse()), {
        headers: { "content-type": "application/json" },
      });
    }

    // Streaming: fabricate SSE events
    const body = buildStreamingResponse();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  },
});

console.log(`\x1b[36m┌─ Mock advisor proxy listening on http://${server.hostname}:${server.port}\x1b[0m`);
console.log(`\x1b[36m└─ POST /v1/messages (returns fabricated advisor response)\x1b[0m`);

// ─────────────────────────────────────────────────────────────
// Response builders
// ─────────────────────────────────────────────────────────────

function buildNonStreamingResponse() {
  return {
    id: MESSAGE_ID,
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      { type: "text", text: "Let me consult the advisor on this." },
      {
        type: "server_tool_use",
        id: ADVISOR_ID,
        name: "advisor",
        input: {},
      },
      {
        type: "advisor_tool_result",
        tool_use_id: ADVISOR_ID,
        content: {
          type: "advisor_result",
          text: "MOCK ADVICE: Use a channel-based coordination pattern. Close the input channel first, then wait on a WaitGroup.",
        },
      },
      {
        type: "text",
        text: "Based on the advisor's guidance, here's the implementation plan: (1) use channels, (2) drain in-flight work.",
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 412,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 531,
      iterations: [
        { type: "message", input_tokens: 412, output_tokens: 89 },
        {
          type: "advisor_message",
          model: "claude-opus-4-6",
          input_tokens: 823,
          output_tokens: 612,
        },
        { type: "message", input_tokens: 1348, output_tokens: 442 },
      ],
    },
  };
}

/**
 * Build a streaming SSE response body.
 *
 * Event order (per Anthropic's streaming protocol):
 *   1. message_start
 *   2. content_block_start (index 0, text) + text_delta + content_block_stop
 *   3. content_block_start (index 1, server_tool_use) + input_json_delta + content_block_stop
 *   4. content_block_start (index 2, advisor_tool_result) + ... + content_block_stop
 *   5. content_block_start (index 3, text) + text_delta + content_block_stop
 *   6. message_delta (stop_reason=end_turn)
 *   7. message_stop
 */
function buildStreamingResponse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events: Array<{ event: string; data: unknown }> = [];

  const push = (event: string, data: unknown) => events.push({ event, data });

  push("message_start", {
    type: "message_start",
    message: {
      id: MESSAGE_ID,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 412, output_tokens: 0 },
    },
  });

  // Block 0: preamble text
  push("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const chunk of chunksOf("Let me consult the advisor on this.", 10)) {
    push("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
  }
  push("content_block_stop", { type: "content_block_stop", index: 0 });

  // Block 1: server_tool_use (the advisor "call")
  //
  // NOTE: Anthropic's real protocol uses input_json_delta for streaming tool
  // input, but advisor's input is always empty, so the server probably just
  // emits the block with empty input in content_block_start and closes it.
  push("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "server_tool_use",
      id: ADVISOR_ID,
      name: "advisor",
      input: {},
    },
  });
  push("content_block_stop", { type: "content_block_stop", index: 1 });

  // Block 2: advisor_tool_result
  push("content_block_start", {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "advisor_tool_result",
      tool_use_id: ADVISOR_ID,
      content: {
        type: "advisor_result",
        text: "MOCK ADVICE: Use a channel-based coordination pattern. Close the input channel first, then wait on a WaitGroup.",
      },
    },
  });
  push("content_block_stop", { type: "content_block_stop", index: 2 });

  // Block 3: executor continuation
  push("content_block_start", {
    type: "content_block_start",
    index: 3,
    content_block: { type: "text", text: "" },
  });
  for (const chunk of chunksOf(
    "Based on the advisor's guidance, here's the implementation plan: (1) use channels, (2) drain in-flight work.",
    15,
  )) {
    push("content_block_delta", {
      type: "content_block_delta",
      index: 3,
      delta: { type: "text_delta", text: chunk },
    });
  }
  push("content_block_stop", { type: "content_block_stop", index: 3 });

  // Final message_delta + stop
  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      input_tokens: 412,
      output_tokens: 531,
      iterations: [
        { type: "message", input_tokens: 412, output_tokens: 89 },
        { type: "advisor_message", model: "claude-opus-4-6", input_tokens: 823, output_tokens: 612 },
        { type: "message", input_tokens: 1348, output_tokens: 442 },
      ],
    },
  });
  push("message_stop", { type: "message_stop" });

  // Serialize as SSE
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { event, data } of events) {
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(line));
        // Small delay so the client sees it as a real stream
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.close();
    },
  });
}

function* chunksOf(s: string, n: number) {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n);
}

// ─────────────────────────────────────────────────────────────
// Self-test: run a client and verify the SSE events parse correctly
// ─────────────────────────────────────────────────────────────
async function runSelfTest() {
  console.log("\x1b[33m[self-test] starting mock server on port 8788...\x1b[0m");

  // Start server in-process
  const testServer = Bun.serve({
    port: 8788,
    hostname: "127.0.0.1",
    idleTimeout: 10,
    async fetch(req) {
      const reqBody = req.body ? await req.json() : null;
      console.log("[self-test] server received request:");
      console.log("  model:", (reqBody as any)?.model);
      console.log("  tools:", ((reqBody as any)?.tools || []).map((t: any) => t.type ?? t.name).join(", "));
      console.log("  stream:", (reqBody as any)?.stream);
      return new Response(buildStreamingResponse(), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });

  await new Promise((r) => setTimeout(r, 100));

  // Send a request that mimics what Claude Code would send
  const clientBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    stream: true,
    tools: [
      {
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-opus-4-6",
      },
    ],
    messages: [{ role: "user", content: "Build a concurrent worker pool in Go." }],
  };

  console.log("\n\x1b[33m[self-test] sending request...\x1b[0m");
  const resp = await fetch("http://127.0.0.1:8788/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "advisor-tool-2026-03-01",
      "anthropic-version": "2023-06-01",
      "accept": "text/event-stream",
    },
    body: JSON.stringify(clientBody),
  });

  console.log(`[self-test] response status: ${resp.status} ${resp.statusText}`);
  console.log(`[self-test] content-type: ${resp.headers.get("content-type")}`);

  if (!resp.body) {
    console.error("\x1b[31m[self-test] FAIL: no response body\x1b[0m");
    testServer.stop();
    return;
  }

  // Parse the SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ event?: string; data?: any }> = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt: { event?: string; data?: any } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) evt.event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try {
            evt.data = JSON.parse(line.slice(5).trim());
          } catch {
            evt.data = { _parseError: true };
          }
        }
      }
      if (evt.event) events.push(evt);
    }
  }

  console.log(`\n\x1b[33m[self-test] received ${events.length} SSE events\x1b[0m`);

  // Reconstruct the message from the events (simulating how an SDK would)
  interface Block {
    type: string;
    text?: string;
    id?: string;
    tool_use_id?: string;
    input?: unknown;
    content?: unknown;
  }
  const blocks: Block[] = [];
  let messageId: string | undefined;
  let stopReason: string | undefined;

  for (const { event, data } of events) {
    switch (event) {
      case "message_start":
        messageId = data.message?.id;
        break;
      case "content_block_start":
        blocks[data.index] = { ...data.content_block };
        break;
      case "content_block_delta":
        if (data.delta?.type === "text_delta") {
          blocks[data.index].text = (blocks[data.index].text ?? "") + data.delta.text;
        }
        break;
      case "content_block_stop":
        break;
      case "message_delta":
        stopReason = data.delta?.stop_reason;
        break;
      case "message_stop":
        break;
    }
  }

  console.log(`\n\x1b[33m[self-test] reconstructed message:\x1b[0m`);
  console.log(`  id: ${messageId}`);
  console.log(`  stop_reason: ${stopReason}`);
  console.log(`  block count: ${blocks.length}`);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const preview =
      b.type === "text"
        ? JSON.stringify(b.text?.slice(0, 60))
        : b.type === "server_tool_use"
          ? `name=${(b as any).name} id=${b.id}`
          : b.type === "advisor_tool_result"
            ? `tool_use_id=${b.tool_use_id} text=${JSON.stringify(((b.content as any)?.text ?? "").slice(0, 60))}`
            : JSON.stringify(b);
    console.log(`  [${i}] ${b.type}: ${preview}`);
  }

  // Validation
  const ok =
    blocks.length === 4 &&
    blocks[0].type === "text" &&
    blocks[1].type === "server_tool_use" &&
    (blocks[1] as any).name === "advisor" &&
    blocks[2].type === "advisor_tool_result" &&
    blocks[2].tool_use_id === (blocks[1] as any).id &&
    blocks[3].type === "text" &&
    stopReason === "end_turn";

  if (ok) {
    console.log("\n\x1b[32m[self-test] ✅ PASS: SSE events parse into a well-formed advisor response\x1b[0m");
    console.log("  - Block 0 is text");
    console.log("  - Block 1 is server_tool_use with name='advisor'");
    console.log("  - Block 2 is advisor_tool_result linking to block 1's id");
    console.log("  - Block 3 is text (continuation)");
    console.log("  - stop_reason is 'end_turn'");
  } else {
    console.log("\n\x1b[31m[self-test] ❌ FAIL: reconstructed message does not match expected shape\x1b[0m");
  }

  testServer.stop();
}
