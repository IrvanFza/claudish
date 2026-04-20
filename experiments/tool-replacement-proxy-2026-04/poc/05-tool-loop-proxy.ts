#!/usr/bin/env bun
/**
 * PoC Phase 3: Tool-Loop Advisor Replacement Proxy
 *
 * This is the real proof of concept for the "Approach F" architecture
 * described in the report. The proxy:
 *
 *   1. Accepts /v1/messages requests from Claude Code on :8789.
 *   2. Detects advisor_20260301 in tools[], extracts its config, and
 *      replaces it with a regular tool definition.
 *   3. Forwards the modified request to the EXECUTOR backend.
 *   4. Watches the response for stop_reason === "tool_use" where the
 *      tool name is "advisor".
 *   5. If caught: runs the THIRD-PARTY ADVISOR on the full transcript,
 *      appends a tool_result with the advice, and sends a follow-up
 *      request to the executor so it can continue generation using
 *      the third-party advice.
 *   6. Collects the executor's continuation.
 *   7. Transforms the final combined response into a client-facing
 *      stream that contains server_tool_use + advisor_tool_result blocks
 *      — so Claude Code sees what looks like native advisor output.
 *
 * To keep the PoC self-contained, both the executor and the advisor
 * backends are MOCK servers running in-process. This lets us verify
 * the proxy's control flow without API keys.
 *
 * Usage:
 *   bun run 05-tool-loop-proxy.ts --self-test
 */

import Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────
// Mock executor backend (stands in for Anthropic/OpenRouter)
//
// Turn 1: executor generates "Let me think..." then calls the "advisor"
//         regular tool with empty input, stops with stop_reason=tool_use.
// Turn 2: after tool_result is injected, executor generates a continuation
//         that references the advice verbatim, then end_turn.
//
// The mock executor uses the LAST advisor advice it saw in the message
// history as the source of truth for its continuation — so if the proxy
// successfully swapped in third-party advice, the executor's continuation
// will mention "XYZ" (the third-party advice) instead of Opus's response.
// ─────────────────────────────────────────────────────────────

const EXECUTOR_PORT = 9001;
const ADVISOR_PORT = 9002;
const PROXY_PORT = 8789;

const MOCK_THIRD_PARTY_ADVICE =
  "THIRD_PARTY_ADVICE_MARKER: Use bounded channels and a semaphore for max-in-flight.";

// Global request counter used to return different mock responses for
// turn-1 vs turn-2 requests from the proxy to the executor.
let executorTurn = 0;

