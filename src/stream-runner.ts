/**
 * Stream Runner - Direct NDJSON streaming output
 *
 * Bypasses Claude Code entirely and streams NDJSON events directly to stdout.
 * Designed for programmatic/SDK-like usage.
 *
 * NDJSON Output Format:
 * {"event":"start","model":"gpt-4o","created":1706558400}
 * {"event":"delta","content":"Hello"}
 * {"event":"thinking","thinking":"Let me consider..."}
 * {"event":"tool_use","tool":{"id":"call_123","name":"Read","arguments":"{...}"}}
 * {"event":"done","usage":{"input_tokens":10,"output_tokens":5},"cost_usd":0.00015}
 * {"event":"error","error":{"type":"api_error","message":"Rate limited"}}
 */

import type { ClaudishConfig } from "./types.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  resolveModelProvider,
  validateApiKeysForModels,
  getMissingKeysError,
  getMissingKeyResolutions,
} from "./providers/provider-resolver.js";
import { resolveRemoteProvider } from "./providers/remote-provider-registry.js";
import { resolveProvider, parseUrlModel, createUrlProvider } from "./providers/provider-registry.js";
import { getModelPricing } from "./handlers/shared/remote-provider-types.js";

/**
 * NDJSON event types
 */
interface StreamEvent {
  event: "start" | "delta" | "thinking" | "tool_use" | "done" | "error";
  model?: string;
  created?: number;
  content?: string;
  thinking?: string;
  tool?: {
    id: string;
    name: string;
    arguments: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  cost_usd?: number;
  error?: {
    type: string;
    message: string;
  };
}

/**
 * Write an NDJSON event to stdout
 */
function writeEvent(event: StreamEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/**
 * Write an error event and return exit code
 */
function writeError(type: string, message: string): number {
  writeEvent({
    event: "error",
    error: { type, message },
  });
  return 1;
}

/**
 * Build OpenAI-compatible request payload
 */
function buildOpenAIPayload(prompt: string, model: string): any {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  };
}

/**
 * Build Gemini request payload
 */
function buildGeminiPayload(prompt: string): any {
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 1.0,
    },
  };
}

/**
 * Process OpenAI-compatible SSE stream
 * Used by: OpenRouter, OpenAI, xAI, MiniMax, Kimi, GLM, Ollama, LM Studio, etc.
 */
async function processOpenAIStream(
  response: Response,
  model: string,
  provider: string
): Promise<{ inputTokens: number; outputTokens: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      if (!data) continue;

      try {
        const chunk = JSON.parse(data);

        // Extract content delta
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          writeEvent({ event: "delta", content: delta.content });
        }

        // Handle reasoning/thinking content (for models that support it)
        if (delta?.reasoning_content) {
          writeEvent({ event: "thinking", thinking: delta.reasoning_content });
        }

        // Handle tool calls
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.function) {
              writeEvent({
                event: "tool_use",
                tool: {
                  id: toolCall.id || `call_${Date.now()}`,
                  name: toolCall.function.name || "",
                  arguments: toolCall.function.arguments || "",
                },
              });
            }
          }
        }

        // Extract usage from final chunk
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }

        // Handle x_groq usage format
        if (chunk.x_groq?.usage) {
          inputTokens = chunk.x_groq.usage.prompt_tokens || 0;
          outputTokens = chunk.x_groq.usage.completion_tokens || 0;
        }
      } catch (e) {
        // Skip unparseable chunks
      }
    }
  }

  return { inputTokens, outputTokens };
}

/**
 * Process Gemini SSE stream
 */
async function processGeminiStream(
  response: Response,
  model: string
): Promise<{ inputTokens: number; outputTokens: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      try {
        const chunk = JSON.parse(data);

        // Extract text content
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              writeEvent({ event: "delta", content: part.text });
            }
            // Handle thinking content (Gemini 2.0 with thinking)
            if (part.thought) {
              writeEvent({ event: "thinking", thinking: part.thought });
            }
            // Handle function calls
            if (part.functionCall) {
              writeEvent({
                event: "tool_use",
                tool: {
                  id: `call_${Date.now()}`,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              });
            }
          }
        }

        // Extract usage metadata
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount || 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
      } catch (e) {
        // Skip unparseable chunks
      }
    }
  }

  return { inputTokens, outputTokens };
}

/**
 * Get API endpoint and headers for a provider
 */
