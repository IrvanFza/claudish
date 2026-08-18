import { describe, expect, test } from "bun:test";
import {
  buildSurfacedErrorMessage,
  wrapAnthropicError,
} from "../handlers/shared/anthropic-error.js";
import { classifyHttpError } from "./probe-live.js";

/** The Anthropic-style error body emitted by the proxy for an upstream failure. */
function proxyErrorBody(status: number, message: string): string {
  return JSON.stringify(wrapAnthropicError(status, message));
}

/** The exact body shape emitted when the proxy remaps a terminal upstream error to HTTP 400. */
function remappedTerminalBody(
  upstreamStatus: number,
  providerMessage: string,
  hint: string
): string {
  const surfaced = buildSurfacedErrorMessage({
    providerDisplayName: "OpenCode Zen Go",
    status: upstreamStatus,
    hint,
    providerMessage,
  });
  return JSON.stringify(wrapAnthropicError(400, surfaced, "invalid_request_error", upstreamStatus));
}

describe("classifyHttpError — auth-shaped model errors", () => {
  test("classifies a 401 unsupported-model response without rewriting its status", () => {
    const body = proxyErrorBody(401, "Model deepseek-v4-pro-0813 is not supported");

    const result = classifyHttpError(401, body, 37);

    expect(result.state).toBe("model-not-found");
    // Keep the provider's real (misused) status visible rather than laundering it into a 404.
    expect(result.httpStatus).toBe(401);
  });

  test("keeps the captured invalid-key 401 classified as an authentication failure", () => {
    const body = proxyErrorBody(401, "Invalid API key.");

    const result = classifyHttpError(401, body, 38);

    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
  });

  test("distinguishes unsupported-model and authentication wording under HTTP 403", () => {
    const unsupported = classifyHttpError(
      403,
      proxyErrorBody(403, "Unsupported model: deepseek-v4-pro-0813"),
      39
    );
    const forbidden = classifyHttpError(403, proxyErrorBody(403, "Forbidden"), 40);

    expect(unsupported.state).toBe("model-not-found");
    expect(unsupported.httpStatus).toBe(403);
    expect(forbidden.state).toBe("auth-failed");
    expect(forbidden.httpStatus).toBe(403);
  });

  test("uses an embedded upstream 401 for both remapped terminal-error arms", () => {
    const unsupported = classifyHttpError(
      400,
      remappedTerminalBody(
        401,
        "Model deepseek-v4-pro-0813 is not supported",
        "Model not supported by this provider. Verify model name."
      ),
      41
    );
    const unauthorized = classifyHttpError(
      400,
      remappedTerminalBody(401, "Unauthorized", "Check API key / OAuth credentials."),
      42
    );

    expect(unsupported.state).toBe("model-not-found");
    expect(unsupported.httpStatus).toBe(401);
    expect(unauthorized.state).toBe("auth-failed");
    expect(unauthorized.httpStatus).toBe(401);
  });

  test("leaves unrelated HTTP classifications unchanged", () => {
    const cases = [
      { status: 404, message: "Requested model does not exist", state: "model-not-found" },
      { status: 429, message: "Rate limit exceeded", state: "rate-limited" },
      { status: 500, message: "Internal server error", state: "server-error" },
    ] as const;

    for (const { status, message, state } of cases) {
      const result = classifyHttpError(status, proxyErrorBody(status, message), 43);
      expect(result.state).toBe(state);
      expect(result.httpStatus).toBe(status);
    }
  });
});
