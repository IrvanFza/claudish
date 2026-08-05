/**
 * Real-API E2E tests for GLM models via claudish proxy pipeline.
 *
 * Regression guard for #102: zai@glm-* produced 0 output bytes since v6.11.1
 * because matchesModelFamily("zai@glm-4.7", "glm-") falsely matched @glm as a
 * vendor prefix, causing GLMModelDialect to override the anthropic-sse stream
 * format with openai-sse and silently drop all output.
 *
 * These tests exercise the FULL pipeline (not just unit-level DialectManager):
 *   claudish proxy → ComposedHandler → DialectManager → stream format selection
 *   → real HTTP to Z.AI → SSE parser → text extraction
 *
 * If ANY layer regresses, runPromptViaProxy throws "Model returned empty response"
 * which is the exact #102 failure signature.
 *
 * Gated on env vars — skipped in CI / for contributors without keys:
 *   ZAI_API_KEY          → zai@ provider (Anthropic-format endpoint, the #102 path)
 *   GLM_CODING_API_KEY   → gc@ provider (OpenAI-format endpoint, Coding Plan)
 *   ZHIPU_API_KEY        → glm@ provider (standard OpenAI-format endpoint)
 */

import { describe, expect, test } from "bun:test";
import { runPromptViaProxy } from "./mcp-server.js";
import { hasCredential } from "./test-helpers/credential-gate.js";
import {
  PROVIDER_QUOTA_GUIDANCE,
  isConfirmedProviderQuotaError,
} from "./test-helpers/provider-quota.js";

// Asked via claudish's OWN credential authority (env → ~/.claudish/config.json
// apiKeys → 1Password), not raw process.env — these tests must run whenever
// claudish itself could serve the provider, however the user stored the key.
const HAVE_ZAI = await hasCredential("z-ai");
const HAVE_GC = await hasCredential("glm-coding");
const HAVE_GLM = await hasCredential("glm");

const TEST_PROMPT = "Reply with exactly the word: ok";
const TEST_MODEL = "glm-4.6";

// Generous timeout — model cold start + real HTTP round trip
const TEST_TIMEOUT = 60_000;

async function runPromptUnlessAccountDrained(
  model: string,
  providerName: string
): Promise<Awaited<ReturnType<typeof runPromptViaProxy>> | null> {
  try {
    return await runPromptViaProxy(model, TEST_PROMPT);
  } catch (error) {
    if (!isConfirmedProviderQuotaError(error)) throw error;

    console.warn(
      `[zai-glm.e2e] ${providerName} SKIPPED — ${PROVIDER_QUOTA_GUIDANCE}; ` +
        "the provider reported HTTP 429 and/or insufficient balance."
    );
    return null;
  }
}

describe.skipIf(!HAVE_ZAI)("Real API — Z.AI GLM via claudish proxy (#102 regression guard)", () => {
  test(
    `zai@${TEST_MODEL} produces non-empty text through full pipeline`,
    async () => {
      // Direct #102 regression guard: exercises anthropic-sse parser path.
      // Before the fix, matchesModelFamily("zai@glm-4.6", "glm-") → true →
      // GLMModelDialect.getStreamFormat() → "openai-sse" → Anthropic-shape SSE
      // silently dropped → runPromptViaProxy throws "Model returned empty response".
      const result = await runPromptUnlessAccountDrained(`zai@${TEST_MODEL}`, "Z.AI GLM (zai@)");
      if (!result) return;

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      // Must contain actual model text — not just whitespace from a malformed stream
      expect(result.content.trim().length).toBeGreaterThan(0);
      // Sanity: the model should comply with the tiny prompt
      expect(result.content.toLowerCase()).toContain("ok");
      // Sanity: token accounting works (proves the stream delivered usage events)
      expect(result.usage).toBeDefined();
      expect(result.usage!.output).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );
});

describe.skipIf(!HAVE_GC)(
  "Real API — GLM Coding Plan via claudish proxy (openai-sse path coverage)",
  () => {
    test(
      `gc@${TEST_MODEL} produces non-empty text (openai-sse parser path)`,
      async () => {
        // Sibling test: exercises the OpenAI SSE parser path on api.z.ai, catching
        // regressions that break the other stream format while leaving anthropic-sse
        // working. Uses a completely different code path from the zai@ test above.
        const result = await runPromptUnlessAccountDrained(
          `gc@${TEST_MODEL}`,
          "GLM Coding Plan (gc@)"
        );
        if (!result) return;

        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content.trim().length).toBeGreaterThan(0);
        expect(result.content.toLowerCase()).toContain("ok");
        expect(result.usage).toBeDefined();
        expect(result.usage!.output).toBeGreaterThan(0);
      },
      TEST_TIMEOUT
    );
  }
);

describe.skipIf(!HAVE_GLM)("Real API — standard GLM via claudish proxy (Zhipu endpoint)", () => {
  test(
    `glm@${TEST_MODEL} produces non-empty text (zhipu endpoint)`,
    async () => {
      // Third sibling test: standard GLM provider at open.bigmodel.cn.
      // Different host, same OpenAI SSE parser, exercises yet another code path.
      const result = await runPromptUnlessAccountDrained(`glm@${TEST_MODEL}`, "Zhipu GLM (glm@)");
      if (!result) return;

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content.trim().length).toBeGreaterThan(0);
      expect(result.content.toLowerCase()).toContain("ok");
      expect(result.usage).toBeDefined();
      expect(result.usage!.output).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );
});
