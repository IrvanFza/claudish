import { describe, expect, test } from "bun:test";
import { hasModelUnsupportedWording } from "./model-unsupported.js";

const UNSUPPORTED_PHRASES = [
  "not supported",
  "unsupported model",
  "unsupported_model",
  "model not found",
  "model_not_found",
  "unknown model",
  "no such model",
] as const;

function anthropicErrorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

describe("hasModelUnsupportedWording", () => {
  test("matches every supported phrase case-insensitively inside a realistic error body", () => {
    for (const phrase of UNSUPPORTED_PHRASES) {
      const body = anthropicErrorBody(
        "invalid_request_error",
        `OpenCode Zen Go rejected deepseek-v4-pro-0813: ${phrase.toUpperCase()}.`
      );

      expect(hasModelUnsupportedWording(body)).toBe(true);
    }
  });

  test("does not mistake authentication-failure wording for an unsupported model", () => {
    const authFailures = [
      "Invalid API key.",
      "invalid",
      "unauthorized",
      "permission denied",
      "forbidden",
      "authentication failed",
      "invalid token",
    ] as const;

    // A false positive here sends a user with genuinely broken credentials to
    // check their model name instead of fixing the credential that actually failed.
    for (const message of authFailures) {
      const body = anthropicErrorBody("authentication_error", message);
      expect({ message, matched: hasModelUnsupportedWording(body) }).toEqual({
        message,
        matched: false,
      });
    }
  });

  test("returns false without throwing for empty and undefined-ish input", () => {
    const inputs = ["", undefined, null] as const;

    for (const input of inputs) {
      const invoke = () => hasModelUnsupportedWording(input as unknown as string);
      expect(invoke).not.toThrow();
      expect(invoke()).toBe(false);
    }
  });
});
