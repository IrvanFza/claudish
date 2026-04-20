#!/usr/bin/env bun
/**
 * PoC Phase 3b: End-to-end validation with the real Anthropic SDK
 *
 * The strongest validation short of running Claude Code itself: point the
 * real @anthropic-ai/sdk client at our tool-loop proxy, which itself runs
 * a mock executor + mock third-party advisor internally.
 *
 * Flow:
 *   Anthropic SDK → Tool-Loop Proxy → (mock executor + mock advisor)
 *                 ↑
 *                 This is exactly how Claude Code would hit our proxy.
 *
 * If the SDK sees a valid message back with server_tool_use +
 * advisor_tool_result blocks containing third-party advice, it means:
 *   (a) the proxy assembled a wire-compatible response
 *   (b) the SDK parses it without errors
 *   (c) the third-party advice flowed all the way through to the caller
 *
 * Note: this test uses NON-STREAMING responses because our tool-loop
 * proxy returns JSON (streaming the combined output is Phase 4 work).
 * The SDK supports non-streaming fine — this is still a real end-to-end.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";

// Start the tool-loop proxy as a child process
const poc = spawn("bun", ["run", join(import.meta.dir, "05-tool-loop-proxy.ts"), "--server-only"], {
  stdio: "pipe",
  cwd: import.meta.dir,
});

// ...but wait — 05-tool-loop-proxy.ts only has --self-test mode.
// We need a --server-only mode. Let me just spawn inline instead:
poc.kill();

// Inline approach: dynamically import the proxy module and start its servers.
// But 05-tool-loop-proxy.ts runs its self-test on import if --self-test is present,
// and otherwise doesn't export anything. Simplest path: copy the server startup
// into this file.

// Actually, let's just use a different technique: start THIS file with a flag
// that spawns the three servers in the background, then runs the SDK test.

import { spawnSync } from "node:child_process";

// Start the three mock servers + proxy by re-importing the proxy module with
// a "start" side-effect. We need 05 to expose functions — let me hack this by
// requiring it via dynamic import AND adding a --keep-alive mode to 05.
//
// Simpler: do it all inline here to avoid cross-file coupling.

const EXECUTOR_PORT = 9101;
const ADVISOR_PORT = 9102;
const PROXY_PORT = 8889;
const MOCK_THIRD_PARTY_ADVICE =
  "THIRD_PARTY_ADVICE_MARKER: Use bounded channels and a semaphore for max-in-flight.";

let executorTurn = 0;

const execServer = Bun.serve({
  port: EXECUTOR_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 30,
  async fetch(req) {
    const body = (await req.json()) as any;
    executorTurn++;
    const lastUserMsg = [...body.messages].reverse().find((m: any) => m.role === "user");
    const lastUserBlocks: any[] = Array.isArray(lastUserMsg?.content) ? lastUserMsg.content : [];
    const toolResult = lastUserBlocks.find((b: any) => b?.type === "tool_result");

    if (!toolResult) {
      return new Response(
        JSON.stringify({
          id: `msg_exec_${executorTurn}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [
            { type: "text", text: "Let me consult the advisor on this." },
            { type: "tool_use", id: "toolu_exec_1", name: "advisor", input: {} },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    const advice =
      typeof toolResult.content === "string"
        ? toolResult.content
        : toolResult.content?.[0]?.text ?? "(none)";

    return new Response(
      JSON.stringify({
        id: `msg_exec_${executorTurn}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          {
            type: "text",
            text: `Following the advisor: ${advice}. Proceeding with implementation.`,
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

const advServer = Bun.serve({
  port: ADVISOR_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 30,
  async fetch(req) {
    const body = (await req.json()) as any;
    return new Response(
      JSON.stringify({
        id: "msg_adv_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: MOCK_THIRD_PARTY_ADVICE }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 30 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

// The proxy: same logic as 05, just inlined.
const proxyServer = Bun.serve({
  port: PROXY_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/messages") {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as any;

    // Extract advisor tool, replace with regular tool
    const advisorConfig = (body.tools || []).find((t: any) => t?.type === "advisor_20260301");
    const modifiedTools = (body.tools || [])
      .filter((t: any) => t?.type !== "advisor_20260301")
      .concat(
        advisorConfig
          ? [
              {
                name: advisorConfig.name || "advisor",
                description: "Consult the strategic advisor (no arguments).",
                input_schema: { type: "object", properties: {}, additionalProperties: false },
              },
            ]
          : [],
      );

    const adviceByToolUseId = new Map<string, string>();
    let workingBody = { ...body, tools: modifiedTools };
    const combinedBlocks: any[] = [];

    for (let iter = 0; iter < 10; iter++) {
      const r = await fetch(`http://127.0.0.1:${EXECUTOR_PORT}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(workingBody),
      });
      const execMsg: any = await r.json();
      const blocks: any[] = execMsg.content ?? [];
      const advisorUses = blocks.filter(
        (b) => b.type === "tool_use" && b.name === (advisorConfig?.name || "advisor"),
      );

      if (advisorUses.length === 0 || execMsg.stop_reason !== "tool_use") {
        combinedBlocks.push(...blocks);
        break;
      }
      combinedBlocks.push(...blocks);

      const advisorCtx = [...workingBody.messages, { role: "assistant", content: blocks }];
      const toolResults: any[] = [];
      for (const use of advisorUses) {
        const advResp = await fetch(`http://127.0.0.1:${ADVISOR_PORT}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: advisorConfig.model,
            max_tokens: 1024,
            system: "You are a strategic advisor.",
            messages: advisorCtx,
          }),
        });
        const advMsg: any = await advResp.json();
        const advice =
          advMsg.content?.find((b: any) => b.type === "text")?.text ?? "(none)";
        adviceByToolUseId.set(use.id, advice);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: [{ type: "text", text: advice }],
        });
      }

      workingBody = {
        ...workingBody,
        messages: [
          ...workingBody.messages,
          { role: "assistant", content: blocks },
          { role: "user", content: toolResults },
        ],
      };
    }

    // Transform to client-facing advisor blocks
    const clientBlocks: any[] = [];
    for (const b of combinedBlocks) {
      if (b.type === "tool_use" && b.name === (advisorConfig?.name || "advisor")) {
        clientBlocks.push({
          type: "server_tool_use",
          id: b.id,
          name: "advisor",
          input: {},
        });
        const advice = adviceByToolUseId.get(b.id) ?? "(no advice)";
        clientBlocks.push({
          type: "advisor_tool_result",
          tool_use_id: b.id,
          content: { type: "advisor_result", text: advice },
        });
      } else {
        clientBlocks.push(b);
      }
    }

    return new Response(
      JSON.stringify({
        id: "msg_proxy_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: clientBlocks,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

await new Promise((r) => setTimeout(r, 100));

// ─── Now run the Anthropic SDK against our proxy ───
console.log("\x1b[33m[e2e] running Anthropic SDK against tool-loop proxy...\x1b[0m");
console.log(`[e2e] proxy: http://127.0.0.1:${PROXY_PORT}`);

const client = new Anthropic({
  apiKey: "poc-fake",
  baseURL: `http://127.0.0.1:${PROXY_PORT}`,
  maxRetries: 0,
});

let ok = false;
try {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" } as any,
    ],
    messages: [
      {
        role: "user",
        content: "Build a concurrent worker pool in Go with graceful shutdown.",
      },
    ],
  });

  console.log(`\n[e2e] SDK received message:`);
  console.log(`  id: ${msg.id}`);
  console.log(`  stop_reason: ${msg.stop_reason}`);
  console.log(`  content blocks: ${msg.content.length}`);
  for (const [i, b] of msg.content.entries()) {
    const bb: any = b;
    let preview: string;
    if (bb.type === "text") preview = JSON.stringify(bb.text.slice(0, 80));
    else if (bb.type === "server_tool_use") preview = `name=${bb.name} id=${bb.id}`;
    else if (bb.type === "advisor_tool_result")
      preview = `advice=${JSON.stringify((bb.content?.text ?? "").slice(0, 80))}`;
    else preview = JSON.stringify(bb).slice(0, 80);
    console.log(`  [${i}] ${bb.type}: ${preview}`);
  }

  // Validate
  const blocks: any[] = msg.content;
  const hasServerToolUse = blocks.some((b) => b.type === "server_tool_use");
  const advisorResult = blocks.find((b) => b.type === "advisor_tool_result") as any;
  const advisorText = advisorResult?.content?.text ?? "";
  const finalText = blocks.filter((b) => b.type === "text").pop() as any;

  const c1 = hasServerToolUse;
  const c2 = advisorText.includes("THIRD_PARTY_ADVICE_MARKER");
  const c3 = finalText?.text?.includes("THIRD_PARTY_ADVICE_MARKER") ?? false;
  const c4 = msg.stop_reason === "end_turn";

  console.log("\n[validation]");
  console.log(`  [${c1 ? "✓" : "✗"}] Anthropic SDK parsed server_tool_use`);
  console.log(`  [${c2 ? "✓" : "✗"}] Anthropic SDK parsed advisor_tool_result with third-party advice`);
  console.log(`  [${c3 ? "✓" : "✗"}] Executor continuation (final text) uses third-party advice`);
  console.log(`  [${c4 ? "✓" : "✗"}] stop_reason is end_turn`);

  ok = c1 && c2 && c3 && c4;
  if (ok) {
    console.log("\n\x1b[32m[PASS] End-to-end via Anthropic SDK:\x1b[0m");
    console.log("  - Tool-loop proxy assembled a wire-compatible response");
    console.log("  - Anthropic SDK parsed it without errors");
    console.log("  - Third-party advice reached the caller intact");
    console.log("  - The executor's final text is informed by third-party advice");
  } else {
    console.log("\n\x1b[31m[FAIL] one or more validation checks failed\x1b[0m");
  }
} catch (err: any) {
  console.log(`\n\x1b[31m[e2e] SDK threw: ${err?.message}\x1b[0m`);
  if (err?.error) console.log(`    error body:`, err.error);
  if (err?.cause) console.log(`    cause:`, err.cause);
}

execServer.stop(true);
advServer.stop(true);
proxyServer.stop(true);

process.exit(ok ? 0 : 1);
