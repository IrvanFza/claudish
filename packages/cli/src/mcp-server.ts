#!/usr/bin/env bun

/**
 * Claudish MCP Server
 *
 * Exposes all claudish models (OpenRouter, Kimi, GLM, Qwen, MiniMax, Gemini, OpenAI,
 * local models, etc.) and channel sessions as MCP tools for Claude Code.
 * Routes through the same proxy engine as the CLI — same auto-routing, fallback chains,
 * custom routing rules, and provider transports.
 *
 * Run with: claudish --mcp (stdio transport)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  setupSession,
  runModels,
  judgeResponses,
  getStatus,
  validateSessionPath,
} from "./team-orchestrator.js";
import { SessionManager } from "./channel/index.js";
import { createProxyServer } from "./proxy-server.js";
import { findAvailablePort } from "./port-manager.js";
import type { ProxyServer } from "./types.js";

// Load environment variables
config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

const RECOMMENDED_MODELS_PATH = join(__dirname, "../recommended-models.json");
const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
const ALL_MODELS_CACHE_PATH = join(CLAUDISH_CACHE_DIR, "all-models.json");
const CACHE_MAX_AGE_DAYS = 2;

/** Instructions added to Claude's system prompt when channel mode is active. */
const INSTRUCTIONS = `Claudish MCP server provides access to external AI models (OpenRouter, Ollama, LM Studio, etc.) for coding tasks.

## Channel Mode — External Model Sessions

When channel mode is active, you receive <channel source="claudish" ...> notifications about running external model sessions.

### Events

- session_started: A session began producing output. Note the session_id for future calls.
- tool_executing: The model is using a tool (Read, Write, Bash, etc.). May include tool_count for batched events.
- input_required: The model is asking a question and waiting for input. Call send_input with the session_id and your answer.
- completed: The session finished successfully. Call get_output to retrieve the full output.
- failed: The session exited with an error. Check the content for details.
- cancelled: The session was cancelled via cancel_session.

### Workflow

1. Call create_session with a model and prompt to start an async session.
2. Watch for <channel> notifications — they arrive automatically.
3. On input_required: call send_input with the answer.
4. On completed: call get_output to get the full response.
5. Use list_sessions to see all active/completed sessions.
6. Use cancel_session to stop a running session.

The session_id in the channel tag's meta attributes is the key for all tool calls.`;

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolGroup = "low-level" | "agentic" | "channel";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  group: ToolGroup;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  pricing?: { input: string; output: string; average: string };
  context?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function loadRecommendedModels(): ModelInfo[] {
  // Try Firebase-cached version first (auto-generated, more current)
  const cachedPath = join(CLAUDISH_CACHE_DIR, "recommended-models-cache.json");
  if (existsSync(cachedPath)) {
    try {
      const data = JSON.parse(readFileSync(cachedPath, "utf-8"));
      if (data.models && data.models.length > 0) return data.models;
    } catch {
      // Fall through to bundled
    }
  }

  // Fall back to bundled JSON
  if (existsSync(RECOMMENDED_MODELS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(RECOMMENDED_MODELS_PATH, "utf-8"));
      return data.models || [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Parse "$1.32/1M" → 1.32, "FREE" → 0, "N/A" → Infinity */
function parsePriceAvg(s?: string): number {
  if (!s || s === "N/A") return Infinity;
  if (s === "FREE") return 0;
  const m = s.match(/\$([\d.]+)/);
  return m ? parseFloat(m[1]) : Infinity;
}

/** Parse "196K" → 196000, "1M" → 1000000, "1048K" → 1048000 */
function parseCtx(s?: string): number {
  if (!s || s === "N/A") return 0;
  const upper = s.toUpperCase();
  if (upper.includes("M")) return parseFloat(upper) * 1_000_000;
  if (upper.includes("K")) return parseFloat(upper) * 1_000;
  return parseInt(s) || 0;
}

async function loadAllModels(forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && existsSync(ALL_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache invalid
    }
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const models = data.data || [];
    mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
    writeFileSync(
      ALL_MODELS_CACHE_PATH,
      JSON.stringify({ lastUpdated: new Date().toISOString(), models }),
      "utf-8"
    );
    return models;
  } catch {
    if (existsSync(ALL_MODELS_CACHE_PATH)) {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      return cacheData.models || [];
    }
    return [];
  }
}

// ─── Lazy Proxy Singleton ────────────────────────────────────────────────────
// The proxy runs the same routing engine as the CLI: auto-route, fallback chains,
// custom routing rules, catalog resolution, and all direct provider transports.
// It's started once on first use and reused for all subsequent MCP tool calls.

let proxyInstance: ProxyServer | null = null;
let proxyStarting: Promise<ProxyServer> | null = null;

async function getProxy(): Promise<ProxyServer> {
  if (proxyInstance) return proxyInstance;
  if (proxyStarting) return proxyStarting;

  proxyStarting = (async () => {
    const port = await findAvailablePort(10000, 19999);
    const proxy = await createProxyServer(
      port,
      process.env.OPENROUTER_API_KEY,
      undefined, // no default model — each call specifies its own
      false, // not monitor mode
      process.env.ANTHROPIC_API_KEY,
      undefined, // no model map
      { quiet: true }
    );
    proxyInstance = proxy;
    return proxy;
  })();

  return proxyStarting;
}

/** Parse Anthropic SSE stream and extract text content + usage */
function parseAnthropicSse(raw: string): {
  text: string;
  usage?: { input: number; output: number };
} {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;

  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n").filter((l) => l.trim());
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) dataStr += line.slice(6);
    }
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const data = JSON.parse(dataStr);
      if (data.type === "message_start" && data.message?.usage) {
        inputTokens = data.message.usage.input_tokens || 0;
        outputTokens = data.message.usage.output_tokens || 0;
        hasUsage = true;
      } else if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
        text += data.delta.text;
      } else if (data.type === "message_delta" && data.usage) {
        outputTokens = data.usage.output_tokens || outputTokens;
        hasUsage = true;
      }
    } catch {
      // Skip unparseable events
    }
  }

  return { text, usage: hasUsage ? { input: inputTokens, output: outputTokens } : undefined };
}

