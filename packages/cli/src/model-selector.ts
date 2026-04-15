/**
 * Model Selector with Fuzzy Search
 *
 * Uses @inquirer/search for fuzzy search model selection
 */

import { search, select, input, confirm } from "@inquirer/prompts";
import {
  fetchLiteLLMModels,
  getRecommendedModelsSync,
  type RecommendedModelEntry,
} from "./model-loader.js";
import { getProviderByName, isProviderAvailable } from "./providers/provider-definitions.js";

/**
 * Model data structure
 */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  pricing?: {
    input: string;
    output: string;
    average: string;
  };
  context?: string;
  contextLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isFree?: boolean;
  source?:
    | "OpenRouter"
    | "Zen"
    | "xAI"
    | "Gemini"
    | "OpenAI"
    | "OpenAI Codex"
    | "GLM"
    | "GLM Coding"
    | "MiniMax"
    | "MiniMax Coding"
    | "Kimi"
    | "Kimi Coding"
    | "Z.AI"
    | "OllamaCloud"
    | "LiteLLM"
    | "Recommended"; // Which platform the model is from
}

/**
 * Load recommended models from the Firebase-backed loader.
 * Entries are stamped with source "Recommended" for the interactive picker.
 */
function loadRecommendedModels(): ModelInfo[] {
  try {
    const doc = getRecommendedModelsSync();
    return doc.models.map((model: RecommendedModelEntry) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      provider: model.provider,
      pricing: model.pricing,
      context: model.context,
      contextLength: parseContextString(model.context),
      supportsTools: model.supportsTools,
      supportsReasoning: model.supportsReasoning,
      supportsVision: model.supportsVision,
      source: "Recommended" as const,
    }));
  } catch {
    return [];
  }
}

