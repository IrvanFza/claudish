/**
 * Regression pin for Step 5c — Gemini Code Assist OAuth delegation.
 *
 * GeminiCodeAssistProviderTransport.refreshAuth() used to call getValidAccessToken()
 * + setupGeminiUser() directly and build headers / the CodeAssist envelope inline.
 * Step 5 delegates the PRIMARY header + envelope construction to
 * credentials.getRequestAuth("gemini-codeassist"), while KEEPING the local
 * accessToken / projectId / tierId state that the 429 fallback chain and quota
 * logic depend on (request-routing, not auth).
 *
 * This test pins:
 *   - getHeaders() returns the delegated artifact's headers:
 *       Authorization: Bearer <token>, User-Agent: GeminiCLI/..., x-activity-request-id
 *   - transformPayload() returns the delegated CodeAssist envelope:
 *       { model, project, user_prompt_id, request: <inner> }  (+ enabled_credit_types on paid)
 *   - getEndpoint() is unchanged (fixed cloudcode-pa endpoint)
 *   - the queue / 429 classification helpers are untouched (covered elsewhere)
 *
 * Hermetic: mock credentials.getRequestAuth (the delegation target) AND the gemini
 * oauth leaf functions (getValidAccessToken/setupGeminiUser/getGeminiTierDisplayName)
 * that the transport still consults to populate fallback/quota state — both read the
 * SAME values, so behavior is identical to the pre-change inline path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const FAKE_TOKEN = "gemini-oauth-token-123";
const PROJECT_ID = "proj-abc";

// The artifact credentials.getRequestAuth("gemini-codeassist") returns — mirrors
// GeminiCodeAssistCredentialProvider.getRequestAuth() exactly.
function makeAuth(tierId: string) {
  return {
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      "User-Agent": "GeminiCLI/0.5.6/gemini-2.5-pro (darwin; arm64)",
      "x-activity-request-id": "act-fixed-id",
    },
    transformPayload: (inner: any) => {
      const env: any = {
        model: "gemini-2.5-pro",
        project: PROJECT_ID,
        user_prompt_id: "uuid-fixed",
        request: inner,
      };
      if (tierId && tierId !== "free-tier") {
        env.enabled_credit_types = ["GOOGLE_ONE_AI"];
      }
      return env;
    },
  };
}

let currentTier = "free-tier";
let servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash"];
let getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
const originalFetch = globalThis.fetch;

mock.module("../../auth/credentials/authority.js", () => ({
  credentials: {
    getRequestAuth: (name: string, ctx: any) => getRequestAuthMock(name, ctx),
  },
}));

// Leaf oauth functions the transport keeps consulting for fallback/quota state.
mock.module("../../auth/gemini-oauth.js", () => ({
  getValidAccessToken: async () => FAKE_TOKEN,
  setupGeminiUser: async () => ({ projectId: PROJECT_ID, tierId: currentTier }),
  getGeminiTierDisplayName: () => (currentTier === "free-tier" ? "GeminiCA Free" : "GeminiCA Pro"),
  retrieveUserQuota: async () => ({ buckets: [] }),
  getServedCodeAssistModels: async () => servedModelsList.slice(),
  rankCodeAssistModel: (model: string) => {
    if (model.includes("pro")) return 0;
    if (model.includes("flash-lite")) return 2;
    if (model.includes("flash")) return 1;
    return 3;
  },
  CODE_ASSIST_FALLBACK_CHAIN: ["gemini-2.5-pro", "gemini-2.5-flash"],
}));

const { GeminiCodeAssistProviderTransport } = await import("./gemini-codeassist.js");

beforeEach(() => {
  currentTier = "free-tier";
  servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash"];
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("GeminiCodeAssistProviderTransport — delegated auth artifact", () => {
  test("getEndpoint() is unchanged (fixed cloudcode-pa endpoint)", async () => {
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    expect(t.getEndpoint()).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
  });

  test("displayName reflects tier after refreshAuth (status line)", async () => {
    currentTier = "g1-pro-tier";
    getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    expect(t.displayName).toBe("GeminiCA Pro");
  });
});

describe("GeminiCodeAssistProviderTransport — live served set & 404", () => {
  test("rewrites a 404 to an actionable error naming the live served models", async () => {
    currentTier = "g1-pro-tier";
    servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash"];
    const t = new GeminiCodeAssistProviderTransport("gemini-3.6-flash");
    await t.refreshAuth();
    await t.transformPayload({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });

    const response = await t.enqueueRequest(async () => {
      return new Response(
        '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}',
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: number; status: string; message: string };
    };
    const message = body.error.message;
    expect(message).toContain(
      "gemini-3.6-flash is not served by your Gemini Code Assist tier (GeminiCA Pro, via go@)."
    );
    expect(message).toContain("That tier currently serves: gemini-2.5-pro, gemini-2.5-flash.");
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).not.toContain("GOOGLE_GEMINI_API_KEY");
    expect(message.toLowerCase()).not.toContain("free");
    expect(message).toContain("google@gemini-3.6-flash");
  });

  test("passes through a 404 for a served model byte-for-byte", async () => {
    servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash"];
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    await t.transformPayload({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });

    const originalBody =
      '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}';
    const response = await t.enqueueRequest(
      async () =>
        new Response(originalBody, {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
    );

    expect(response.status).toBe(404);
    const responseBody = await response.text();
    expect(responseBody).toBe(originalBody);
    expect(responseBody).toContain("Requested entity was not found.");
    expect(responseBody).not.toContain("not served by");
  });

  test("capacity fallback skips a 404 candidate and continues to a 200", async () => {
    servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    await t.transformPayload({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });

    const responses = [
      new Response(
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      ),
      new Response(
        '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}',
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      ),
      new Response(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}}\n',
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      ),
    ];
    let callCount = 0;
    const fetchFn = async () => responses[callCount++];
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;

    const response = await t.enqueueRequest(fetchFn);

    expect(t.getActiveModelName()).toBeDefined();
    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
  });

  test("rewrites the final 404 when all capacity fallbacks return 404", async () => {
    servedModelsList = ["gemini-2.5-pro", "gemini-2.5-flash"];
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    await t.transformPayload({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });

    const rawNotFound =
      '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}';
    const responses = [
      new Response(
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      ),
      new Response(rawNotFound, {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    let callCount = 0;
    const fetchFn = async () => responses[callCount++];
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;

    const response = await t.enqueueRequest(fetchFn);

    expect(response.status).toBe(404);
    const responseBody = await response.text();
    expect(responseBody).toContain("GEMINI_API_KEY");
    expect(responseBody).not.toContain("Requested entity was not found.");
    expect(callCount).toBe(2);
  });
});