async function runPromptViaProxy(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const proxy = await getProxy();

  // Build Anthropic Messages API request
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens || 4096,
    stream: true,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Proxy error: ${response.status} - ${error}`);
  }

  const raw = await response.text();
  const parsed = parseAnthropicSse(raw);

  if (!parsed.text) {
    throw new Error("Model returned empty response");
  }

  return { content: parsed.text, usage: parsed.usage };
}

function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText === lowerQuery) return 1;
  if (lowerText.includes(lowerQuery)) return 0.8;
  let score = 0;
  let queryIndex = 0;
  for (const char of lowerText) {
    if (queryIndex < lowerQuery.length && char === lowerQuery[queryIndex]) {
      score++;
      queryIndex++;
    }
  }
  return queryIndex === lowerQuery.length ? score / lowerText.length : 0;
}

function formatTeamResult(
  status: import("./team-orchestrator.js").TeamStatus,
  sessionPath: string
): string {
  const entries = Object.entries(status.models);
  const failed = entries.filter(([, m]) => m.state === "FAILED" || m.state === "TIMEOUT");
  const succeeded = entries.filter(([, m]) => m.state === "COMPLETED");

  let result = JSON.stringify(status, null, 2);

  if (failed.length > 0) {
    result += "\n\n---\n## Failures Detected\n\n";
    result += `${succeeded.length}/${entries.length} models succeeded, ${failed.length} failed.\n\n`;

    for (const [id, m] of failed) {
      result += `### Model ${id}: ${m.state}\n`;
      if (m.error) {
        result += `- **Model:** ${m.error.model}\n`;
        result += `- **Command:** \`${m.error.command}\`\n`;
        result += `- **Exit code:** ${m.exitCode}\n`;
        if (m.error.stderrSnippet) {
          result += `- **Error output:**\n\`\`\`\n${m.error.stderrSnippet}\n\`\`\`\n`;
        }
        result += `- **Full error log:** ${m.error.errorLogPath}\n`;
        result += `- **Working directory:** ${m.error.workDir}\n`;
      }
      result += "\n";
    }

    result += "---\n";
    result += "**To help claudish devs fix this**, use the `report_error` tool with:\n";
    result += '- `error_type`: "provider_failure" or "team_failure"\n';
    result += `- \`session_path\`: "${sessionPath}"\n`;
    result += "- Copy the stderr snippet above into `stderr_snippet`\n";
    result += "- Set `auto_send: true` to suggest enabling automatic reporting\n";
  }

  return result;
}

