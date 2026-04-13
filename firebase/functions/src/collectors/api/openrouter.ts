import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;   // USD per token (as string)
    completion?: string;
    image?: string;
    request?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
  supported_parameters?: string[];
  per_request_limits?: Record<string, string> | null;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

function parsePrice(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = parseFloat(val);
  if (isNaN(n)) return undefined;
  // OpenRouter prices are per token; convert to per million tokens and round to
  // 6 decimal places to eliminate floating-point noise (e.g. 0.30000000000000004)
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

export class OpenRouterCollector extends BaseCollector {
  readonly collectorId = "openrouter-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`OpenRouter API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as OpenRouterResponse;

      for (const m of data.data ?? []) {
        const inputPrice = parsePrice(m.pricing?.prompt);
        const outputPrice = parsePrice(m.pricing?.completion);

        const pricing =
          inputPrice !== undefined && outputPrice !== undefined
            ? { input: inputPrice, output: outputPrice }
            : undefined;

        const contextWindow = m.context_length ?? m.top_provider?.context_length;

        // Determine provider from model ID prefix (e.g., "anthropic/claude-3" -> "anthropic")
        const slashIdx = m.id.indexOf("/");
        const providerSlug = slashIdx > 0 ? m.id.slice(0, slashIdx) : undefined;
        // Canonical ID: the schema gate (BaseCollector.makeResult) strips
        // the vendor prefix and `:free` suffix — pass the raw id through.
        const canonicalId = m.id;

        // Vision: modality field contains "image" or "vision"
        const isVision = m.architecture?.modality?.includes("image") ||
          m.architecture?.modality?.includes("vision") || false;

        const params = m.supported_parameters ?? [];

        // Thinking: explicit "reasoning" parameter or model name signals it
        const hasThinking =
          params.includes("reasoning") ||
          m.id.toLowerCase().includes("thinking") ||
          m.id.toLowerCase().includes("r1") ||
          m.name?.toLowerCase().includes("thinking") || false;

        // Tools/function calling
        const hasTools = params.includes("tools");

        // JSON / structured output
        const hasJsonMode = params.includes("response_format");

        // Prompt caching
        const hasPromptCaching = params.includes("cache_control") || params.includes("prompt_caching");

        models.push({
          collectorId: this.collectorId,
          confidence: "aggregator_reported",
          sourceUrl: "https://openrouter.ai/api/v1/models",
          externalId: m.id,
          canonicalId,
          displayName: m.name,
          description: m.description,
          provider: providerSlug,
          pricing,
          contextWindow,
          maxOutputTokens: m.top_provider?.max_completion_tokens,
          capabilities: {
            vision: isVision,
            tools: hasTools,
            streaming: true,
            jsonMode: hasJsonMode,
            structuredOutput: hasJsonMode,
            thinking: hasThinking,
            batchApi: false,
            citations: false,
            codeExecution: false,
            pdfInput: false,
            fineTuning: false,
            promptCaching: hasPromptCaching,
          },
          status: "active",
        });
      }

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
