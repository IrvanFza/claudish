import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { log, logStderr } from "./logger.js";

const realConsoleError = console.error;
const realStderrWrite = process.stderr.write;

afterEach(() => {
  console.error = realConsoleError;
  process.stderr.write = realStderrWrite;
});

describe("proxy unhandled-error backstop", () => {
  test("returns a single-line Anthropic JSON 500 without console.error", async () => {
    const app = new Hono();

    // Keep this body identical to createProxyServer's onError backstop. Using
    // app.request avoids binding a local port while still exercising Hono's
    // actual unhandled-route rejection path.
    app.onError((err, c) => {
      logStderr(`[Proxy] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.message ?? err}`);
      log(`[Proxy] Unhandled error stack: ${err?.stack ?? "(no stack)"}`);
      return c.json(wrapAnthropicError(500, `Proxy error: ${err?.message ?? String(err)}`), 500);
    });
    app.get("/unhandled", () => {
      throw new Error("first line\n\tsecond line\u0007");
    });

    const consoleErrors: unknown[][] = [];
    const stderrLines: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const response = await app.request("http://claudish.test/unhandled");
      const raw = await response.text();
      const body = JSON.parse(raw);

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toBe("Proxy error: first line second line");
      expect(body.error.message).not.toMatch(/[\r\n\t]/);
      expect(raw).not.toBe("Internal Server Error");
      expect(consoleErrors).toEqual([]);
      expect(stderrLines.join("")).toContain("Unhandled error");
    } finally {
      console.error = realConsoleError;
      process.stderr.write = realStderrWrite;
    }
  });
});
