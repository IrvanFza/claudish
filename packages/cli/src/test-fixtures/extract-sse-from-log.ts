#!/usr/bin/env bun
/**
 * Extract raw SSE events from claudish debug logs into replay fixture files.
 *
 * Usage:
 *   bun run src/test-fixtures/extract-sse-from-log.ts <debug-log-path> [output-dir] [--allow-corrupt]
 *
 * Parses [SSE:openai] and [SSE:anthropic] log lines, groups them by API turn
 * (bounded by "HANDLER STARTED" / "Calling API" markers), and writes each turn
 * as a standalone .sse fixture file.
 *
 * Output:
 *   <output-dir>/<model>-<format>-turn<N>.sse
 *
 * Example:
 *   bun run src/test-fixtures/extract-sse-from-log.ts logs/claudish_2026-03-17_09-41-32.log
 *   → sse-responses/kimi-k2.5-openai-turn1.sse
 *   → sse-responses/kimi-k2.5-openai-turn2.sse
 *
 * INTEGRITY: every `data:` payload is JSON-parsed before anything is written. A turn
 * containing an unparseable payload is NOT written — the log line is reported by number
 * and the run exits non-zero. A fixture that cannot be parsed is worse than no fixture:
 * the stream parsers swallow `JSON.parse` failures, so the damage shows up much later as
 * a missing tool call or a wrong `stop_reason` and reads like a parser bug. Historically
 * the debug logger itself truncated payloads at 300 chars and produced exactly that.
 *
 * `--allow-corrupt` writes the damaged turns anyway, to `*.corrupt.sse` (never the plain
 * name), for inspecting a broken capture. Such a file must never be used as a fixture.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sentinel appended by the stream parsers when a payload exceeded their (1M char)
 * log ceiling. Kept as a literal so this script stays dependency-free; if it ever
 * drifts from `SSE_LOG_TRUNCATION_MARKER` in openai-sse.ts we lose only the nicer
 * message — the JSON.parse check below still catches the event.
 */
const TRUNCATION_MARKER = "<<<CLAUDISH_SSE_TRUNCATED>>>";

const args = process.argv.slice(2);
const allowCorrupt = args.includes("--allow-corrupt");
const positional = args.filter((a) => !a.startsWith("--"));

const logFile = positional[0];
if (!logFile) {
  console.error(
    "Usage: bun run extract-sse-from-log.ts <debug-log-path> [output-dir] [--allow-corrupt]"
  );
  process.exit(1);
}

const outputDir =
  positional[1] || join(dirname(new URL(import.meta.url).pathname), "sse-responses");
mkdirSync(outputDir, { recursive: true });

const content = readFileSync(logFile, "utf-8");
const lines = content.split("\n");

