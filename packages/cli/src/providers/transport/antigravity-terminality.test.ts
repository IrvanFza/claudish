// These bodies are CANONICAL google.rpc shapes constructed from Google's published error model, NOT captured from a live Antigravity 429—no such capture exists in this repo.

import { describe, expect, test } from "bun:test";
import { AntigravityProviderTransport } from "./antigravity.js";

const RESOURCE_EXHAUSTED_MESSAGE = "Resource has been exhausted (e.g. check quota).";
const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const QUOTA_FAILURE_TYPE = "type.googleapis.com/google.rpc.QuotaFailure";

type GoogleRpcDetail = Record<string, unknown>;

function errorInfo(reason: string): GoogleRpcDetail {
  return {
    "@type": ERROR_INFO_TYPE,
    reason,
  };
}

function retryInfo(retryDelay: string): GoogleRpcDetail {
  return {
    "@type": RETRY_INFO_TYPE,
    retryDelay,
  };
}

function quotaFailure(quotaId: string, description: string): GoogleRpcDetail {
  return {
    "@type": QUOTA_FAILURE_TYPE,
    violations: [{ quotaId, description }],
  };
}

function googleRpcBody(details?: GoogleRpcDetail[], arrayWrapped = false): string {
  const payload = {
    error: {
      code: 429,
      message: RESOURCE_EXHAUSTED_MESSAGE,
      status: "RESOURCE_EXHAUSTED",
      ...(details === undefined ? {} : { details }),
    },
  };

  return JSON.stringify(arrayWrapped ? [payload] : payload);
}

describe("AntigravityProviderTransport.classifyTerminalError", () => {
  const transport = new AntigravityProviderTransport("gemini-3.6-flash");

  test("returns undefined for status 500 even when the body says quota", () => {
    const body = googleRpcBody([errorInfo("QUOTA_EXHAUSTED")]);

    expect(transport.classifyTerminalError(500, body)).toBeUndefined();
  });

  test("returns undefined for an unparseable 429 body", () => {
    expect(transport.classifyTerminalError(429, RESOURCE_EXHAUSTED_MESSAGE)).toBeUndefined();
  });

  test("treats ErrorInfo QUOTA_EXHAUSTED as terminal", () => {
    const body = googleRpcBody([errorInfo("QUOTA_EXHAUSTED")]);

    expect(transport.classifyTerminalError(429, body)).toBe(true);
  });

  test("treats ErrorInfo RATE_LIMIT_EXCEEDED as retryable", () => {
    const body = googleRpcBody([errorInfo("RATE_LIMIT_EXCEEDED"), retryInfo("2s")]);

    expect(transport.classifyTerminalError(429, body)).toBe(false);
  });

  test("treats ErrorInfo MODEL_CAPACITY_EXHAUSTED as retryable at the handler boundary", () => {
    const body = googleRpcBody([errorInfo("MODEL_CAPACITY_EXHAUSTED"), retryInfo("1.5s")]);

    expect(transport.classifyTerminalError(429, body)).toBe(false);
  });

  test("treats per-day and daily QuotaFailure violations as terminal", () => {
    const perDayBody = googleRpcBody([
      quotaFailure(
        "GenerateRequestsPerDayPerProjectPerModel",
        "Requests per day per project per model"
      ),
    ]);
    const dailyBody = googleRpcBody([
      quotaFailure("GenerateRequestsPerProject", "Daily request allowance exhausted"),
    ]);

    expect(transport.classifyTerminalError(429, perDayBody)).toBe(true);
    expect(transport.classifyTerminalError(429, dailyBody)).toBe(true);
  });

  test("treats per-minute QuotaFailure violations as retryable", () => {
    const body = googleRpcBody([
      quotaFailure(
        "GenerateRequestsPerMinutePerProjectPerModel",
        "Requests per minute per project per model"
      ),
    ]);

    expect(transport.classifyTerminalError(429, body)).toBe(false);
  });

  test("treats a bare RESOURCE_EXHAUSTED body with no details as retryable", () => {
    const body = googleRpcBody();

    expect(transport.classifyTerminalError(429, body)).toBe(false);
  });

  test("classifies an array-wrapped streaming body the same as the unwrapped body", () => {
    const details = [errorInfo("RATE_LIMIT_EXCEEDED"), retryInfo("2s")];
    const unwrappedVerdict = transport.classifyTerminalError(429, googleRpcBody(details));
    const wrappedVerdict = transport.classifyTerminalError(429, googleRpcBody(details, true));

    expect(unwrappedVerdict).toBe(false);
    expect(wrappedVerdict).toBe(unwrappedVerdict);
  });
});

describe("AntigravityProviderTransport auth recovery contract", () => {
  test("opts into ComposedHandler's 401 recovery hook", () => {
    // This provider silently omitted the hook, so a server-invalidated session with
    // a future local expiry had no recovery path even though every other layer was correct.
    // Deleting the method must therefore fail a test instead of becoming unchecked behavior.
    const transport = new AntigravityProviderTransport("gemini-3.6-flash");

    expect(typeof transport.forceRefreshAuth).toBe("function");
  });
});
