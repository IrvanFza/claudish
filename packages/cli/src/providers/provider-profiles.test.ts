import { describe, expect, test } from "bun:test";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import { createHandlerForProvider } from "./provider-profiles.js";

interface Composition {
  transport: string;
  streamFormat: string;
  endpoint: string;
}

function describeHandler(providerName: string, modelName: string): Composition {
  const def = getProviderByName(providerName)!;
  const handler: any = createHandlerForProvider({
    provider: toRemoteProvider(def),
    modelName,
    apiKey: "test-key",
    targetModel: modelName,
    port: 1234,
    sharedOpts: {},
  } as any);

  return handler.describeComposition();
}

const expectedCompositions = [
  {
    provider: "opencode-zen-go",
    model: "minimax-m2.5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  },
  {
    provider: "opencode-zen-go",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  },
  {
    provider: "opencode-zen-go",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/go/v1/responses",
  },
  {
    provider: "opencode-zen",
    model: "minimax-m2.5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/v1/responses",
  },
] as const;

describe("OpenCode Zen provider composition", () => {
  for (const row of expectedCompositions) {
    test(`${row.provider} ${row.model} uses ${row.streamFormat} at ${row.endpoint}`, () => {
      expect(describeHandler(row.provider, row.model)).toEqual({
        transport: row.provider,
        streamFormat: row.streamFormat,
        endpoint: row.endpoint,
      });
    });
  }

  for (const provider of ["opencode-zen-go", "opencode-zen"] as const) {
    test(`${provider} pairs MiniMax's OpenAI format with its chat-completions endpoint`, () => {
      const composition = describeHandler(provider, "minimax-m2.5");

      // An Anthropic format paired with a chat-completions endpoint is the exact
      // mismatch that produced the 400. This pins the PAIRING, not either field alone.
      expect(composition.streamFormat).not.toBe("anthropic-sse");
      expect(composition.endpoint.endsWith("/v1/chat/completions")).toBe(true);
    });

    test(`${provider} gives MiniMax the same composition as an ordinary chat model`, () => {
      expect(describeHandler(provider, "minimax-m2.5")).toEqual(describeHandler(provider, "glm-5"));
    });

    // The deleted special case used a case-insensitive MiniMax substring match,
    // so both casing changes and future MiniMax model ids must remain ordinary.
    for (const model of ["MiniMax-M2.5", "minimax-m3"] as const) {
      test(`${provider} has no resurrected MiniMax special case for ${model}`, () => {
        expect(describeHandler(provider, model)).toEqual(describeHandler(provider, "minimax-m2.5"));
      });
    }
  }
});
