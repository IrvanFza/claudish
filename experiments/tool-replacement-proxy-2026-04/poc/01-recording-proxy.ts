#!/usr/bin/env bun
/**
 * PoC Phase 1: Recording Proxy
 *
 * Minimal passthrough proxy that:
 *   1. Receives requests on localhost:8787
 *   2. Logs them to ./logs/request-{N}.json
 *   3. Forwards to https://api.anthropic.com (preserving all headers)
 *   4. Streams response back, logging raw SSE events to ./logs/response-{N}.ndjson
 *
 * Usage:
 *   bun run 01-recording-proxy.ts
 *   # In another terminal:
 *   export ANTHROPIC_BASE_URL=http://localhost:8787
 *   export ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY  # or your real key
 *   claude
 *
 * Goal: capture a real advisor tool request from Claude Code so we know
 * the exact wire format before attempting to fabricate one.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "logs");
mkdirSync(LOG_DIR, { recursive: true });

const UPSTREAM = "https://api.anthropic.com";
const PORT = 8787;

let requestCounter = 0;

// Log a line to a run-wide index file for easy inspection
const indexPath = join(LOG_DIR, "index.ndjson");

function logIndex(entry: Record<string, unknown>) {
  appendFileSync(indexPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Long idle/request timeouts: Claude Code sessions can be long
  idleTimeout: 255,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const n = ++requestCounter;
    const tag = `${n.toString().padStart(4, "0")}-${url.pathname.replace(/[^a-zA-Z0-9]/g, "_")}`;

    // Capture the request body (if any) — we need to clone because we also
    // forward it upstream.
    const bodyText = req.body ? await req.text() : "";
    const headers = Object.fromEntries(req.headers.entries());

    const reqLogPath = join(LOG_DIR, `req-${tag}.json`);
    writeFileSync(
      reqLogPath,
      JSON.stringify(
        {
          method: req.method,
          url: req.url,
          pathname: url.pathname,
          headers,
          body: bodyText ? safeParseJSON(bodyText) : null,
          bodyRaw: bodyText.length < 100_000 ? bodyText : `<${bodyText.length} bytes>`,
        },
        null,
        2,
      ),
    );

    // Quick scan: does this request contain the advisor tool? Flag it loudly.
    const hasAdvisor = bodyText.includes("advisor_20260301") || bodyText.includes("advisor-tool-2026");
    const betaHeader = headers["anthropic-beta"] || "";
    logIndex({
      n,
      method: req.method,
      path: url.pathname,
      hasAdvisor,
      betaHeader,
      contentLength: bodyText.length,
    });

    if (hasAdvisor) {
      console.log(`\x1b[32m[${n}] 🎯 ADVISOR REQUEST CAPTURED → ${reqLogPath}\x1b[0m`);
    } else {
      console.log(`[${n}] ${req.method} ${url.pathname} (beta=${betaHeader || "none"})`);
    }

    // Forward upstream. Rebuild URL against the real Anthropic host.
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // Forward headers but drop hop-by-hop + the Host header (fetch sets it).
    // Also translate bearer auth → x-api-key when the token is an sk-ant-*
    // API key (Claude Code sets ANTHROPIC_AUTH_TOKEN → Authorization: Bearer,
    // but /v1/messages expects x-api-key for API keys).
    const fwdHeaders = new Headers();
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (["host", "connection", "content-length"].includes(lk)) continue;
      if (lk === "authorization" && v.startsWith("Bearer sk-ant-api")) {
        const key = v.slice("Bearer ".length);
        fwdHeaders.set("x-api-key", key);
        continue; // skip writing authorization
      }
      fwdHeaders.set(k, v);
    }

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: bodyText || undefined,
      });
    } catch (err) {
      console.error(`[${n}] upstream fetch failed:`, err);
      return new Response(JSON.stringify({ error: { type: "proxy_error", message: String(err) } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const respLogPath = join(LOG_DIR, `resp-${tag}.ndjson`);
    const respMetaPath = join(LOG_DIR, `resp-${tag}.meta.json`);
    writeFileSync(
      respMetaPath,
      JSON.stringify(
        {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: Object.fromEntries(upstreamResp.headers.entries()),
        },
        null,
        2,
      ),
    );

    // Tee the upstream stream: write raw bytes to disk AND pipe to client.
    if (!upstreamResp.body) {
      return new Response(null, {
        status: upstreamResp.status,
        headers: upstreamResp.headers,
      });
    }

    const [teeForClient, teeForDisk] = upstreamResp.body.tee();

    // Write the disk copy in the background. Parse as SSE so the log is
    // easy to read for humans.
    (async () => {
      const reader = teeForDisk.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawAdvisor = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Split by blank line (SSE event boundary)
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const evt = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const parsed = parseSSE(evt);
            if (parsed) {
              appendFileSync(respLogPath, JSON.stringify(parsed) + "\n");
              if (parsed.data && typeof parsed.data === "object") {
                const s = JSON.stringify(parsed.data);
                if (s.includes("advisor") || s.includes("server_tool_use")) {
                  if (!sawAdvisor) {
                    console.log(`\x1b[35m[${n}] 🧠 ADVISOR EVENT in stream → ${respLogPath}\x1b[0m`);
                    sawAdvisor = true;
                  }
                }
              }
            }
          }
        }
        if (buf.trim()) {
          const parsed = parseSSE(buf);
          if (parsed) appendFileSync(respLogPath, JSON.stringify(parsed) + "\n");
        }
      } catch (err) {
        appendFileSync(respLogPath, JSON.stringify({ proxyError: String(err) }) + "\n");
      }
    })();

    // Bun auto-decompresses response bodies, so the bytes we're forwarding
    // are plaintext. We MUST strip content-encoding (gzip/br/zstd) and
    // content-length (now wrong) before handing headers to the client —
    // otherwise the client tries to gunzip plaintext and throws ZlibError.
    const clientHeaders = new Headers(upstreamResp.headers);
    clientHeaders.delete("content-encoding");
    clientHeaders.delete("content-length");

    return new Response(teeForClient, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: clientHeaders,
    });
  },
});

console.log(`\x1b[36m┌─ Recording proxy listening on http://${server.hostname}:${server.port}\x1b[0m`);
console.log(`\x1b[36m│  Logs → ${LOG_DIR}\x1b[0m`);
console.log(`\x1b[36m│  Run Claude Code with:\x1b[0m`);
console.log(`\x1b[36m│    export ANTHROPIC_BASE_URL=http://127.0.0.1:${server.port}\x1b[0m`);
console.log(`\x1b[36m│    export ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY\x1b[0m`);
console.log(`\x1b[36m└─  (keep ANTHROPIC_API_KEY blank if using AUTH_TOKEN)\x1b[0m`);

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _parseError: true, raw: s.slice(0, 500) };
  }
}

interface SSEEvent {
  event?: string;
  data?: unknown;
}

function parseSSE(block: string): SSEEvent | null {
  const lines = block.split("\n");
  const out: SSEEvent = {};
  for (const line of lines) {
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const raw = line.slice(5).trim();
      if (raw) out.data = safeParseJSON(raw);
    }
  }
  return out.event || out.data !== undefined ? out : null;
}