function sanitize(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "sk-***REDACTED***")
    .replace(/Bearer [a-zA-Z0-9_.-]+/g, "Bearer ***REDACTED***")
    .replace(/\/Users\/[^/\s]+/g, "/Users/***")
    .replace(/\/home\/[^/\s]+/g, "/home/***")
    .replace(/[A-Z_]+_API_KEY=[^\s]+/g, "***_API_KEY=REDACTED")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

function defineTools(sessionManager: SessionManager): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── Low-Level Tools ──────────────────────────────────────────────────

  tools.push({
    name: "run_prompt",
    description:
      "Run a prompt through any model — supports all providers (Kimi, GLM, Qwen, MiniMax, Gemini, GPT, Grok, etc.) with auto-routing, fallback chains, and custom routing rules.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model name or ID. Short names auto-route to the best provider (e.g., 'kimi-k2.5', 'glm-5', 'gpt-5.4'). Provider prefix optional (e.g., 'google@gemini-3.1-pro-preview', 'or@x-ai/grok-3').",
        },
        prompt: { type: "string", description: "The prompt to send to the model" },
        system_prompt: { type: "string", description: "Optional system prompt" },
        max_tokens: { type: "number", description: "Maximum tokens in response (default: 4096)" },
      },
      required: ["model", "prompt"],
    },
    group: "low-level",
    handler: async (args) => {
      try {
        const result = await runPromptViaProxy(
          args.model as string,
          args.prompt as string,
          args.system_prompt as string | undefined,
          args.max_tokens as number | undefined
        );
        let response = result.content;
        if (result.usage) {
          response += `\n\n---\nTokens: ${result.usage.input} input, ${result.usage.output} output`;
        }
        return { content: [{ type: "text" as const, text: response }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${errMsg}\n\n---\n**To report this error**, use the \`report_error\` tool with \`error_type: "provider_failure"\` and \`model: "${args.model}"\`.`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "list_models",
    description: "List recommended models for coding tasks",
    inputSchema: { type: "object" },
    group: "low-level",
    handler: async () => {
      const models = loadRecommendedModels();
      if (models.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No recommended models found. Try search_models instead.",
            },
          ],
        };
      }
      let output = "# Recommended Models\n\n";
      output += "| Model | Provider | Pricing | Context | Tools | Reasoning | Vision |\n";
      output += "|-------|----------|---------|---------|-------|-----------|--------|\n";
      for (const model of models) {
        const t = model.supportsTools ? "✓" : "·";
        const r = model.supportsReasoning ? "✓" : "·";
        const v = model.supportsVision ? "✓" : "·";
        output += `| ${model.id} | ${model.provider} | ${model.pricing?.average || "N/A"} | ${model.context || "N/A"} | ${t} | ${r} | ${v} |\n`;
      }
      // Generate Quick Picks from loaded data (no more hardcoded drift)
      output += "\n## Quick Picks\n";
      const cheapest = [...models].sort((a, b) => parsePriceAvg(a.pricing?.average) - parsePriceAvg(b.pricing?.average))[0];
      const bigCtx = [...models].sort((a, b) => parseCtx(b.context) - parseCtx(a.context))[0];
      const priciest = [...models].sort((a, b) => parsePriceAvg(b.pricing?.average) - parsePriceAvg(a.pricing?.average))[0];
      const vision = models.find(m => m.supportsVision);
      const reasoning = models.find(m => m.supportsReasoning && m.id !== priciest?.id);
      if (cheapest) output += `- **Budget**: \`${cheapest.id}\` (${cheapest.pricing?.average || "N/A"})\n`;
      if (bigCtx && bigCtx.id !== cheapest?.id) output += `- **Large context**: \`${bigCtx.id}\` (${bigCtx.context || "N/A"} tokens)\n`;
      if (priciest && priciest.id !== cheapest?.id) output += `- **Most advanced**: \`${priciest.id}\` (${priciest.pricing?.average || "N/A"})\n`;
      if (vision && vision.id !== cheapest?.id && vision.id !== priciest?.id) output += `- **Vision + coding**: \`${vision.id}\` (${vision.pricing?.average || "N/A"})\n`;
      if (reasoning && reasoning.id !== cheapest?.id) output += `- **Agentic**: \`${reasoning.id}\` (${reasoning.pricing?.average || "N/A"})\n`;
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  tools.push({
    name: "search_models",
    description: "Search all OpenRouter models by name, provider, or capability",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'grok', 'vision', 'free')" },
        limit: { type: "number", description: "Maximum results to return (default: 10)" },
      },
      required: ["query"],
    },
    group: "low-level",
    handler: async (args) => {
      const query = args.query as string;
      const maxResults = (args.limit as number) || 10;
      const allModels = await loadAllModels();
      if (allModels.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Failed to load models. Check your internet connection.",
            },
          ],
          isError: true,
        };
      }
      const results = allModels
        .map((model: any) => {
          const nameScore = fuzzyScore(model.name || "", query);
          const idScore = fuzzyScore(model.id || "", query);
          const descScore = fuzzyScore(model.description || "", query) * 0.5;
          return { model, score: Math.max(nameScore, idScore, descScore) };
        })
        .filter((item: any) => item.score > 0.2)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, maxResults);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No models found matching "${query}"` }],
        };
      }
      let output = `# Search Results for "${query}"\n\n`;
      output += "| Model | Provider | Pricing | Context |\n";
      output += "|-------|----------|---------|----------|\n";
      for (const { model } of results) {
        const provider = model.id.split("/")[0];
        const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
        const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
        const avgPrice = (promptPrice + completionPrice) / 2;
        const pricing =
          avgPrice > 0 ? `$${avgPrice.toFixed(2)}/1M` : avgPrice < 0 ? "varies" : "FREE";
        const context = model.context_length
          ? `${Math.round(model.context_length / 1000)}K`
          : "N/A";
        output += `| ${model.id} | ${provider} | ${pricing} | ${context} |\n`;
      }
      output += `\nUse with: run_prompt(model="${results[0].model.id}", prompt="your prompt")`;
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  tools.push({
    name: "compare_models",
    description: "Run the same prompt through multiple models and compare responses",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          description: "List of model IDs to compare",
        },
        prompt: { type: "string", description: "The prompt to send to all models" },
        system_prompt: { type: "string", description: "Optional system prompt" },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in response (omit to let model decide)",
        },
      },
      required: ["models", "prompt"],
    },
    group: "low-level",
    handler: async (args) => {
      const modelIds = args.models as string[];
      const prompt = args.prompt as string;
      const systemPrompt = args.system_prompt as string | undefined;
      const maxTokens = args.max_tokens as number | undefined;

      const results: Array<{
        model: string;
        response: string;
        error?: string;
        tokens?: { input: number; output: number };
      }> = [];
      for (const model of modelIds) {
        try {
          const result = await runPromptViaProxy(model, prompt, systemPrompt, maxTokens);
          results.push({ model, response: result.content, tokens: result.usage });
        } catch (error) {
          results.push({
            model,
            response: "",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let output = "# Model Comparison\n\n";
      output += `**Prompt:** ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}\n\n`;
      for (const result of results) {
        output += `## ${result.model}\n\n`;
        if (result.error) {
          output += `**Error:** ${result.error}\n\n`;
        } else {
          output += result.response + "\n\n";
          if (result.tokens) {
            output += `*Tokens: ${result.tokens.input} in, ${result.tokens.output} out*\n\n`;
          }
        }
        output += "---\n\n";
      }
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        output +=
          '---\n**To report failed model(s)**, use the `report_error` tool with `error_type: "provider_failure"` and the model ID(s) above.\n';
      }
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  // ── Agentic Tools ────────────────────────────────────────────────────

  tools.push({
    name: "team",
    description:
      "Run AI models on a task with anonymized outputs and optional blind judging. Modes: 'run' (execute models), 'judge' (blind-vote on existing outputs), 'run-and-judge' (full pipeline), 'status' (check progress).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["run", "judge", "run-and-judge", "status"],
          description: "Operation mode",
        },
        path: {
          type: "string",
          description: "Session directory path (must be within current working directory)",
        },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "External model IDs to run (required for 'run' and 'run-and-judge' modes). " +
            "Do NOT pass 'internal', 'default', 'opus', 'sonnet', 'haiku', or 'claude-*' model IDs — " +
            "those are Claude Code agent selectors and must be handled via Task agents instead.",
        },
        judges: {
          type: "array",
          items: { type: "string" },
          description: "Model IDs to use as judges (default: same as runners)",
        },
        input: {
          type: "string",
          description:
            "Task prompt text (or place input.md in the session directory before calling)",
        },
        timeout: { type: "number", description: "Per-model timeout in seconds (default: 300)" },
      },
      required: ["mode", "path"],
    },
    group: "agentic",
    handler: async (args) => {
      try {
        const mode = args.mode as string;
        const path = args.path as string;
        const models = args.models as string[] | undefined;
        const judges = args.judges as string[] | undefined;
        const input = args.input as string | undefined;
        const timeout = args.timeout as number | undefined;

        const resolved = validateSessionPath(path);

        switch (mode) {
          case "run": {
            if (!models?.length) throw new Error("'models' is required for 'run' mode");
            setupSession(resolved, models, input);
            const status = await runModels(resolved, { timeout });
            return {
              content: [{ type: "text" as const, text: formatTeamResult(status, resolved) }],
            };
          }
          case "judge": {
            const verdict = await judgeResponses(resolved, { judges });
            return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
          }
          case "run-and-judge": {
            if (!models?.length) throw new Error("'models' is required for 'run-and-judge' mode");
            setupSession(resolved, models, input);
            await runModels(resolved, { timeout });
            const verdict = await judgeResponses(resolved, { judges });
            return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
          }
          case "status": {
            const status = getStatus(resolved);
            return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
          }
          default:
            throw new Error(`Unknown mode: ${mode}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "report_error",
    description:
      "Report a claudish error to developers. IMPORTANT: Ask the user for consent BEFORE calling this tool. Show them what data will be sent (sanitized). All data is anonymized: API keys, user paths, and emails are stripped. Set auto_send=true to suggest the user enables automatic future reporting.",
    inputSchema: {
      type: "object",
      properties: {
        error_type: {
          type: "string",
          enum: ["provider_failure", "team_failure", "stream_error", "adapter_error", "other"],
          description: "Category of the error",
        },
        model: { type: "string", description: "Model ID that failed (anonymized in report)" },
        command: { type: "string", description: "Command that was run" },
        stderr_snippet: { type: "string", description: "First 500 chars of stderr output" },
        exit_code: { type: "number", description: "Process exit code" },
        error_log_path: { type: "string", description: "Path to full error log file" },
        session_path: { type: "string", description: "Path to team session directory" },
        additional_context: { type: "string", description: "Any extra context about the error" },
        auto_send: {
          type: "boolean",
          description: "If true, suggest the user enable automatic error reporting",
        },
      },
      required: ["error_type"],
    },
    group: "agentic",
    handler: async (args) => {
      const error_type = args.error_type as string;
      const model = args.model as string | undefined;
      const command = args.command as string | undefined;
      const stderr_snippet = args.stderr_snippet as string | undefined;
      const exit_code = args.exit_code as number | undefined;
      const error_log_path = args.error_log_path as string | undefined;
      const session_path = args.session_path as string | undefined;
      const additional_context = args.additional_context as string | undefined;
      const auto_send = args.auto_send as boolean | undefined;

      let stderrFull = stderr_snippet || "";
      if (error_log_path) {
        try {
          stderrFull = readFileSync(error_log_path, "utf-8");
        } catch {}
      }

      let sessionData: Record<string, string> = {};
      if (session_path) {
        const sp = session_path;
        for (const file of ["status.json", "manifest.json", "input.md"]) {
          try {
            sessionData[file] = readFileSync(join(sp, file), "utf-8");
          } catch {}
        }
        try {
          const errorDir = join(sp, "errors");
          if (existsSync(errorDir)) {
            for (const f of readdirSync(errorDir)) {
              if (f.endsWith(".log")) {
                try {
                  sessionData[`errors/${f}`] = readFileSync(join(errorDir, f), "utf-8");
                } catch {}
              }
            }
          }
        } catch {}
        try {
          for (const f of readdirSync(sp)) {
            if (f.startsWith("response-") && f.endsWith(".md")) {
              try {
                const content = readFileSync(join(sp, f), "utf-8");
                sessionData[f] =
                  content.slice(0, 200) + (content.length > 200 ? "... (truncated)" : "");
              } catch {}
            }
          }
        } catch {}
      }

      let version = "unknown";
      try {
        const pkgPath = join(__dirname, "../package.json");
        if (existsSync(pkgPath)) {
          version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
        }
      } catch {}

      const report = {
        version,
        timestamp: new Date().toISOString(),
        error_type,
        model: model || "unknown",
        command: sanitize(command),
        stderr: sanitize(stderrFull),
        exit_code: exit_code ?? null,
        platform: process.platform,
        arch: process.arch,
        runtime: `bun ${process.version}`,
        context: sanitize(additional_context),
        session: Object.fromEntries(Object.entries(sessionData).map(([k, v]) => [k, sanitize(v)])),
      };

      const reportSummary = JSON.stringify(report, null, 2);
      const autoSendHint = auto_send
        ? "\n\n**Suggestion:** Enable automatic error reporting so future errors are sent without asking. Run `claudish config` → Privacy → toggle Telemetry, or set `CLAUDISH_TELEMETRY=1`."
        : "";

      const REPORT_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/errorReportIngest";

      try {
        const response = await fetch(REPORT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error report sent successfully.\n\n**Sanitized data sent:**\n\`\`\`json\n${reportSummary}\n\`\`\`${autoSendHint}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error report endpoint returned ${response.status}. Report was NOT sent.\n\n**Data that would have been sent (all sanitized):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nYou can manually report this at https://github.com/anthropics/claudish/issues${autoSendHint}`,
              },
            ],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not reach error reporting endpoint (${err instanceof Error ? err.message : "network error"}).\n\n**Sanitized error data (for manual reporting):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nReport manually at https://github.com/anthropics/claudish/issues${autoSendHint}`,
            },
          ],
        };
      }
    },
  });

  // ── Channel Tools ────────────────────────────────────────────────────

  tools.push({
    name: "create_session",
    description:
      "Create a new claudish proxy session for an external model. Spawns an async session that produces channel notifications as it runs.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model identifier (e.g., 'google@gemini-2.0-flash', 'x-ai/grok-code-fast-1')",
        },
        prompt: {
          type: "string",
          description: "Initial prompt to send. If omitted, send later via send_input.",
        },
        timeout_seconds: {
          type: "number",
          description: "Session timeout in seconds (default: 600, max: 3600)",
        },
        claude_flags: {
          type: "string",
          description: "Extra flags to pass to claudish (space-separated)",
        },
        work_dir: {
          type: "string",
          description: "Working directory for the session (default: current directory)",
        },
      },
      required: ["model"],
    },
    group: "channel",
    handler: async (args) => {
      try {
        const claudishFlags = args.claude_flags
          ? (args.claude_flags as string).split(/\s+/).filter(Boolean)
          : undefined;

        const sessionId = sessionManager.createSession({
          model: args.model as string,
          prompt: args.prompt as string | undefined,
          timeoutSeconds: args.timeout_seconds as number | undefined,
          claudishFlags,
          cwd: args.work_dir as string | undefined,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ session_id: sessionId, status: "starting" }),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating session: ${errMsg}\n\n---\n**To report this error**, use the \`report_error\` tool with \`error_type: "provider_failure"\` and \`model: "${args.model}"\`.`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "send_input",
    description:
      "Send input text to an active session's stdin. Use when a session is in 'waiting_for_input' state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        text: { type: "string", description: "Text to send to the session" },
      },
      required: ["session_id", "text"],
    },
    group: "channel",
    handler: async (args) => {
      const success = sessionManager.sendInput(args.session_id as string, args.text as string);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success }) }],
      };
    },
  });

  tools.push({
    name: "get_output",
    description:
      "Get output from a session's scrollback buffer. Call after 'completed' notification to get full response.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        tail_lines: {
          type: "number",
          description: "Number of lines to return from the end (default: all)",
        },
      },
      required: ["session_id"],
    },
    group: "channel",
    handler: async (args) => {
      try {
        const output = sessionManager.getOutput(
          args.session_id as string,
          args.tail_lines as number | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "cancel_session",
    description:
      "Cancel a running session. Sends SIGTERM, then SIGKILL after 5 seconds if still running.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to cancel" },
      },
      required: ["session_id"],
    },
    group: "channel",
    handler: async (args) => {
      const success = sessionManager.cancelSession(args.session_id as string);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success }) }],
      };
    },
  });

  tools.push({
    name: "list_sessions",
    description: "List all active channel sessions. Optionally include completed sessions.",
    inputSchema: {
      type: "object",
      properties: {
        include_completed: {
          type: "boolean",
          description: "Include completed/failed/cancelled sessions (default: false)",
        },
      },
    },
    group: "channel",
    handler: async (args) => {
      const sessions = sessionManager.listSessions(args.include_completed as boolean | undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessions }) }],
      };
    },
  });

  return tools;
}

