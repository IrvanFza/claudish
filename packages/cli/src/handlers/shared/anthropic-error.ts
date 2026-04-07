/**
 * Anthropic error envelope wrapper.
 * All proxy error responses MUST use this format.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "overloaded_error"
  | "api_error"
  | "connection_error";

export interface AnthropicErrorEnvelope {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}

/**
 * Map HTTP status codes to Anthropic error types.
 */
export function statusToErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 429: return "rate_limit_error";
    case 503:
    case 529: return "overloaded_error";
    default:  return "api_error";
  }
}

/**
 * Create a properly formatted Anthropic error envelope.
 *
 * @param status     - HTTP status code (used to infer error type if not provided)
 * @param message    - Human-readable error message
 * @param errorType  - Override the error type (e.g., from a provider's structured error)
 */
export function wrapAnthropicError(
  status: number,
  message: string,
  errorType?: string
): AnthropicErrorEnvelope {
  const type = (errorType as AnthropicErrorType) || statusToErrorType(status);
  return {
    type: "error",
    error: { type, message },
  };
}

/**
 * Check if a parsed JSON body is already in Anthropic error envelope format.
 * Returns the body as-is if valid, or wraps it if not.
 */
export function ensureAnthropicErrorFormat(
  status: number,
  body: any
): AnthropicErrorEnvelope {
  // Already correct format: { type: "error", error: { type: "...", message: "..." } }
  if (
    body?.type === "error" &&
    typeof body?.error?.type === "string" &&
    typeof body?.error?.message === "string"
  ) {
    return body;
  }

  // Partial format: { error: { type: "...", message: "..." } } (missing outer type)
  if (typeof body?.error?.type === "string" && typeof body?.error?.message === "string") {
    return { type: "error", error: body.error };
  }

  // Provider returned some other JSON structure -- extract best message
  const message =
    body?.error?.message ||
    body?.message ||
    body?.error ||
    (typeof body === "string" ? body : JSON.stringify(body));

  const errorType = body?.error?.type || body?.type || body?.code;

  return wrapAnthropicError(status, String(message), errorType);
}