function startMockExecutor() {
  return Bun.serve({
    port: EXECUTOR_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as any;
      executorTurn++;
      const turn = executorTurn;

      // Did the caller already include a tool_result in the message history?
      const lastUserMsg = [...body.messages].reverse().find((m: any) => m.role === "user");
      const lastUserBlocks: any[] = Array.isArray(lastUserMsg?.content) ? lastUserMsg.content : [];
      const toolResult = lastUserBlocks.find((b: any) => b?.type === "tool_result");

      if (!toolResult) {
        // Turn 1: emit a tool_use calling the advisor, stop with tool_use
        console.log(`[mock-executor] turn ${turn}: generating tool_use call for "advisor"`);
        return new Response(
          JSON.stringify({
            id: `msg_exec_${turn}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [
              { type: "text", text: "Let me consult the advisor on this." },
              {
                type: "tool_use",
                id: "toolu_exec_advisor_1",
                name: "advisor",
                input: {},
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // Turn 2: inspect the advice we were given, emit a continuation that
      // quotes it back so the test can verify which advice was actually used.
      const advice =
        typeof toolResult.content === "string"
          ? toolResult.content
          : toolResult.content?.[0]?.text ?? JSON.stringify(toolResult.content);
      console.log(`[mock-executor] turn ${turn}: received advice, quoting in continuation`);
      console.log(`[mock-executor]   advice: ${advice.slice(0, 120)}`);

      return new Response(
        JSON.stringify({
          id: `msg_exec_${turn}`,
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
}

function startMockAdvisor() {
  return Bun.serve({
    port: ADVISOR_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      const body = (await req.json()) as any;
      // Record what context the proxy sent to the advisor
      console.log(`[mock-advisor] called with ${body.messages?.length ?? 0} messages`);
      return new Response(
        JSON.stringify({
          id: "msg_advisor_1",
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
}

// ─────────────────────────────────────────────────────────────
// The proxy itself
// ─────────────────────────────────────────────────────────────

const EXECUTOR_URL = `http://127.0.0.1:${EXECUTOR_PORT}`;
const ADVISOR_URL = `http://127.0.0.1:${ADVISOR_PORT}`;

/**
 * Replace advisor_20260301 in the tools array with a regular tool
 * definition. Returns [modifiedTools, extractedAdvisorConfig | null].
 */
function extractAdvisorTool(tools: any[] | undefined): {
  modifiedTools: any[];
  advisorConfig: { name: string; model: string } | null;
} {
  if (!Array.isArray(tools)) return { modifiedTools: [], advisorConfig: null };
  const advisorConfig = tools.find((t) => t?.type === "advisor_20260301");
  if (!advisorConfig) return { modifiedTools: tools, advisorConfig: null };

  const modifiedTools = tools
    .filter((t) => t?.type !== "advisor_20260301")
    .concat([
      {
        name: advisorConfig.name || "advisor",
        description:
          "Consult the strategic advisor for guidance on a complex decision. " +
          "Takes no arguments; the advisor will read the full conversation.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);

  return {
    modifiedTools,
    advisorConfig: {
      name: advisorConfig.name || "advisor",
      model: advisorConfig.model,
    },
  };
}

/** Call the third-party advisor with the full conversation transcript. */
async function callThirdPartyAdvisor(
  messages: any[],
  advisorModel: string,
): Promise<string> {
  const advisorReq = {
    model: advisorModel,
    max_tokens: 1024,
    system:
      "You are a strategic advisor to a coding agent. Read the full conversation " +
      "and provide concise guidance (under 100 words) about how to proceed.",
    messages,
  };

  const resp = await fetch(`${ADVISOR_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(advisorReq),
  });
  if (!resp.ok) throw new Error(`advisor call failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  const text =
    data.content?.find((b: any) => b.type === "text")?.text ?? "(no advice)";
  return text;
}

/** Forward the executor request and return the parsed message. */
async function callExecutor(requestBody: any): Promise<any> {
  const resp = await fetch(`${EXECUTOR_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!resp.ok) throw new Error(`executor call failed: ${resp.status}`);
  return await resp.json();
}

/**
 * Run the tool-loop: keep calling the executor, and every time it stops
 * with a tool_use for "advisor", run the third-party advisor and feed
 * the result back. Collect all assistant turns as a combined block list.
 */
async function runToolLoop(
  originalBody: any,
  advisorConfig: { name: string; model: string },
): Promise<{ combinedBlocks: any[]; advisorCalls: number }> {
  // Working request body we mutate across iterations
  let workingBody = JSON.parse(JSON.stringify(originalBody));
  const combinedBlocks: any[] = [];
  let advisorCalls = 0;

  // Safety cap to prevent infinite loops if the mock/real executor
  // keeps calling the advisor forever.
  const MAX_ITERATIONS = 10;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const execResp = await callExecutor(workingBody);
    const blocks: any[] = execResp.content ?? [];

    // Find any advisor tool_use blocks in this response
    const advisorUseBlocks = blocks.filter(
      (b) => b.type === "tool_use" && b.name === advisorConfig.name,
    );

    if (advisorUseBlocks.length === 0 || execResp.stop_reason !== "tool_use") {
      // Final iteration: append blocks and finish
      combinedBlocks.push(...blocks);
      return { combinedBlocks, advisorCalls };
    }

    advisorCalls += advisorUseBlocks.length;

    // Append blocks to the running result (we'll transform types later)
    combinedBlocks.push(...blocks);

    // For each advisor call, run the third-party model and build a tool_result
    // Build the context we pass to the advisor: include the system prompt,
    // the full existing messages, and the current assistant turn so the
    // advisor sees exactly what the executor is looking at.
    const advisorContext = [
      ...workingBody.messages,
      { role: "assistant", content: blocks },
    ];

    const toolResultBlocks: any[] = [];
    for (const toolUse of advisorUseBlocks) {
      const advice = await callThirdPartyAdvisor(advisorContext, advisorConfig.model);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: [{ type: "text", text: advice }],
      });
    }

    // Feed the tool result back to the executor as a user message
    workingBody = {
      ...workingBody,
      messages: [
        ...workingBody.messages,
        { role: "assistant", content: blocks },
        { role: "user", content: toolResultBlocks },
      ],
    };
  }

  throw new Error("tool loop exceeded MAX_ITERATIONS");
}

/**
 * Transform the internal tool_use/tool_result blocks into the client-facing
 * server_tool_use/advisor_tool_result blocks that mimic native advisor output.
 */
function transformToAdvisorBlocks(blocks: any[]): any[] {
  // We need to stitch: each tool_use "advisor" block should be followed by
  // an advisor_tool_result block that contains the matching tool_result's
  // text content (which we inserted between executor iterations).
  //
  // But at this point combinedBlocks contains ONLY assistant-side blocks
  // (text, tool_use) — the tool_result blocks were sent as USER messages
  // and never ended up in combinedBlocks. We need a different strategy.
  //
  // Instead, the tool loop should store tool_use_id → advice pairs on the
  // side so we can look up the advice here. Let's handle that in the caller.
  return blocks;
}

/**
 * Full pipeline: take an original client request, run the tool loop, and
 * emit the final client-facing response with advisor-style blocks.
 */
async function processClientRequest(originalBody: any): Promise<any> {
  const { modifiedTools, advisorConfig } = extractAdvisorTool(originalBody.tools);

  if (!advisorConfig) {
    // No advisor tool — just forward as-is
    return await callExecutor(originalBody);
  }

  // Collect tool_use_id → advice as we run the loop so we can emit
  // advisor_tool_result blocks in the final response.
  const adviceByToolUseId = new Map<string, string>();

  const executorBody = { ...originalBody, tools: modifiedTools };
  let workingBody = JSON.parse(JSON.stringify(executorBody));
  const combinedBlocks: any[] = [];
  let iterations = 0;

  for (let iter = 0; iter < 10; iter++) {
    iterations++;
    const execResp = await callExecutor(workingBody);
    const blocks: any[] = execResp.content ?? [];
    const advisorUseBlocks = blocks.filter(
      (b) => b.type === "tool_use" && b.name === advisorConfig.name,
    );

    if (advisorUseBlocks.length === 0 || execResp.stop_reason !== "tool_use") {
      combinedBlocks.push(...blocks);
      break;
    }

    combinedBlocks.push(...blocks);

    const advisorContext = [
      ...workingBody.messages,
      { role: "assistant", content: blocks },
    ];

    const toolResultBlocks: any[] = [];
    for (const toolUse of advisorUseBlocks) {
      const advice = await callThirdPartyAdvisor(advisorContext, advisorConfig.model);
      adviceByToolUseId.set(toolUse.id, advice);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: [{ type: "text", text: advice }],
      });
    }

    workingBody = {
      ...workingBody,
      messages: [
        ...workingBody.messages,
        { role: "assistant", content: blocks },
        { role: "user", content: toolResultBlocks },
      ],
    };
  }

  // Transform combined blocks into the client-facing advisor format.
  // Every tool_use with name="advisor" becomes a pair: server_tool_use
  // followed by advisor_tool_result populated from adviceByToolUseId.
  const clientBlocks: any[] = [];
  for (const block of combinedBlocks) {
    if (block.type === "tool_use" && block.name === advisorConfig.name) {
      clientBlocks.push({
        type: "server_tool_use",
        id: block.id,
        name: "advisor",
        input: {},
      });
      const advice = adviceByToolUseId.get(block.id) ?? "(no advice captured)";
      clientBlocks.push({
        type: "advisor_tool_result",
        tool_use_id: block.id,
        content: { type: "advisor_result", text: advice },
      });
    } else {
      clientBlocks.push(block);
    }
  }

  return {
    id: "msg_proxy_combined",
    type: "message",
    role: "assistant",
    model: originalBody.model,
    content: clientBlocks,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [],
    },
    _proxy_meta: {
      executor_iterations: iterations,
      advisor_calls: adviceByToolUseId.size,
    },
  };
}

function startProxy() {
  return Bun.serve({
    port: PROXY_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as any;
      console.log(`[proxy] incoming /v1/messages — tools: ${(body.tools || []).length}`);

      try {
        const result = await processClientRequest(body);
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      } catch (err: any) {
        console.error(`[proxy] error:`, err);
        return new Response(
          JSON.stringify({ error: { type: "proxy_error", message: String(err) } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Self-test
// ─────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  console.log("\x1b[33m[self-test] starting mock executor, advisor, and proxy...\x1b[0m");
  const execServer = startMockExecutor();
  const advServer = startMockAdvisor();
  const proxyServer = startProxy();

  try {
    await new Promise((r) => setTimeout(r, 100));

    // Non-streaming client request to simplify testing
    const reqBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" },
        // Add a real regular tool too, to ensure we don't break them
        {
          name: "read_file",
          description: "Read a file from disk",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Build a concurrent worker pool in Go with graceful shutdown.",
        },
      ],
    };

    console.log("\n[self-test] sending client request to proxy...");
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const result = (await resp.json()) as any;

    console.log(`\n[self-test] proxy returned status ${resp.status}`);
    console.log(`[self-test] proxy meta:`, result._proxy_meta);
    console.log(`[self-test] content blocks (${result.content?.length ?? 0}):`);
    for (const [i, b] of (result.content ?? []).entries()) {
      let preview: string;
      if (b.type === "text") preview = JSON.stringify(b.text.slice(0, 80));
      else if (b.type === "server_tool_use") preview = `name=${b.name} id=${b.id}`;
      else if (b.type === "advisor_tool_result")
        preview = `advice=${JSON.stringify((b.content?.text ?? "").slice(0, 80))}`;
      else preview = JSON.stringify(b);
      console.log(`  [${i}] ${b.type}: ${preview}`);
    }

    // ─── VALIDATION ───
    // Success criteria:
    //   1. Response has a server_tool_use block for "advisor"
    //   2. Response has an advisor_tool_result block containing the
    //      THIRD-PARTY advice marker (proves the executor actually used it)
    //   3. The final text block quotes the third-party advice
    //      (proves the executor's continuation was informed by our swap)
    //   4. The proxy reported ≥ 1 advisor call
    const blocks: any[] = result.content ?? [];
    const serverToolUse = blocks.find((b) => b.type === "server_tool_use");
    const advisorResult = blocks.find((b) => b.type === "advisor_tool_result");
    const finalText = blocks.filter((b) => b.type === "text").pop();

    const check1 = !!serverToolUse && serverToolUse.name === "advisor";
    const check2 =
      advisorResult?.content?.text?.includes("THIRD_PARTY_ADVICE_MARKER") ?? false;
    const check3 = finalText?.text?.includes("THIRD_PARTY_ADVICE_MARKER") ?? false;
    const check4 = (result._proxy_meta?.advisor_calls ?? 0) >= 1;

    console.log("\n[validation]");
    console.log(`  [${check1 ? "✓" : "✗"}] response has server_tool_use for advisor`);
    console.log(
      `  [${check2 ? "✓" : "✗"}] advisor_tool_result contains third-party advice marker`,
    );
    console.log(
      `  [${check3 ? "✓" : "✗"}] final text quotes third-party advice (executor used it)`,
    );
    console.log(`  [${check4 ? "✓" : "✗"}] proxy recorded ≥1 advisor call`);

    if (check1 && check2 && check3 && check4) {
      console.log(
        "\n\x1b[32m[PASS] Tool-loop advisor replacement works end-to-end:\x1b[0m",
      );
      console.log("  - Proxy replaced advisor_20260301 with a regular tool");
      console.log("  - Executor called the regular tool (as a normal tool_use)");
      console.log("  - Proxy intercepted the call and ran the third-party advisor");
      console.log("  - Proxy fed the third-party advice back to the executor");
      console.log("  - Executor's continuation USED the third-party advice");
      console.log("  - Proxy transformed the combined response to look like native advisor");
      process.exit(0);
    } else {
      console.log("\n\x1b[31m[FAIL] one or more validation checks did not pass\x1b[0m");
      process.exit(1);
    }
  } finally {
    execServer.stop(true);
    advServer.stop(true);
    proxyServer.stop(true);
  }
}