/** Parse "196K" → 196000, "1M" → 1000000. */
function parseContextString(ctx?: string): number {
  if (!ctx || ctx === "N/A") return 0;
  const upper = ctx.toUpperCase();
  if (upper.endsWith("M")) return parseFloat(upper) * 1_000_000;
  if (upper.endsWith("K")) return parseFloat(upper) * 1000;
  const n = parseInt(upper, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Get context window for xAI model (not returned by API, hardcoded from docs)
 */
function getXAIContextWindow(modelId: string): { context: string; contextLength: number } {
  const id = modelId.toLowerCase();
  if (id.includes("grok-4.1-fast") || id.includes("grok-4-1-fast")) {
    return { context: "2M", contextLength: 2000000 };
  }
  if (id.includes("grok-4-fast")) {
    return { context: "2M", contextLength: 2000000 };
  }
  if (id.includes("grok-code-fast")) {
    return { context: "256K", contextLength: 256000 };
  }
  if (id.includes("grok-4")) {
    return { context: "256K", contextLength: 256000 };
  }
  if (id.includes("grok-3")) {
    return { context: "131K", contextLength: 131072 };
  }
  if (id.includes("grok-2")) {
    return { context: "131K", contextLength: 131072 };
  }
  return { context: "131K", contextLength: 131072 }; // Default for older models
}

/**
 * Fetch models from xAI using /v1/language-models endpoint
 * This endpoint returns pricing info (but not context_length)
 */
async function fetchXAIModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch("https://api.x.ai/v1/language-models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { models?: Array<Record<string, any>> };
    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    return data.models
      .filter((model: any) => !model.id.includes("image") && !model.id.includes("imagine")) // Skip image models
      .map((model: any) => {
        // Pricing from API: prompt_text_token_price is in nano-dollars (10^-9) per token
        // Convert to $/1M tokens: price * 1M / 10^9 = price / 1000
        const inputPricePerM = (model.prompt_text_token_price || 0) / 1000;
        const outputPricePerM = (model.completion_text_token_price || 0) / 1000;
        const avgPrice = (inputPricePerM + outputPricePerM) / 2;

        const { context, contextLength } = getXAIContextWindow(model.id);
        const supportsVision = (model.input_modalities || []).includes("image");
        const supportsReasoning = model.id.includes("reasoning");

        return {
          id: `xai@${model.id}`,
          name: model.id,
          description: `xAI ${supportsReasoning ? "reasoning " : ""}model`,
          provider: "xAI",
          pricing: {
            input: `$${inputPricePerM.toFixed(2)}`,
            output: `$${outputPricePerM.toFixed(2)}`,
            average: `$${avgPrice.toFixed(2)}/1M`,
          },
          context,
          contextLength,
          supportsTools: true,
          supportsReasoning,
          supportsVision,
          isFree: false,
          source: "xAI" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get pricing for Gemini models
 * Hardcoded based on https://ai.google.dev/gemini-api/docs/pricing
 */
function getGeminiPricing(modelId: string): { input: string; output: string; average: string } {
  const id = modelId.toLowerCase();

  // Gemini 3.1 Pro Preview / Gemini 3 Pro Preview
  if (id.includes("gemini-3.1-pro") || id.includes("gemini-3-pro")) {
    return { input: "$2.00", output: "$12.00", average: "$7.00/1M" };
  }
  // Gemini 3 Flash Preview
  if (id.includes("gemini-3-flash")) {
    return { input: "$0.50", output: "$3.00", average: "$1.75/1M" };
  }
  // Gemini 2.5 Pro
  if (id.includes("gemini-2.5-pro")) {
    return { input: "$1.25", output: "$10.00", average: "$5.63/1M" };
  }
  // Gemini 2.5 Flash-Lite
  if (id.includes("gemini-2.5-flash-lite")) {
    return { input: "$0.10", output: "$0.40", average: "$0.25/1M" };
  }
  // Gemini 2.5 Flash
  if (id.includes("gemini-2.5-flash")) {
    return { input: "$0.30", output: "$2.50", average: "$1.40/1M" };
  }
  // Gemini 2.0 Pro Experimental / 2.0 Pro
  if (id.includes("gemini-2.0-pro")) {
    return { input: "$1.25", output: "$5.00", average: "$3.13/1M" };
  }
  // Gemini 2.0 Flash-Lite
  if (id.includes("gemini-2.0-flash-lite")) {
    return { input: "$0.075", output: "$0.30", average: "$0.19/1M" };
  }
  // Gemini 2.0 Flash
  if (id.includes("gemini-2.0-flash")) {
    return { input: "$0.10", output: "$0.40", average: "$0.25/1M" };
  }
  // Gemini 1.5 Pro
  if (id.includes("gemini-1.5-pro")) {
    return { input: "$1.25", output: "$5.00", average: "$3.13/1M" };
  }
  // Gemini 1.5 Flash-8b
  if (id.includes("gemini-1.5-flash-8b")) {
    return { input: "$0.0375", output: "$0.15", average: "$0.09/1M" };
  }
  // Gemini 1.5 Flash
  if (id.includes("gemini-1.5-flash")) {
    return { input: "$0.075", output: "$0.30", average: "$0.19/1M" };
  }

  // Default to N/A instead of showing wrong prices
  return { input: "N/A", output: "N/A", average: "N/A" };
}

/**
 * Fetch models from Google Gemini
 */
async function fetchGeminiModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { models?: Array<Record<string, any>> };
    if (!data.models || !Array.isArray(data.models)) {
      return [];
    }

    // Filter for models that support generateContent
    return data.models
      .filter((model: any) => {
        const methods = model.supportedGenerationMethods || [];
        return methods.includes("generateContent");
      })
      .map((model: any) => {
        // Extract model name from "models/gemini-..." format
        const modelName = model.name.replace("models/", "");
        return {
          id: `google@${modelName}`,
          name: model.displayName || modelName,
          description: model.description || `Google Gemini model`,
          provider: "Gemini",
          pricing: getGeminiPricing(modelName),
          context: "128K",
          contextLength: 128000,
          supportsTools: true,
          supportsReasoning: false,
          supportsVision: true,
          isFree: false,
          source: "Gemini" as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get free models. Free model discovery used to come from OpenCode Zen
 * (via models.dev), which has been removed. Free models now live in the
 * Firebase recommended catalog; this stub returns [] so `selectModel` can
 * surface the "no free models available" UX when `--free` is used.
 */
async function getFreeModels(): Promise<ModelInfo[]> {
  return [];
}

/**
 * Gather models for the interactive picker. Fetches from direct-provider
 * catalogs and subscription/known-model lists. OpenRouter's full catalog is
 * NOT fetched — use `claudish -s <query>` to hit Firebase search.
 */
async function getAllModelsForSearch(forceUpdate = false): Promise<ModelInfo[]> {
  // Check for LiteLLM configuration
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmApiKey = process.env.LITELLM_API_KEY;

  const allEntries: Array<{
    name: string;
    provider?: string;
    promise: () => Promise<ModelInfo[]>;
  }> = [
    { name: "xAI", provider: "xai", promise: () => fetchXAIModels() },
    { name: "Gemini", provider: "google", promise: () => fetchGeminiModels() },
    // OpenAI / GLM / GLM Coding / OllamaCloud / Zen / Zen Go catalog discovery
    // removed — these used models.dev which is no longer queried. The model
    // IDs still route via `--model oai@<id>`, `--model glm@<id>`, etc.; they
    // just don't appear in the picker. OpenAI lives in the Firebase recommended
    // catalog; OpenAI Codex still ships via getKnownModels below.
    // Subscription/direct-API providers without catalog APIs — use known models
    {
      name: "MiniMax",
      provider: "minimax",
      promise: () => Promise.resolve(getKnownModels("minimax")),
    },
    {
      name: "MiniMax Coding",
      provider: "minimax-coding",
      promise: () => Promise.resolve(getKnownModels("minimax-coding")),
    },
    { name: "Kimi", provider: "kimi", promise: () => Promise.resolve(getKnownModels("kimi")) },
    {
      name: "Kimi Coding",
      provider: "kimi-coding",
      promise: () => Promise.resolve(getKnownModels("kimi-coding")),
    },
    { name: "Z.AI", provider: "zai", promise: () => Promise.resolve(getKnownModels("zai")) },
    {
      name: "OpenAI Codex",
      provider: "openai-codex",
      promise: () => Promise.resolve(getKnownModels("openai-codex")),
    },
  ];

  if (litellmBaseUrl && litellmApiKey) {
    allEntries.push({
      name: "LiteLLM",
      provider: "litellm",
      promise: () => fetchLiteLLMModels(litellmBaseUrl, litellmApiKey, forceUpdate),
    });
  }

  // Filter to only available providers, then launch fetches in parallel
  const fetchEntries = allEntries
    .filter((e) => {
      if (!e.provider) return true; // No provider mapping — let the fetcher decide
      const def = getProviderByName(e.provider);
      return def ? isProviderAvailable(def) : true;
    })
    .map((e) => ({ name: e.name, promise: e.promise() }));

  // Use allSettled so one failing provider can't break the whole list
  const settled = await Promise.allSettled(fetchEntries.map((e) => e.promise));

  const fetchResults: Record<string, ModelInfo[]> = {};
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    fetchResults[fetchEntries[i].name] = result.status === "fulfilled" ? result.value : [];
  }

  // Helper: get results for a provider (empty array if filtered out or failed)
  const r = (name: string) => fetchResults[name] || [];

  // Combine results: direct providers first, then subscription providers,
  // then LiteLLM. (OpenRouter's full catalog is NOT aggregated here — use
  // `claudish -s`. Zen / GLM / OllamaCloud catalogs are no longer fetched
  // — those models live in the Firebase recommended catalog now.)
  const allModels = [
    ...r("xAI"),
    ...r("Gemini"),
    ...r("OpenAI Codex"),
    ...r("MiniMax"),
    ...r("MiniMax Coding"),
    ...r("Kimi"),
    ...r("Kimi Coding"),
    ...r("Z.AI"),
    ...r("LiteLLM"),
  ];

  return allModels;
}

/**
 * Format model for display in selector
 */
function formatModelChoice(model: ModelInfo, showSource = false): string {
  const caps = [
    model.supportsTools ? "T" : "",
    model.supportsReasoning ? "R" : "",
    model.supportsVision ? "V" : "",
  ]
    .filter(Boolean)
    .join("");

  const capsStr = caps ? ` [${caps}]` : "";
  const priceStr = model.pricing?.average || "N/A";
  const ctxStr = model.context || "N/A";

  // Show source for free models list (OpenRouter vs Zen)
  if (showSource && model.source) {
    const sourceTagMap: Record<string, string> = {
      Zen: "Zen",
      OpenRouter: "OR",
      xAI: "xAI",
      Gemini: "Gem",
      OpenAI: "OAI",
      "OpenAI Codex": "CX",
      GLM: "GLM",
      "GLM Coding": "GC",
      MiniMax: "MM",
      "MiniMax Coding": "MMC",
      Kimi: "Kimi",
      "Kimi Coding": "KC",
      "Z.AI": "ZAI",
      OllamaCloud: "OC",
      LiteLLM: "LL",
    };
    const sourceTag = sourceTagMap[model.source] || model.source;
    return `${sourceTag} ${model.id} (${priceStr}, ${ctxStr}${capsStr})`;
  }

  return `${model.id} (${model.provider}, ${priceStr}, ${ctxStr}${capsStr})`;
}

/**
 * Provider filter aliases for @prefix search syntax
 * Maps user-typed aliases to the ModelInfo.source value
 */
const PROVIDER_FILTER_ALIASES: Record<string, string> = {
  // Full names
  zen: "Zen",
  openrouter: "OpenRouter",
  or: "OpenRouter",
  xai: "xAI",
  gemini: "Gemini",
  gem: "Gemini",
  google: "Gemini",
  openai: "OpenAI",
  oai: "OpenAI",
  cx: "OpenAI Codex",
  codex: "OpenAI Codex",
  "openai-codex": "OpenAI Codex",
  glm: "GLM",
  "glm-coding": "GLM Coding",
  gc: "GLM Coding",
  minimax: "MiniMax",
  mm: "MiniMax",
  mmc: "MiniMax Coding",
  "minimax-coding": "MiniMax Coding",
  kimi: "Kimi",
  moon: "Kimi",
  moonshot: "Kimi",
  kc: "Kimi Coding",
  "kimi-coding": "Kimi Coding",
  zai: "Z.AI",
  ollamacloud: "OllamaCloud",
  oc: "OllamaCloud",
  litellm: "LiteLLM",
  ll: "LiteLLM",
};

/**
 * Parse search term for @provider filter prefix
 * Returns { provider: source string or null, searchTerm: remaining text }
 *
 * Examples:
 *   "@xai"        → { provider: "xAI", searchTerm: "" }
 *   "@xai grok"   → { provider: "xAI", searchTerm: "grok" }
 *   "@ll gemini"  → { provider: "LiteLLM", searchTerm: "gemini" }
 *   "grok"        → { provider: null, searchTerm: "grok" }
 */
function parseProviderFilter(term: string): { provider: string | null; searchTerm: string } {
  if (!term.startsWith("@")) {
    return { provider: null, searchTerm: term };
  }

  const withoutAt = term.slice(1);
  const spaceIdx = withoutAt.indexOf(" ");

  let prefix: string;
  let rest: string;
  if (spaceIdx === -1) {
    prefix = withoutAt;
    rest = "";
  } else {
    prefix = withoutAt.slice(0, spaceIdx);
    rest = withoutAt.slice(spaceIdx + 1).trim();
  }

  const source = PROVIDER_FILTER_ALIASES[prefix.toLowerCase()];
  if (source) {
    return { provider: source, searchTerm: rest };
  }

  // Partial match: find aliases that start with the typed prefix
  const partialMatch = Object.entries(PROVIDER_FILTER_ALIASES).find(([alias]) =>
    alias.startsWith(prefix.toLowerCase())
  );
  if (partialMatch) {
    return { provider: partialMatch[1], searchTerm: rest };
  }

  // No match — treat the whole thing as a regular search term
  return { provider: null, searchTerm: term };
}

/**
 * Fuzzy match score
 */
function fuzzyMatch(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact match
  if (lowerText === lowerQuery) return 1;

  // Contains match
  if (lowerText.includes(lowerQuery)) return 0.8;

  // Separator-normalized match: treat spaces, hyphens, dots, underscores as equivalent
  // This lets "glm 5" match "glm-5", "gpt4o" match "gpt-4o", etc.
  const normSep = (s: string) => s.replace(/[\s\-_.]/g, "");
  const tn = normSep(lowerText);
  const qn = normSep(lowerQuery);
  if (tn === qn) return 0.95;
  if (tn.includes(qn)) return 0.75;

  // Fuzzy character match
  let queryIdx = 0;
  let score = 0;
  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      score++;
      queryIdx++;
    }
  }

  return queryIdx === lowerQuery.length ? (score / lowerQuery.length) * 0.6 : 0;
}

export interface ModelSelectorOptions {
  freeOnly?: boolean;
  recommended?: boolean;
  message?: string;
  forceUpdate?: boolean;
}

/**
 * Select a model interactively with fuzzy search
 */
export async function selectModel(options: ModelSelectorOptions = {}): Promise<string> {
  const { freeOnly = false, recommended = true, message, forceUpdate = false } = options;

  let models: ModelInfo[];

  if (freeOnly) {
    models = await getFreeModels();
    if (models.length === 0) {
      throw new Error("No free models available");
    }
  } else {
    // Fetch all models from all providers (xAI, Gemini, OpenAI, LiteLLM, etc.)
    const [allModels, recommendedModels] = await Promise.all([
      getAllModelsForSearch(forceUpdate),
      Promise.resolve(recommended ? loadRecommendedModels() : []),
    ]);

    // Build prioritized list: Recommended (Firebase) -> direct API -> OpenRouter
    const seenIds = new Set<string>();
    models = [];

    // 1. Add recommended models first (Firebase curated catalog)
    for (const m of recommendedModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }

    // 2. Add direct API models (xAI, Gemini, OpenAI, LiteLLM) - user has keys for these
    for (const m of allModels.filter((m) => m.source && m.source !== "OpenRouter")) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }

    // 4. Add remaining OpenRouter models
    for (const m of allModels.filter((m) => m.source === "OpenRouter")) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        models.push(m);
      }
    }
  }

  // Build provider filter choices from actually loaded models
  const providerCounts = new Map<string, number>();
  for (const m of models) {
    if (m.source) {
      providerCounts.set(m.source, (providerCounts.get(m.source) || 0) + 1);
    }
  }

  // Allow Escape key to cleanly exit prompts
  const ac = new AbortController();
  const onData = (data: Buffer) => {
    // Escape key sends \x1b — but arrow keys and other sequences also start with \x1b
    // Only treat bare \x1b (length 1) as Escape; multi-byte sequences are arrow keys etc.
    if (data.length === 1 && data[0] === 0x1b) ac.abort();
  };
  process.stdin.on("data", onData);
  const cleanupKeypress = () => process.stdin.removeListener("data", onData);

  try {
    // Provider selection step (skip if freeOnly or custom message — those are special flows)
    let filteredModels = models;
    if (!freeOnly && !message && providerCounts.size > 1) {
      const providerChoices = [
        { name: `All providers (${models.length} models)`, value: "__all__" },
        ...Array.from(providerCounts.entries())
          .sort((a, b) => b[1] - a[1]) // Sort by model count descending
          .map(([source, count]) => ({
            name: `${source} (${count})`,
            value: source,
          })),
      ];

      const selectedProvider = await select(
        {
          message: "Filter by provider:",
          choices: providerChoices,
        },
        { signal: ac.signal }
      );

      if (selectedProvider !== "__all__") {
        filteredModels = models.filter((m) => m.source === selectedProvider);
      }
    }

    const promptMessage =
      message || (freeOnly ? "Select a FREE model:" : "Select a model (type to search):");

    const selected = await search<string>(
      {
        message: promptMessage,
        pageSize: 20,
        source: async (term) => {
          if (!term) {
            // Show all/top models when no search term (up to 30)
            return filteredModels.slice(0, 30).map((m) => ({
              name: formatModelChoice(m, true), // Always show source
              value: m.id,
              description: m.description?.slice(0, 80),
            }));
          }

          // Also support @provider prefix as power-user shortcut
          const { provider: filterProvider, searchTerm } = parseProviderFilter(term);

          let pool = filteredModels;
          if (filterProvider) {
            pool = models.filter((m) => m.source === filterProvider);
          }

          if (!searchTerm) {
            return pool.slice(0, 30).map((m) => ({
              name: formatModelChoice(m, true),
              value: m.id,
              description: m.description?.slice(0, 80),
            }));
          }

          // Fuzzy search within the (possibly filtered) pool
          const results = pool
            .map((m) => ({
              model: m,
              score: Math.max(
                fuzzyMatch(m.id, searchTerm),
                fuzzyMatch(m.name, searchTerm),
                fuzzyMatch(m.provider, searchTerm) * 0.5
              ),
            }))
            .filter((r) => r.score > 0.1)
            .sort((a, b) => b.score - a.score)
            .slice(0, 30);

          return results.map((r) => ({
            name: formatModelChoice(r.model, true), // Always show source
            value: r.model.id,
            description: r.model.description?.slice(0, 80),
          }));
        },
      },
      { signal: ac.signal }
    );

    return selected;
  } catch (err: unknown) {
    if (
      ac.signal.aborted ||
      (err && typeof err === "object" && "name" in err && err.name === "AbortError")
    ) {
      console.log("");
      process.exit(0);
    }
    throw err;
  } finally {
    cleanupKeypress();
  }
}

/**
 * Provider choices for profile model configuration.
 *
 * Each entry maps to a ProviderDefinition via `provider` field.
 * Availability is checked via isProviderAvailable() — no more ad-hoc envVar checks.
 */
const ALL_PROVIDER_CHOICES: Array<{
  name: string;
  value: string;
  description: string;
  provider?: string; // ProviderDefinition.name — if set, availability is checked
}> = [
  {
    name: "Skip (keep Claude default)",
    value: "skip",
    description: "Use native Claude model for this tier",
  },
  {
    name: "OpenRouter",
    value: "openrouter",
    description: "580+ models via unified API",
    provider: "openrouter",
  },
  {
    name: "OpenCode Zen",
    value: "zen",
    description: "Free models, no API key needed",
    provider: "opencode-zen",
  },
  { name: "Google Gemini", value: "google", description: "Direct API", provider: "google" },
  { name: "OpenAI", value: "openai", description: "Direct API", provider: "openai" },
  {
    name: "OpenAI Codex",
    value: "openai-codex",
    description: "ChatGPT Plus/Pro subscription (Responses API)",
    provider: "openai-codex",
  },
  { name: "xAI / Grok", value: "xai", description: "Direct API", provider: "xai" },
  { name: "MiniMax", value: "minimax", description: "Direct API", provider: "minimax" },
  {
    name: "MiniMax Coding",
    value: "minimax-coding",
    description: "Coding subscription",
    provider: "minimax-coding",
  },
  { name: "Kimi / Moonshot", value: "kimi", description: "Direct API", provider: "kimi" },
  {
    name: "Kimi Coding",
    value: "kimi-coding",
    description: "Coding subscription",
    provider: "kimi-coding",
  },
  { name: "GLM / Zhipu", value: "glm", description: "Direct API", provider: "glm" },
  {
    name: "GLM Coding Plan",
    value: "glm-coding",
    description: "Coding subscription",
    provider: "glm-coding",
  },
  { name: "Z.AI", value: "zai", description: "Direct API", provider: "zai" },
  {
    name: "OllamaCloud",
    value: "ollamacloud",
    description: "Cloud models",
    provider: "ollamacloud",
  },
  {
    name: "Ollama (local)",
    value: "ollama",
    description: "Local Ollama instance",
    provider: "ollama",
  },
  {
    name: "LM Studio (local)",
    value: "lmstudio",
    description: "Local LM Studio instance",
    provider: "lmstudio",
  },
  {
    name: "Enter custom model",
    value: "custom",
    description: "Type a provider@model specification",
  },
];

/**
 * Get provider choices filtered by provider availability.
 * Uses isProviderAvailable() from ProviderDefinition — each provider validates
 * itself (API keys, OAuth credentials, local service, public fallback).
 */
function getProviderChoices() {
  return ALL_PROVIDER_CHOICES.filter((choice) => {
    if (!choice.provider) return true; // skip, custom — always shown
    const def = getProviderByName(choice.provider);
    return def ? isProviderAvailable(def) : true;
  });
}

/**
 * Model ID prefix for each provider
 */
const PROVIDER_MODEL_PREFIX: Record<string, string> = {
  google: "google@",
  openai: "oai@",
  "openai-codex": "cx@",
  xai: "xai@",
  minimax: "mm@",
  kimi: "kimi@",
  "minimax-coding": "mmc@",
  "kimi-coding": "kc@",
  glm: "glm@",
  "glm-coding": "gc@",
  zai: "zai@",
  ollamacloud: "oc@",
  ollama: "ollama@",
  lmstudio: "lmstudio@",
  zen: "zen@",
  openrouter: "openrouter@",
};

/**
 * Map provider value to ModelInfo source field for filtering fetched models
 */
const PROVIDER_SOURCE_FILTER: Record<string, string> = {
  openrouter: "OpenRouter",
  google: "Gemini",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  xai: "xAI",
  glm: "GLM",
  "glm-coding": "GLM Coding",
  minimax: "MiniMax",
  "minimax-coding": "MiniMax Coding",
  kimi: "Kimi",
  "kimi-coding": "Kimi Coding",
  zai: "Z.AI",
  ollamacloud: "OllamaCloud",
  zen: "Zen",
};

/**
 * Well-known models per provider (fallback when API fetch returns no results)
 */
function getKnownModels(provider: string): ModelInfo[] {
  const known: Record<
    string,
    Array<{ id: string; name: string; context?: string; description?: string }>
  > = {
    google: [
      { id: "google@gemini-2.5-pro", name: "Gemini 2.5 Pro", context: "1M" },
      { id: "google@gemini-2.5-flash", name: "Gemini 2.5 Flash", context: "1M" },
      { id: "google@gemini-2.0-flash", name: "Gemini 2.0 Flash", context: "1M" },
    ],
    openai: [
      {
        id: "oai@gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        context: "400K",
        description: "Latest coding model",
      },
      {
        id: "oai@gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        context: "400K",
        description: "Coding model",
      },
      {
        id: "oai@gpt-5.1-codex-mini",
        name: "GPT-5.1 Codex Mini",
        context: "400K",
        description: "Fast coding model",
      },
      { id: "oai@o3", name: "o3", context: "200K", description: "Reasoning model" },
      { id: "oai@o4-mini", name: "o4-mini", context: "200K", description: "Fast reasoning model" },
      { id: "oai@gpt-4.1", name: "GPT-4.1", context: "1M", description: "Large context model" },
    ],
    "openai-codex": [
      {
        id: "cx@gpt-5.4",
        name: "GPT-5.4",
        context: "200K",
        description: "Latest OpenAI Codex model",
      },
      {
        id: "cx@gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        context: "200K",
        description: "Codex coding-optimized model",
      },
      {
        id: "cx@gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        context: "200K",
        description: "Previous Codex model",
      },
    ],
    xai: [
      { id: "xai@grok-4", name: "Grok 4", context: "256K" },
      { id: "xai@grok-4-fast", name: "Grok 4 Fast", context: "2M" },
      {
        id: "xai@grok-code-fast-1",
        name: "Grok Code Fast 1",
        context: "256K",
        description: "Optimized for coding",
      },
    ],
    minimax: [
      {
        id: "mm@minimax-m2.1",
        name: "MiniMax M2.1",
        context: "196K",
        description: "Lightweight coding model",
      },
    ],
    "minimax-coding": [
      {
        id: "mmc@minimax-m2.5",
        name: "MiniMax M2.5",
        context: "196K",
        description: "MiniMax Coding subscription model",
      },
      {
        id: "mmc@minimax-m2.1",
        name: "MiniMax M2.1",
        context: "196K",
        description: "MiniMax Coding subscription model",
      },
    ],
    kimi: [
      { id: "kimi@kimi-k2-thinking-turbo", name: "Kimi K2 Thinking Turbo", context: "128K" },
      { id: "kimi@moonshot-v1-128k", name: "Moonshot V1 128K", context: "128K" },
    ],
    "kimi-coding": [
      {
        id: "kc@kimi-for-coding",
        name: "Kimi for Coding",
        context: "128K",
        description: "Kimi Coding subscription model",
      },
    ],
    glm: [
      {
        id: "glm@glm-5",
        name: "GLM-5",
        context: "200K",
        description: "Latest GLM model with reasoning",
      },
      {
        id: "glm@glm-4.7",
        name: "GLM-4.7",
        context: "200K",
        description: "GLM 4.7 with reasoning",
      },
      {
        id: "glm@glm-4.7-flash",
        name: "GLM-4.7 Flash",
        context: "200K",
        description: "Fast GLM 4.7",
      },
      { id: "glm@glm-4.6", name: "GLM-4.6", context: "200K" },
      { id: "glm@glm-4.5-flash", name: "GLM-4.5 Flash", context: "128K" },
    ],
    zai: [{ id: "zai@glm-4.7", name: "GLM 4.7 (Z.AI)", context: "128K" }],
    ollamacloud: [
      { id: "oc@glm-5", name: "GLM-5", context: "203K", description: "GLM-5 on OllamaCloud" },
      {
        id: "oc@deepseek-v3.2",
        name: "DeepSeek V3.2",
        context: "164K",
        description: "DeepSeek V3.2 on OllamaCloud",
      },
      {
        id: "oc@gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        context: "1M",
        description: "Gemini 3 Pro on OllamaCloud",
      },
      {
        id: "oc@kimi-k2.5",
        name: "Kimi K2.5",
        context: "262K",
        description: "Kimi K2.5 on OllamaCloud",
      },
      {
        id: "oc@qwen3-coder-next",
        name: "Qwen3 Coder Next",
        context: "262K",
        description: "Qwen3 Coder on OllamaCloud",
      },
      {
        id: "oc@minimax-m2.1",
        name: "MiniMax M2.1",
        context: "205K",
        description: "MiniMax M2.1 on OllamaCloud",
      },
    ],
  };

  // Map provider key → source tag for display in selector
  const sourceMap: Record<string, ModelInfo["source"]> = {
    minimax: "MiniMax",
    "minimax-coding": "MiniMax Coding",
    kimi: "Kimi",
    "kimi-coding": "Kimi Coding",
    zai: "Z.AI",
    glm: "GLM",
    "glm-coding": "GLM Coding",
    ollamacloud: "OllamaCloud",
    google: "Gemini",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    xai: "xAI",
  };

  const providerDisplay = provider.charAt(0).toUpperCase() + provider.slice(1);
  return (known[provider] || []).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description || `${providerDisplay} model`,
    provider: providerDisplay,
    context: m.context,
    supportsTools: true,
    source: sourceMap[provider],
  }));
}

