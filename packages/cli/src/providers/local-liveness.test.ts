import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { localBaseUrl, pingLocalProvider } from "./local-liveness.js";

describe("localBaseUrl", () => {
  const ENVS = ["OLLAMA_BASE_URL", "OLLAMA_HOST", "LMSTUDIO_BASE_URL"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const e of ENVS) {
      saved[e] = process.env[e];
      delete process.env[e];
    }
  });
  afterEach(() => {
    for (const e of ENVS) {
      if (saved[e] === undefined) delete process.env[e];
      else process.env[e] = saved[e];
    }
  });

  test("returns the catalog default for a local provider with no env override", () => {
    expect(localBaseUrl("ollama")).toBe("http://localhost:11434");
    expect(localBaseUrl("lmstudio")).toBe("http://localhost:1234");
  });

  test("honors an env-var override (first in catalog order wins)", () => {
    process.env.OLLAMA_BASE_URL = "http://gpu-box:11434/";
    // trailing slash trimmed
    expect(localBaseUrl("ollama")).toBe("http://gpu-box:11434");
  });

  test("falls through to the second env var when the first is unset", () => {
    process.env.OLLAMA_HOST = "http://other-host:11434";
    expect(localBaseUrl("ollama")).toBe("http://other-host:11434");
  });

  test("returns null for a non-local / unknown provider", () => {
    expect(localBaseUrl("openrouter")).toBeNull();
    expect(localBaseUrl("does-not-exist")).toBeNull();
  });
});

describe("pingLocalProvider", () => {
  test("'unknown' for a provider that isn't a known local one", async () => {
    expect(await pingLocalProvider("openrouter")).toBe("unknown");
    expect(await pingLocalProvider("does-not-exist")).toBe("unknown");
  });

  test("'down' for a local pointed at an unreachable host (short timeout)", async () => {
    const saved = process.env.OLLAMA_BASE_URL;
    // A reserved-for-docs IP (TEST-NET-1) — connections never complete.
    process.env.OLLAMA_BASE_URL = "http://192.0.2.1:11434";
    try {
      // Tight timeout so the test is fast; an unreachable host yields "down".
      expect(await pingLocalProvider("ollama", 300)).toBe("down");
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = saved;
    }
  });
});
