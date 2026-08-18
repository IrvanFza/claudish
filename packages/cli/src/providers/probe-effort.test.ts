import { afterEach, describe, expect, test } from "bun:test";
import { probeLink } from "./probe-live.js";

interface CapturedProbeBody {
  output_config?: {
    effort?: string;
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function captureProbeBody(provider: string): Promise<CapturedProbeBody> {
  let captured: CapturedProbeBody | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const rawBody = init?.body;
    if (typeof rawBody !== "string") {
      throw new Error("Expected probe request body to be JSON text");
    }
    captured = JSON.parse(rawBody) as CapturedProbeBody;
    return new Response("{}", {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await probeLink(
    "http://proxy.test",
    {
      provider,
      modelSpec: `${provider}@test-model`,
      hasCredentials: true,
    },
    1000
  );

  if (!captured) throw new Error("probeLink did not call fetch");
  return captured;
}

describe("probeLink effort selection", () => {
  test("native-anthropic sends low effort", async () => {
    const body = await captureProbeBody("native-anthropic");

    expect(body.output_config?.effort).toBe("low");
  });

  test("anthropic sends low effort", async () => {
    const body = await captureProbeBody("anthropic");

    expect(body.output_config?.effort).toBe("low");
  });

  test("OpenAI-style providers keep minimal effort", async () => {
    for (const provider of ["openai", "openrouter"]) {
      const body = await captureProbeBody(provider);
      expect(body.output_config?.effort).toBe("minimal");
    }
  });

  test("never sends literal minimal to an unsupported provider", async () => {
    for (const provider of ["native-anthropic", "anthropic"]) {
      const body = await captureProbeBody(provider);
      expect(body.output_config?.effort).not.toBe("minimal");
    }
  });
});
