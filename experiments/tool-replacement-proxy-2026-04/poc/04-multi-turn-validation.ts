#!/usr/bin/env bun
/**
 * PoC Phase 2c: Multi-turn round-trip validation
 *
 * Per the Anthropic advisor docs, clients MUST pass advisor_tool_result
 * blocks back verbatim on subsequent turns, or the API returns a
 * 400 invalid_request_error.
 *
 * This test simulates a two-turn conversation:
 *   Turn 1: user question → proxy fabricates advisor response
 *   Turn 2: user follow-up (with turn-1 advisor blocks in history)
 *           → proxy fabricates another response
 *
 * If the Anthropic SDK can:
 *   (a) round-trip advisor_tool_result blocks back through .content,
 *   (b) send them as input on turn 2 without validation errors,
 *   (c) receive a valid turn-2 response,
 * then our proxy can support multi-turn conversations.
 *
 * Usage:
 *   bun run 02-mock-advisor-proxy.ts &
 *   bun run 04-multi-turn-validation.ts
 */

import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = "http://127.0.0.1:8788";
const client = new Anthropic({ apiKey: "poc-fake", baseURL: BASE_URL, maxRetries: 0 });

const tools = [
  { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" } as any,
];

console.log("\x1b[33m[turn 1] sending initial user message...\x1b[0m");

let turn1: Awaited<ReturnType<typeof client.messages.stream>> extends infer S
  ? S extends { finalMessage(): infer M }
    ? Awaited<M>
    : never
  : never;

try {
  turn1 = await client.messages
    .stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools,
      messages: [{ role: "user", content: "Build a concurrent worker pool in Go." }],
    })
    .finalMessage();
} catch (err: any) {
  console.log(`\x1b[31m[turn 1] FAIL: ${err?.message}\x1b[0m`);
  process.exit(1);
}

console.log(`[turn 1] received ${turn1.content.length} blocks, stop=${turn1.stop_reason}`);
for (const [i, b] of turn1.content.entries()) {
  console.log(`  [${i}] ${(b as any).type}`);
}

// Build turn-2 messages: include the full turn-1 assistant message in history,
// then append a new user message. This is exactly what Claude Code does.
const turn2Messages = [
  { role: "user" as const, content: "Build a concurrent worker pool in Go." },
  { role: "assistant" as const, content: turn1.content },
  { role: "user" as const, content: "Now add a max-in-flight limit of 10." },
];

console.log("\n\x1b[33m[turn 2] sending follow-up (with turn-1 advisor blocks in history)...\x1b[0m");
console.log(`[turn 2] history message count: ${turn2Messages.length}`);
console.log(`[turn 2] assistant message content blocks:`);
for (const [i, b] of turn1.content.entries()) {
  console.log(`  [${i}] ${(b as any).type}`);
}

let turn2: typeof turn1;
let turn2Err: string | undefined;
try {
  turn2 = await client.messages
    .stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools,
      messages: turn2Messages,
    })
    .finalMessage();
} catch (err: any) {
  turn2Err = err?.message || String(err);
  if (err?.error) console.log(`    error body:`, err.error);
  console.log(`\n\x1b[31m[turn 2] FAIL: ${turn2Err}\x1b[0m`);
  process.exit(1);
}

console.log(`\n[turn 2] received ${turn2.content.length} blocks, stop=${turn2.stop_reason}`);

// Validate that the mock server saw the advisor_tool_result in the input
// — the server logs all requests to mock-requests.ndjson.
const serverLog = await Bun.file("logs/mock-requests.ndjson").text();
const lines = serverLog.trim().split("\n").map((l) => JSON.parse(l));
console.log(`\n[validation] mock server received ${lines.length} requests total`);

// The second request should have the advisor_tool_result block in the
// assistant message in its `messages` array.
const lastRequest = lines[lines.length - 1];
const assistantMsg = lastRequest?.messages?.find((m: any) => m.role === "assistant");
const assistantBlocks: any[] = Array.isArray(assistantMsg?.content) ? assistantMsg.content : [];
const hasAdvisorUse = assistantBlocks.some((b: any) => b?.type === "server_tool_use");
const hasAdvisorResult = assistantBlocks.some((b: any) => b?.type === "advisor_tool_result");

console.log(`[validation] turn-2 request assistant blocks:`);
for (const b of assistantBlocks) {
  console.log(`    ${b?.type}`);
}
console.log(`[validation] advisor tool use in request: ${hasAdvisorUse}`);
console.log(`[validation] advisor tool result in request: ${hasAdvisorResult}`);

if (hasAdvisorUse && hasAdvisorResult) {
  console.log("\n\x1b[32m[PASS] Multi-turn round-trip works:\x1b[0m");
  console.log("  - SDK accepted fabricated advisor blocks on turn 1");
  console.log("  - SDK preserved them in the assistant message");
  console.log("  - SDK sent them back verbatim on turn 2 without errors");
  console.log("  - Mock server received turn-2 request with advisor blocks in history");
  process.exit(0);
} else {
  console.log("\n\x1b[31m[FAIL] Multi-turn round-trip did not preserve advisor blocks\x1b[0m");
  process.exit(1);
}
