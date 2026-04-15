import { createHash } from "node:crypto";
import type { ModelDoc } from "./schema.js";
import { ACCESS_METHODS } from "./recommender.js";

/**
 * search-bag-builder — generates LLM-backed search tokens for a ModelDoc.
 *
 * The bag is used by ?search= in query-handler.ts. It's stored on the model
 * doc and ONLY re-derived when identity fields change (hash-based cache).
 * The bag is server-internal and NEVER returned to API consumers.
 *
 * LLM: Gemini 3.1 Flash Lite (cheapest Gemini model, ~15-20 input tokens per
 * call, negligible output tokens). First backfill = 1 call per ~400 models.
 * Ongoing merge = call only when identity hash changes (rare).
 */

export const SEARCH_BAG_MODEL = "gemini-3.1-flash-lite-preview";
const LLM_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${SEARCH_BAG_MODEL}:generateContent`;
const LLM_TIMEOUT_MS = 15000;

// ─────────────────────────────────────────────────────────────
// Identity hash — stable key used to detect when the LLM needs
// to regenerate the bag. Only includes fields the prompt reads.
// ─────────────────────────────────────────────────────────────
export function computeBagHash(doc: ModelDoc): string {
  const canonical =
    `${doc.modelId}|${doc.provider}|${doc.family ?? ""}|` +
    `${doc.displayName}|${doc.description ?? ""}`;
  return createHash("sha256").update(canonical).digest("hex");
}

// ─────────────────────────────────────────────────────────────
// Access method tokens — every gateway / subscription / aggregator
// prefix + plan the model is reachable through. Deterministic
// ground truth, always unioned into the final bag regardless of
// what the LLM produced.
// ─────────────────────────────────────────────────────────────
export function extractAccessMethodTokens(providerSlug: string): string[] {
  const out = new Set<string>();

  const methods = ACCESS_METHODS[providerSlug] ?? [];
  for (const m of methods) {
    // Prefix ("gc", "zen", "oc", "kc", "mmc", "cx", "go") — always lowercase
    if (m.prefix) out.add(m.prefix.toLowerCase());
    if (m.plan) {
      const planLower = m.plan.toLowerCase();
      out.add(planLower); // full plan name, e.g. "glm coding"
      // Split on spaces and dashes so individual words are searchable too
      for (const w of planLower.split(/[\s-]+/).filter(Boolean)) {
        out.add(w);
      }
    }
  }

  // Every model is reachable via OpenRouter — add these unconditionally
  out.add("openrouter");
  out.add("or");

  return [...out];
}

// ─────────────────────────────────────────────────────────────
// Prompt template — used by buildSearchBag()
// ─────────────────────────────────────────────────────────────
function buildPrompt(doc: ModelDoc): string {
  const vision = doc.capabilities?.vision ? "true" : "false";
  const thinking = doc.capabilities?.thinking ? "true" : "false";
  const tools = doc.capabilities?.tools ? "true" : "false";
  const pInput = doc.pricing?.input ?? "unknown";
  const pOutput = doc.pricing?.output ?? "unknown";
  return `You are generating a search bag for a model catalog. Given the model below, output a JSON array of 15-40 lowercase search tokens that a user might type to find this model.

