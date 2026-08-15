#!/usr/bin/env bun
/**
 * idle-probe — throwaway diagnostic for Claude Code's MCP idle timeout.
 *
 * Two tools that run for the SAME duration, differing only in whether the
 * server emits notifications/progress while it works:
 *
 *   silent_sleep   : sleeps SLEEP_MS, emits nothing
 *   progress_sleep : sleeps SLEEP_MS, emits progress every TICK_MS
 *
 * With CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT set well below SLEEP_MS:
 *   silent aborts + progress survives  => progress resets the idle timer
 *   both abort                         => progress is ignored for liveness
 *   both survive                       => the idle timeout never engaged (invalid run)
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LOG_PATH = process.env.IDLE_PROBE_LOG ?? "/tmp/idle-probe.log";
const SLEEP_MS = Number(process.env.IDLE_PROBE_SLEEP_MS ?? 20000);
const TICK_MS = Number(process.env.IDLE_PROBE_TICK_MS ?? 2000);

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // never let logging break the server
  }
  process.stderr.write(`[idle-probe] ${line}\n`);
}

const server = new Server(
  { name: "idle-probe", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log({ event: "tools.list", sleepMs: SLEEP_MS, tickMs: TICK_MS });
  return {
    tools: [
      {
        name: "silent_sleep",
        description: `Sleeps ${SLEEP_MS}ms sending nothing at all, then returns "silent done".`,
        inputSchema: EMPTY_SCHEMA,
      },
      {
        name: "progress_sleep",
        description: `Sleeps ${SLEEP_MS}ms emitting notifications/progress every ${TICK_MS}ms, then returns "progress done".`,
        inputSchema: EMPTY_SCHEMA,
      },
      {
        name: "channel_sleep",
        description: `Sleeps ${SLEEP_MS}ms emitting notifications/claude/channel every ${TICK_MS}ms, then returns "channel done".`,
        inputSchema: EMPTY_SCHEMA,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, _meta } = req.params;
  const progressToken = _meta?.progressToken;
  const startedAt = Date.now();
  log({ event: "call.received", name, progressToken: progressToken ?? null });

  if (name === "silent_sleep") {
    await new Promise((r) => setTimeout(r, SLEEP_MS));
    log({ event: "silent_sleep.responding", elapsedMs: Date.now() - startedAt });
    return { content: [{ type: "text", text: "silent done" }] };
  }

  if (name === "progress_sleep") {
    const ticks = Math.floor(SLEEP_MS / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      await new Promise((r) => setTimeout(r, TICK_MS));
      if (progressToken === undefined) {
        log({ event: "warn.no_progress_token", tick: i + 1 });
        continue;
      }
      const params = { progressToken, progress: i + 1, total: ticks, message: `tick ${i + 1}` };
      try {
        await server.notification({ method: "notifications/progress", params });
        log({ event: "emit.progress", ...params });
      } catch (err) {
        log({ event: "error.emit_failed", err: (err as Error).message });
      }
    }
    log({ event: "progress_sleep.responding", elapsedMs: Date.now() - startedAt });
    return { content: [{ type: "text", text: "progress done" }] };
  }

  if (name === "channel_sleep") {
    const ticks = Math.floor(SLEEP_MS / TICK_MS);
    for (let i = 0; i < ticks; i++) {
      await new Promise((r) => setTimeout(r, TICK_MS));
      const params = {
        content: `tick ${i + 1}`,
        meta: { session_id: "probe0001", event: "running", elapsed_seconds: String((i + 1) * TICK_MS / 1000) },
      };
      try {
        await server.notification({ method: "notifications/claude/channel", params });
        log({ event: "emit.channel", tick: i + 1 });
      } catch (err) {
        log({ event: "error.emit_failed", err: (err as Error).message });
      }
    }
    log({ event: "channel_sleep.responding", elapsedMs: Date.now() - startedAt });
    return { content: [{ type: "text", text: "channel done" }] };
  }

  throw new Error(`unknown tool: ${name}`);
});

process.stdin.on("end", () => log({ event: "stdin.end" }));
process.on("exit", (code) => log({ event: "process.exit", code }));

const transport = new StdioServerTransport();
await server.connect(transport);
log({ event: "server.connected" });