// Detect model name from first HANDLER STARTED or AnthropicSSE line
let model = "unknown";
for (const line of lines) {
  const handlerMatch = line.match(/HANDLER STARTED for (.+?) =====/);
  if (handlerMatch) {
    model = handlerMatch[1].replace(/\//g, "-");
    break;
  }
  const anthropicMatch = line.match(/Stream complete for (.+?):/);
  if (anthropicMatch) {
    model = anthropicMatch[1].replace(/\//g, "-");
    break;
  }
}

console.log(`Log file: ${logFile}`);
console.log(`Model: ${model}`);
console.log(`Output dir: ${outputDir}`);

/** One `data:` payload, with the log line it came from so failures can be located. */
interface Event {
  data: string;
  /** 1-based line number in the source debug log. */
  line: number;
}

interface Turn {
  format: "openai" | "anthropic";
  events: Event[];
}

const turns: Turn[] = [];
let currentTurn: Turn | null = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNo = i + 1;

  // New API turn boundary (OpenAI format)
  if (line.includes("HANDLER STARTED")) {
    if (currentTurn && currentTurn.events.length > 0) {
      turns.push(currentTurn);
    }
    currentTurn = { format: "openai", events: [] };
    continue;
  }

  // New API turn boundary (Anthropic format)
  if (line.includes("Calling API:") && !currentTurn?.format) {
    if (currentTurn && currentTurn.events.length > 0) {
      turns.push(currentTurn);
    }
    currentTurn = { format: "anthropic", events: [] };
    continue;
  }

  // OpenAI SSE line
  const openaiMatch = line.match(/\[SSE:openai\] (.+)/);
  if (openaiMatch) {
    if (!currentTurn) {
      currentTurn = { format: "openai", events: [] };
    }
    currentTurn.events.push({ data: openaiMatch[1], line: lineNo });
    continue;
  }

  // Anthropic SSE line
  const anthropicMatch = line.match(/\[SSE:anthropic\] (.+)/);
  if (anthropicMatch) {
    if (!currentTurn) {
      currentTurn = { format: "anthropic", events: [] };
    }
    currentTurn.format = "anthropic";
    currentTurn.events.push({ data: anthropicMatch[1], line: lineNo });
  }
}

// Push last turn
if (currentTurn && currentTurn.events.length > 0) {
  turns.push(currentTurn);
}

/**
 * `[DONE]` is the SSE terminator, not JSON — the only payload allowed not to parse.
 */
function isSentinelPayload(data: string): boolean {
  return data.trim() === "[DONE]";
}

interface CorruptEvent {
  line: number;
  data: string;
  reason: string;
}

function findCorruptEvents(events: Event[]): CorruptEvent[] {
  const bad: CorruptEvent[] = [];
  for (const event of events) {
    if (isSentinelPayload(event.data)) continue;
    if (event.data.includes(TRUNCATION_MARKER)) {
      bad.push({
        line: event.line,
        data: event.data,
        reason: `payload exceeded the logger's ceiling and was cut (${TRUNCATION_MARKER})`,
      });
      continue;
    }
    try {
      JSON.parse(event.data);
    } catch (e) {
      bad.push({
        line: event.line,
        data: event.data,
        reason: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return bad;
}

function parseEvent(data: string): any | null {
  if (isSentinelPayload(data)) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Write fixture files
let written = 0;
let corruptTurns = 0;

for (let i = 0; i < turns.length; i++) {
  const turn = turns[i];
  const base = `${model}-${turn.format}-turn${i + 1}`;
  const corrupt = findCorruptEvents(turn.events);

  if (corrupt.length > 0) {
    corruptTurns++;
    console.error(
      `\n  ✗ ${base}: ${corrupt.length}/${turn.events.length} event(s) are NOT valid JSON — this capture is corrupt.`
    );
    for (const bad of corrupt.slice(0, 10)) {
      console.error(`      ${logFile}:${bad.line}: ${bad.reason}`);
      console.error(`        payload (${bad.data.length} chars): ${bad.data.slice(0, 120)}…`);
    }
    if (corrupt.length > 10) {
      console.error(`      … and ${corrupt.length - 10} more`);
    }

    if (!allowCorrupt) {
      console.error(
        "      NOT WRITTEN. Re-capture the log with a claudish build that logs SSE payloads verbatim,\n" +
          "      then re-run. Do NOT hand-repair the JSON — fixtures must come from real logs.\n" +
          `      To inspect the damaged capture anyway: re-run with --allow-corrupt (writes ${base}.corrupt.sse).`
      );
      continue;
    }

    const corruptPath = join(outputDir, `${base}.corrupt.sse`);
    writeFileSync(
      corruptPath,
      `${turn.events.map((e) => `data: ${e.data}\n`).join("\n")}\n`,
      "utf-8"
    );
    console.error(`      --allow-corrupt: wrote ${base}.corrupt.sse — NOT usable as a fixture.`);
    continue;
  }

  const filename = `${base}.sse`;
  const filepath = join(outputDir, filename);
  const sseContent = `${turn.events.map((e) => `data: ${e.data}\n`).join("\n")}\n`;
  writeFileSync(filepath, sseContent, "utf-8");
  written++;

  const textChunks = turn.events.filter((e) => {
    const parsed = parseEvent(e.data);
    if (!parsed) return false;
    // OpenAI format
    if (parsed.choices?.[0]?.delta?.content) return true;
    // Anthropic format
    if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") return true;
    return false;
  }).length;

  const toolCalls = turn.events.filter((e) => {
    const parsed = parseEvent(e.data);
    if (!parsed) return false;
    if (parsed.choices?.[0]?.delta?.tool_calls) return true;
    if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use")
      return true;
    return false;
  }).length;

  console.log(
    `  ${filename}: ${turn.events.length} events, ${textChunks} text chunks, ${toolCalls} tool calls`
  );
}

console.log(`\nWrote ${written} fixture file(s) to ${outputDir}`);

if (written === 0 && corruptTurns === 0) {
  console.log("\nNo [SSE:openai] or [SSE:anthropic] lines found in log.");
  console.log(
    "Make sure the log was captured with claudish v5.13.2+ (which includes raw SSE logging)."
  );
  console.log("Re-run with: claudish --model <model> --debug-claudish ...");
}

if (corruptTurns > 0) {
  console.error(
    `\n${corruptTurns} turn(s) contained unparseable SSE payloads. ` +
      `${allowCorrupt ? "Written as *.corrupt.sse — do not commit them as fixtures." : "Nothing was written for them."}`
  );
  process.exit(1);
}