Include:
- The model ID and its tokenized components (split on dashes and dots)
- Every alias and display name
- The provider slug
- Brand synonyms for the provider (e.g. openai → chatgpt, gpt, dall-e, codex, whisper; anthropic → claude, opus, sonnet, haiku; google → gemini, gemma, palm; x-ai → grok, xai; z-ai → glm, zai, zhipu; moonshotai → kimi, moonshot; minimax → mm, mimo; qwen → dashscope)
- Model-family colloquialisms: if the id contains "sonnet" or "opus" or "haiku" or "flash" or "pro" or "mini" or "nano" or "turbo" or "lite" or "max" — include those standalone tokens
- The word "free" if pricing is zero, "cheap" if average < 1 USD per 1M, "premium" if > 10 USD per 1M
- "reasoning" / "thinking" if thinking capability is true
- "vision" / "multimodal" if vision capability is true
- "tools" if tool-calling is supported
- "coding" always (we assume coding context)
- "flagship" if the name suggests a top-tier release (e.g. has no size suffix, has highest version number you'd reasonably infer, or the word "pro" or "opus")
- "fast" if the name has "mini", "nano", "flash", "lite", "turbo", "haiku"

Rules:
- All tokens lowercase
- No spaces inside tokens (split multi-word synonyms into separate tokens)
- No duplicates
- 15 to 40 tokens total
- Output pure JSON: {"tokens": ["a", "b", ...]}

Model:
  modelId: ${doc.modelId}
  displayName: ${doc.displayName}
  family: ${doc.family ?? "none"}
  provider: ${doc.provider}
  description: ${doc.description ?? "none"}
  pricing: input=${pInput} output=${pOutput} (USD per 1M)
  capabilities: vision=${vision} thinking=${thinking} tools=${tools}`;
}

// ─────────────────────────────────────────────────────────────
// Deterministic fallback — used on LLM error or malformed output.
// Covers identity + capability + access-method tokens. Best-effort
// safety net; the LLM bag is always richer.
// ─────────────────────────────────────────────────────────────
function deterministicFallback(doc: ModelDoc): string[] {
  const out = new Set<string>();
  const push = (s: string | undefined) => {
    if (!s) return;
    const lower = s.toLowerCase();
    if (!lower || lower.includes(" ")) return;
    if (lower.length > 30) return;
    out.add(lower);
  };

  // Identity tokens
  push(doc.modelId);
  push(doc.displayName.toLowerCase().replace(/\s+/g, "-"));
  push(doc.provider);
  push(doc.family);
  // Split modelId on dashes and dots
  for (const part of doc.modelId.split(/[-.]/)) push(part);

  // Capability tokens
  if (doc.capabilities?.vision) {
    out.add("vision");
    out.add("multimodal");
  }
  if (doc.capabilities?.thinking) {
    out.add("reasoning");
    out.add("thinking");
  }
  if (doc.capabilities?.tools) out.add("tools");
  out.add("coding");

  // Pricing hints
  const input = doc.pricing?.input;
  const output = doc.pricing?.output;
  if (typeof input === "number" && typeof output === "number") {
    const avg = (input + output) / 2;
    if (input === 0 && output === 0) out.add("free");
    else if (avg < 1) out.add("cheap");
    else if (avg > 10) out.add("premium");
  }

  // Family colloquialisms — detect common names
  const FAMILY_WORDS = [
    "sonnet", "opus", "haiku",
    "flash", "pro", "mini", "nano", "turbo", "lite", "max",
  ];
  const lowerId = doc.modelId.toLowerCase();
  for (const w of FAMILY_WORDS) {
    if (lowerId.includes(w)) out.add(w);
  }

  // Union with access method tokens
  for (const t of extractAccessMethodTokens(doc.provider)) out.add(t);

  return [...out];
}

// ─────────────────────────────────────────────────────────────
// Parse + validate LLM JSON response
// ─────────────────────────────────────────────────────────────
function parseLlmTokens(raw: string): string[] | null {
  // Strip markdown fences if present — Gemini sometimes wraps JSON in ```json ... ```
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    text = text.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return null;

  // Normalize each token: lowercase, trim, split on spaces if any
  const normalized = new Set<string>();
  for (const raw of tokens) {
    if (typeof raw !== "string") continue;
    const lower = raw.toLowerCase().trim();
    if (!lower) continue;
    if (lower.includes(" ")) {
      for (const part of lower.split(/\s+/)) {
        if (part.length >= 1 && part.length <= 30) normalized.add(part);
      }
    } else if (lower.length >= 1 && lower.length <= 30) {
      normalized.add(lower);
    }
  }

  // Relaxed bounds (task said 15-60, with lower bound enforced loosely).
  // We accept 5+ to avoid false-rejecting short lists; union with
  // deterministic tokens backfills any gaps.
  if (normalized.size < 5) return null;
  if (normalized.size > 80) return null;

  return [...normalized];
}

// ─────────────────────────────────────────────────────────────
// Low-level Gemini call — one attempt, returns raw text or throws
// ─────────────────────────────────────────────────────────────
async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `${LLM_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Gemini returned empty candidate text");
  }
  return text;
}

// ─────────────────────────────────────────────────────────────
// Public — build a search bag for a model doc.
// On LLM error OR invalid output after one retry → deterministic
// fallback union'd with access-method tokens. Never throws.
// ─────────────────────────────────────────────────────────────
export async function buildSearchBag(
  doc: ModelDoc,
  apiKey: string,
): Promise<string[]> {
  const prompt = buildPrompt(doc);
  const accessTokens = extractAccessMethodTokens(doc.provider);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callGemini(prompt, apiKey);
      const tokens = parseLlmTokens(raw);
      if (!tokens) {
        if (attempt === 0) continue;
        break;
      }
      // Union LLM tokens with access method tokens (deterministic ground truth)
      const merged = new Set<string>(tokens);
      for (const t of accessTokens) merged.add(t);
      return [...merged];
    } catch (err) {
      if (attempt === 0) continue;
      console.warn(
        `[search-bag] LLM failed for ${doc.modelId}, using deterministic fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fallback: deterministic tokens (already includes access method tokens)
  console.warn(`[search-bag] using fallback bag for ${doc.modelId}`);
  return deterministicFallback(doc);
}
