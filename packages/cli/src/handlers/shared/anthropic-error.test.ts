import { describe, it, expect } from "bun:test";
import {
  statusToErrorType,
  wrapAnthropicError,
  ensureAnthropicErrorFormat,
} from "./anthropic-error.js";

describe("statusToErrorType", () => {
  it("maps 400 to invalid_request_error", () => {
    expect(statusToErrorType(400)).toBe("invalid_request_error");
  });

  it("maps 401 to authentication_error", () => {
    expect(statusToErrorType(401)).toBe("authentication_error");
  });

  it("maps 403 to permission_error", () => {
    expect(statusToErrorType(403)).toBe("permission_error");
  });

  it("maps 404 to not_found_error", () => {
    expect(statusToErrorType(404)).toBe("not_found_error");
  });

  it("maps 429 to rate_limit_error", () => {
    expect(statusToErrorType(429)).toBe("rate_limit_error");
  });

  it("maps 503 to overloaded_error", () => {
    expect(statusToErrorType(503)).toBe("overloaded_error");
  });

  it("maps 529 to overloaded_error", () => {
    expect(statusToErrorType(529)).toBe("overloaded_error");
  });

  it("maps 500 to api_error", () => {
    expect(statusToErrorType(500)).toBe("api_error");
  });

  it("maps unknown status codes to api_error", () => {
    expect(statusToErrorType(502)).toBe("api_error");
    expect(statusToErrorType(418)).toBe("api_error");
  });
});

describe("wrapAnthropicError", () => {
  it("creates a valid Anthropic error envelope", () => {
    const result = wrapAnthropicError(500, "Something went wrong");
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Something went wrong" },
    });
  });

  it("infers error type from status code", () => {
    const result = wrapAnthropicError(429, "Too many requests");
    expect(result.error.type).toBe("rate_limit_error");
  });

  it("allows overriding error type", () => {
    const result = wrapAnthropicError(503, "Server down", "connection_error");
    expect(result).toEqual({
      type: "error",
      error: { type: "connection_error", message: "Server down" },
    });
  });

  it("uses status-derived type when errorType is undefined", () => {
    const result = wrapAnthropicError(401, "Bad key", undefined);
    expect(result.error.type).toBe("authentication_error");
  });
});

describe("ensureAnthropicErrorFormat", () => {
  it("passes through a valid Anthropic error envelope", () => {
    const valid = {
      type: "error" as const,
      error: { type: "invalid_request_error" as const, message: "Bad request" },
    };
    const result = ensureAnthropicErrorFormat(400, valid);
    expect(result).toEqual(valid);
  });

  it("wraps partial format (missing outer type)", () => {
    const partial = {
      error: { type: "authentication_error", message: "Invalid key" },
    };
    const result = ensureAnthropicErrorFormat(401, partial);
    expect(result).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid key" },
    });
  });

  it("wraps OpenAI error format", () => {
    const openaiError = {
      error: { message: "Model not found", code: "model_not_found" },
    };
    const result = ensureAnthropicErrorFormat(404, openaiError);
    expect(result.type).toBe("error");
    expect(result.error.message).toBe("Model not found");
  });

  it("wraps a raw string body", () => {
    const result = ensureAnthropicErrorFormat(500, "Internal Server Error");
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Internal Server Error" },
    });
  });

  it("wraps null body", () => {
    const result = ensureAnthropicErrorFormat(500, null);
    expect(result.type).toBe("error");
    expect(result.error.type).toBe("api_error");
    expect(typeof result.error.message).toBe("string");
  });

  it("wraps undefined body", () => {
    const result = ensureAnthropicErrorFormat(500, undefined);
    expect(result.type).toBe("error");
    expect(result.error.type).toBe("api_error");
    expect(typeof result.error.message).toBe("string");
  });

  it("extracts message from nested error object", () => {
    const body = { error: { message: "Rate limit exceeded" } };
    const result = ensureAnthropicErrorFormat(429, body);
    expect(result.error.message).toBe("Rate limit exceeded");
    expect(result.error.type).toBe("rate_limit_error");
  });

  it("extracts message from top-level message field", () => {
    const body = { message: "Something went wrong", code: "server_error" };
    const result = ensureAnthropicErrorFormat(500, body);
    expect(result.error.message).toBe("Something went wrong");
  });

  it("preserves provider error type when present", () => {
    const body = { error: "some raw error", type: "overloaded_error" };
    const result = ensureAnthropicErrorFormat(503, body);
    expect(result.error.type).toBe("overloaded_error");
  });
});