// ─── Tool Group Resolution ───────────────────────────────────────────────────

function resolveToolGroups(mode: string): Set<ToolGroup> {
  switch (mode) {
    case "low-level":
      return new Set(["low-level"]);
    case "agentic":
      return new Set(["agentic"]);
    case "channel":
      return new Set(["channel"]);
    case "all":
    default:
      return new Set(["low-level", "agentic", "channel"]);
  }
}

// ─── Server Setup ────────────────────────────────────────────────────────────

async function main() {
  const toolMode = (process.env.CLAUDISH_MCP_TOOLS || "all").toLowerCase();
  const enabledGroups = resolveToolGroups(toolMode);

  // Create server with channel capability
  const server = new Server(
    { name: "claudish", version: "9.0.0" },
    {
      capabilities: {
        ...(enabledGroups.has("channel") ? { experimental: { "claude/channel": {} } } : {}),
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  );

  // Create session manager with channel notification bridge
  const sessionManager = new SessionManager({
    onStateChange: (sessionId, event) => {
      const notificationContent =
        event.type === "failed"
          ? `${event.content}\n\nTo report this error, use the report_error tool with error_type: "provider_failure" and model: "${event.model}".`
          : event.content;
      server.notification({
        method: "notifications/claude/channel",
        params: {
          content: notificationContent,
          meta: {
            session_id: sessionId,
            event: event.type,
            model: event.model,
            elapsed_seconds: String(event.elapsedSeconds),
            ...event.extraMeta,
          },
        },
      });
    },
  });

  // Build tool registry
  const allTools = defineTools(sessionManager);
  const enabledTools = allTools.filter((t) => enabledGroups.has(t.group));
  const toolMap = new Map(enabledTools.map((t) => [t.name, t]));

  console.error(`[claudish] MCP server started (tools: ${toolMode}, ${enabledTools.length} tools)`);

  // Register ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Register CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Error: Unknown tool "${name}"` }],
        isError: true,
      };
    }
    try {
      return await tool.handler(args ?? {});
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on shutdown
  process.on("SIGTERM", () => {
    sessionManager.shutdownAll().catch(() => {});
  });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Entry point for MCP server mode.
 * Called from index.ts when --mcp flag is used.
 */
export function startMcpServer() {
  main().catch((error) => {
    console.error("[claudish] MCP fatal error:", error);
    process.exit(1);
  });
}
