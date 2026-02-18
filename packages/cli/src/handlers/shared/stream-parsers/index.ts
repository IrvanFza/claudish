/**
 * Stream parsers — convert provider-specific streaming formats to Claude SSE.
 *
 * Each parser takes a Response from a provider API and returns a Response
 * with Claude-compatible SSE events (message_start, content_block_delta, etc.).
 */

export { createStreamingResponseHandler } from "./openai-sse.js";
export { createResponsesStreamHandler } from "./openai-responses-sse.js";
export { createAnthropicPassthroughStream } from "./anthropic-sse.js";
export { createOllamaJsonlStream } from "./ollama-jsonl.js";
export { createGeminiSseStream } from "./gemini-sse.js";