/**
 * Filter models by provider using source tag or ID prefix
 */
function filterModelsByProvider(allModels: ModelInfo[], provider: string): ModelInfo[] {
  const source = PROVIDER_SOURCE_FILTER[provider];
  if (source) {
    return allModels.filter((m) => m.source === source);
  }

  const prefix = PROVIDER_MODEL_PREFIX[provider];
  if (prefix) {
    return allModels.filter((m) => m.id.startsWith(prefix));
  }

  return [];
}

/**
 * Select a model from a specific provider with filterable search
 */
async function selectModelFromProvider(
  provider: string,
  tierName: string,
  allModels: ModelInfo[],
  recommendedModels: ModelInfo[]
): Promise<string> {
  const LOCAL_INPUT_PROVIDERS = new Set(["ollama", "lmstudio"]);
  const prefix = PROVIDER_MODEL_PREFIX[provider] || `${provider}@`;

  // Local providers: just ask for model name
  if (LOCAL_INPUT_PROVIDERS.has(provider)) {
    const modelName = await input({
      message: `Enter ${provider} model name for ${tierName}:`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // Get fetched models for this provider
  let providerModels = filterModelsByProvider(allModels, provider);

  // For OpenRouter, prioritize recommended models
  if (provider === "openrouter") {
    const seenIds = new Set<string>();
    const merged: ModelInfo[] = [];
    for (const m of recommendedModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        merged.push(m);
      }
    }
    for (const m of providerModels) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        merged.push(m);
      }
    }
    providerModels = merged;
  }

  // Add known fallback models if not already present
  const knownModels = getKnownModels(provider);
  if (knownModels.length > 0) {
    const seenIds = new Set(providerModels.map((m) => m.id));
    for (const m of knownModels) {
      if (!seenIds.has(m.id)) {
        providerModels.unshift(m);
      }
    }
  }

  // No models at all: fall back to text input
  if (providerModels.length === 0) {
    const modelName = await input({
      message: `Enter ${provider} model name for ${tierName} (prefix ${prefix} will be added):`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // Show filterable search with custom entry option
  const CUSTOM_VALUE = "__custom_model__";

  const selected = await search<string>({
    message: `Select model for ${tierName} (type to filter):`,
    pageSize: 15,
    source: async (term) => {
      let filtered: ModelInfo[];

      if (term) {
        filtered = providerModels
          .map((m) => ({
            model: m,
            score: Math.max(
              fuzzyMatch(m.id, term),
              fuzzyMatch(m.name, term),
              fuzzyMatch(m.provider, term) * 0.5
            ),
          }))
          .filter((r) => r.score > 0.1)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20)
          .map((r) => r.model);
      } else {
        filtered = providerModels.slice(0, 25);
      }

      const choices = filtered.map((m) => ({
        name: formatModelChoice(m, true),
        value: m.id,
        description: m.description?.slice(0, 80),
      }));

      // Always add custom option at the end
      choices.push({
        name: ">> Enter custom model ID",
        value: CUSTOM_VALUE,
        description: `Type a custom ${provider} model name`,
      });

      return choices;
    },
  });

  if (selected === CUSTOM_VALUE) {
    const modelName = await input({
      message: `Enter model name (will be prefixed with ${prefix}):`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  return selected;
}

/**
 * Select multiple models for profile setup
 * Interactive flow: provider selection -> filterable model list for each tier
 */
export async function selectModelsForProfile(): Promise<{
  opus?: string;
  sonnet?: string;
  haiku?: string;
  subagent?: string;
}> {
  console.log("\nLoading available models...");
  const [fetchedModels, recommendedModels] = await Promise.all([
    getAllModelsForSearch(),
    Promise.resolve(loadRecommendedModels()),
  ]);

  const tiers = [
    { key: "opus" as const, name: "Opus", description: "Most capable, used for complex reasoning" },
    { key: "sonnet" as const, name: "Sonnet", description: "Balanced, used for general tasks" },
    { key: "haiku" as const, name: "Haiku", description: "Fast & cheap, used for simple tasks" },
    { key: "subagent" as const, name: "Subagent", description: "Used for spawned sub-agents" },
  ];

  const result: { opus?: string; sonnet?: string; haiku?: string; subagent?: string } = {};
  let lastProvider: string | undefined;

  console.log("\nConfigure models for each Claude tier:");

  for (const tier of tiers) {
    console.log(""); // Spacing between tiers

    // Step 1: Select provider
    const provider = await select({
      message: `Select provider for ${tier.name} tier (${tier.description}):`,
      choices: getProviderChoices(),
      default: lastProvider,
    });

    if (provider === "skip") {
      result[tier.key] = undefined;
      continue;
    }

    lastProvider = provider;

    if (provider === "custom") {
      const customModel = await input({
        message: `Enter custom model for ${tier.name} (e.g., provider@model):`,
        validate: (v) => (v.trim() ? true : "Model cannot be empty"),
      });
      result[tier.key] = customModel.trim();
      continue;
    }

    // Step 2: Select model from the chosen provider
    result[tier.key] = await selectModelFromProvider(
      provider,
      tier.name,
      fetchedModels,
      recommendedModels
    );
  }

  return result;
}

/**
 * Prompt for API key
 */
export async function promptForApiKey(): Promise<string> {
  console.log("\nOpenRouter API Key Required");
  console.log("Get your free API key from: https://openrouter.ai/keys\n");

  const apiKey = await input({
    message: "Enter your OpenRouter API key:",
    validate: (value) => {
      if (!value.trim()) {
        return "API key cannot be empty";
      }
      if (!value.startsWith("sk-or-")) {
        return 'API key should start with "sk-or-"';
      }
      return true;
    },
  });

  return apiKey;
}

/**
 * Prompt for profile name
 */
export async function promptForProfileName(existing: string[] = []): Promise<string> {
  const name = await input({
    message: "Enter profile name:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Profile name cannot be empty";
      }
      if (!/^[a-z0-9-_]+$/i.test(trimmed)) {
        return "Profile name can only contain letters, numbers, hyphens, and underscores";
      }
      if (existing.includes(trimmed)) {
        return `Profile "${trimmed}" already exists`;
      }
      return true;
    },
  });

  return name.trim();
}

/**
 * Prompt for profile description
 */
export async function promptForProfileDescription(): Promise<string> {
  const description = await input({
    message: "Enter profile description (optional):",
  });

  return description.trim();
}

/**
 * Select from existing profiles
 */
export async function selectProfile(
  profiles: { name: string; description?: string; isDefault?: boolean }[]
): Promise<string> {
  const selected = await select({
    message: "Select a profile:",
    choices: profiles.map((p) => ({
      name: p.isDefault ? `${p.name} (default)` : p.name,
      value: p.name,
      description: p.description,
    })),
  });

  return selected;
}

/**
 * Confirm action
 */
export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}