function getProviderConfig(
  provider: string,
  model: string
): { url: string; headers: Record<string, string>; isGeminiFormat: boolean } | null {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "openrouter": {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return null;
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["HTTP-Referer"] = "https://claudish.com";
      headers["X-Title"] = "Claudish Stream";
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers,
        isGeminiFormat: false,
      };
    }

    case "google": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return null;
      const baseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
      return {
        url: `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
        headers,
        isGeminiFormat: true,
      };
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "xai": {
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) return null;
      const baseUrl = process.env.XAI_BASE_URL || "https://api.x.ai";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "minimax": {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) return null;
      const baseUrl = process.env.MINIMAX_BASE_URL || "https://api.minimax.io";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "kimi": {
      const apiKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
      if (!apiKey) return null;
      const baseUrl =
        process.env.MOONSHOT_BASE_URL || process.env.KIMI_BASE_URL || "https://api.moonshot.ai";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "glm": {
      const apiKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
      if (!apiKey) return null;
      const baseUrl =
        process.env.ZHIPU_BASE_URL || process.env.GLM_BASE_URL || "https://open.bigmodel.cn";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/api/paas/v4/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "ollamacloud": {
      const apiKey = process.env.OLLAMA_API_KEY;
      if (!apiKey) return null;
      const baseUrl = process.env.OLLAMACLOUD_BASE_URL || "https://ollama.com";
      headers["Authorization"] = `Bearer ${apiKey}`;
      return {
        url: `${baseUrl}/api/chat`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "opencode-zen": {
      const baseUrl = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen";
      // OpenCode Zen has free models - API key optional
      const apiKey = process.env.OPENCODE_API_KEY;
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "ollama": {
      const baseUrl =
        process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "lmstudio": {
      const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234";
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "vllm": {
      const baseUrl = process.env.VLLM_BASE_URL || "http://localhost:8000";
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    case "mlx": {
      const baseUrl = process.env.MLX_BASE_URL || "http://127.0.0.1:8080";
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        isGeminiFormat: false,
      };
    }

    default:
      return null;
  }
}

/**
 * Main entry point for stream mode
 */
export async function runStreamMode(config: ClaudishConfig): Promise<number> {
  // Validate model is provided
  if (!config.model) {
    return writeError("invalid_request", "Model required for stream mode. Use --model <model>");
  }

  // Get prompt from claudeArgs
  const prompt = config.claudeArgs.join(" ").trim();
  if (!prompt) {
    return writeError("invalid_request", "No prompt provided. Pass prompt as arguments or use --stdin");
  }

  // Parse model spec
  const parsed = parseModelSpec(config.model);
  const resolution = resolveModelProvider(config.model);

  // Validate API key
  const resolutions = validateApiKeysForModels([config.model]);
  const missing = getMissingKeyResolutions(resolutions);
  if (missing.length > 0) {
    return writeError("invalid_request", getMissingKeysError(missing));
  }

  // Handle unknown providers
  if (resolution.category === "unknown") {
    return writeError(
      "invalid_request",
      `Unknown provider for model "${config.model}". Use explicit routing: openrouter@${config.model}`
    );
  }

  // Get provider configuration
  const providerConfig = getProviderConfig(parsed.provider, parsed.model);
  if (!providerConfig) {
    return writeError(
      "invalid_request",
      `Could not configure provider "${parsed.provider}" for streaming. Check API key.`
    );
  }

  // Write start event
  writeEvent({
    event: "start",
    model: config.model,
    created: Math.floor(Date.now() / 1000),
  });

  try {
    // Build request payload
    const payload = providerConfig.isGeminiFormat
      ? buildGeminiPayload(prompt)
      : buildOpenAIPayload(prompt, parsed.model);

    // Make streaming request
    const response = await fetch(providerConfig.url, {
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API returned ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        if (errorText) errorMessage = errorText.slice(0, 200);
      }
      return writeError("api_error", errorMessage);
    }

    // Process stream
    const usage = providerConfig.isGeminiFormat
      ? await processGeminiStream(response, parsed.model)
      : await processOpenAIStream(response, parsed.model, parsed.provider);

    // Calculate cost
    const pricing = getModelPricing(parsed.provider, parsed.model);
    const costUsd =
      (usage.inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (usage.outputTokens / 1_000_000) * pricing.outputCostPer1M;

    // Write done event
    writeEvent({
      event: "done",
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      },
      cost_usd: costUsd,
    });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeError("connection_error", message);
  }
}
