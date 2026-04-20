#!/usr/bin/env bun
/**
 * PoC Phase 2b: Validate mock proxy against the real Anthropic SDK
 *
 * This is the strongest validation short of running Claude Code itself:
 * we point the real `@anthropic-ai/sdk` client at our mock proxy and
 * see whether it successfully parses our fabricated events into the
 * expected message shape.
 *
 * If the SDK accepts our events, Claude Code (which wraps this same SDK)
 * almost certainly will too.
 *
 * Usage:
 *   bun run 02-mock-advisor-proxy.ts &   # start mock server on 8788
 *   bun run 03-sdk-validation.ts
 */

import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = "http://127.0.0.1:8788";

const client = new Anthropic({
  apiKey: "poc-fake-key",
  baseURL: BASE_URL,
  // Disable retries so test failures surface immediately instead of looping
  maxRetries: 0,
});

console.log("\x1b[33m[sdk-test] creating streaming message via Anthropic SDK...\x1b[0m");
console.log(`[sdk-test] baseURL: ${BASE_URL}`);

let ok = false;
let errorMsg: string | undefined;

try {
  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [
      // The SDK type may not include advisor_20260301 yet; cast to any to
      // bypass TS validation — we're testing the *wire format*, not types.
      {
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-opus-4-6",
      } as any,
    ],
    messages: [
      { role: "user", content: "Build a concurrent worker pool in Go with graceful shutdown." },
    ],
  });

  // Consume the stream and log every event
  let eventCount = 0;
  stream.on("streamEvent", (event: any) => {
    eventCount++;
    console.log(`  [${eventCount}] ${event.type}`);
    if (event.type === "content_block_start") {
      console.log(`      └─ block[${event.index}] type=${event.content_block?.type} ${formatBlock(event.content_block)}`);
    }
  });

  const finalMessage = await stream.finalMessage();

  console.log("\n\x1b[33m[sdk-test] final message from SDK:\x1b[0m");
  console.log(`  id: ${finalMessage.id}`);
  console.log(`  role: ${finalMessage.role}`);
  console.log(`  model: ${finalMessage.model}`);
  console.log(`  stop_reason: ${finalMessage.stop_reason}`);
  console.log(`  content block count: ${finalMessage.content.length}`);

  for (let i = 0; i < finalMessage.content.length; i++) {
    const b: any = finalMessage.content[i];
    let preview: string;
    if (b.type === "text") preview = JSON.stringify(b.text.slice(0, 60));
    else if (b.type === "server_tool_use") preview = `name=${b.name} id=${b.id}`;
    else if (b.type === "advisor_tool_result")
      preview = `tool_use_id=${b.tool_use_id} text=${JSON.stringify((b.content?.text ?? "").slice(0, 60))}`;
    else preview = JSON.stringify(b).slice(0, 80);
    console.log(`  [${i}] ${b.type}: ${preview}`);
  }

  // Validate: did the SDK successfully parse our custom blocks?
  const hasAdvisorUse = finalMessage.content.some((b: any) => b.type === "server_tool_use");
  const hasAdvisorResult = finalMessage.content.some((b: any) => b.type === "advisor_tool_result");
  ok = hasAdvisorUse && hasAdvisorResult && finalMessage.stop_reason === "end_turn";

  if (ok) {
    console.log("\n\x1b[32m[sdk-test] ✅ PASS: Anthropic SDK accepted our fabricated advisor events\x1b[0m");
  } else {
    console.log("\n\x1b[31m[sdk-test] ❌ FAIL: SDK parsed the stream but content is missing\x1b[0m");
    console.log(`    hasAdvisorUse=${hasAdvisorUse} hasAdvisorResult=${hasAdvisorResult}`);
  }
} catch (err: any) {
  errorMsg = err?.message || String(err);
  console.log(`\n\x1b[31m[sdk-test] ❌ FAIL: SDK threw an error\x1b[0m`);
  console.log(`    ${errorMsg}`);
  if (err?.status) console.log(`    HTTP status: ${err.status}`);
  if (err?.error) console.log(`    error body:`, err.error);
  if (err?.cause) console.log(`    cause:`, err.cause);
}

process.exit(ok ? 0 : 1);

function formatBlock(b: any): string {
  if (!b) return "";
  if (b.type === "text") return `text=${JSON.stringify((b.text ?? "").slice(0, 40))}`;
  if (b.type === "server_tool_use") return `name=${b.name} id=${b.id}`;
  if (b.type === "advisor_tool_result") return `tool_use_id=${b.tool_use_id}`;
  return JSON.stringify(b).slice(0, 80);
}
