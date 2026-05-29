/**
 * Probe-model discovery helpers for self-hosted / user-deployed providers.
 *
 * For providers like LiteLLM, Ollama, LM Studio, vLLM, MLX, and OllamaCloud,
 * the cloud catalog at /probeModels cannot know what's available — each
 * deployment has its own model list. These transports query the endpoint
 * directly and pick a probe-friendly model.
 *
 * Selection ranks: prefer "small" model names (mini/nano/flash/lite/haiku/
 * 1b/3b/7b match), tiebreak by alphabetical ordering for determinism.
 * Currently-loaded models (when the endpoint exposes that signal) are
 * preferred over unloaded ones — probing a loaded model is faster.
 */

import { log } from "../../logger.js";

/**
 * In-memory cache. Stores the FULL ranked list of candidates so the probe
 * loop can fall through on per-model failures (e.g. LM Studio returning
 * "model loading error" 400 for a not-loaded model — the next candidate
 * from the same cache entry might be loaded and succeed).
 */
const _cache = new Map<
  string,
  { ranked: string[]; reason?: string; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Heuristic regex matching model names indicating a small/cheap variant. */
const SMALL_MODEL_PATTERNS = [
  /\bmini\b/i,
  /\bnano\b/i,
  /\bflash\b/i,
  /\blite\b/i,
  /\bhaiku\b/i,
  /\bsmall\b/i,
  /\btiny\b/i,
  /\b[12345]b\b/i, // 1b, 2b, 3b, 5b
  /\b[78]b\b/i, // 7b, 8b
];

/**
 * Models that can't handle a `/v1/chat/completions` probe request: image
 * generation, embeddings, TTS, ASR. These often appear in /v1/models lists
 * alongside chat models (especially on LiteLLM aggregators) but will 404
 * or 400 the probe. Filter them out before ranking.
 */
const NON_CHAT_PATTERNS = [
  /\bimage\b/i,
  /\bembed/i, // embedding, embeddings
  /\bminilm\b/i, // sentence-transformers MiniLM family (Ollama lists these)
  /\bnomic-embed/i, // nomic embedding models (Ollama)
  /\bbge-/i, // BAAI BGE embeddings
  /\bmxbai-embed/i, // MixedBread AI embeddings
  /\btts\b/i,
  /\bwhisper\b/i,
  /\baudio\b/i,
  /\bvoxtral\b/i,
  /\bdall-?e\b/i,
  /\bmoderation\b/i,
  /\brerank/i,
  /\bspeech\b/i,
  /-(image|tts|audio|embedding|vision-only)(-|$)/i,
];

function isSmallName(name: string): boolean {
  return SMALL_MODEL_PATTERNS.some((re) => re.test(name));
}

/**
 * Reject non-chat-capable models (image/embedding/audio/wildcard route
 * patterns). Exported so size-sorted picks (Ollama-native path) can use
 * the same filter as name-sorted picks.
 */
export function isChatCapable(name: string): boolean {
  // Wildcard entries (e.g. "gemini/*", "gem-mad/*") are route patterns
  // returned by some LiteLLM deployments — they appear in /v1/models
  // listings but aren't pingable as concrete models.
  if (name.includes("*")) return false;
  return !NON_CHAT_PATTERNS.some((re) => re.test(name));
}

/**
 * Standard vendor prefixes that indicate a well-formed model alias rather
 * than a deployment-specific routing slug. Names without any `/` (bare
 * canonical IDs) and names with these recognized prefixes are preferred
 * over things like `gem-mad/...` or `oai-10x/...` which are LiteLLM-
 * specific aliases more likely to be stale or non-routable.
 */
const STANDARD_VENDOR_PREFIXES = [
  "openai/",
  "anthropic/",
  "google/",
  "gemini/",
  "meta/",
  "meta-llama/",
  "mistralai/",
  "mistral/",
  "x-ai/",
  "deepseek/",
  "qwen/",
  "moonshot/",
  "moonshotai/",
  "zhipuai/",
  "z-ai/",
];

function isStandardName(name: string): boolean {
  // No slash = canonical bare ID (e.g. "gpt-4o-mini", "claude-haiku-4")
  if (!name.includes("/")) return true;
  return STANDARD_VENDOR_PREFIXES.some((p) => name.toLowerCase().startsWith(p));
}

/**
 * Rank models for probe selection. Layered preference (highest priority
 * decides first):
 *   1. Chat-capable (filter): drop image/embedding/audio/wildcard rows.
 *   2. Standard names: prefer bare or recognized-vendor-prefixed IDs
 *      over deployment-specific aliases (e.g. `gem-mad/...`).
 *   3. Small variants: prefer mini/nano/flash/lite/haiku/Nb.
 *   4. Tiebreak: alphabetical for determinism.
 */
export function rankProbeCandidates(names: string[]): string[] {
  return names
    .filter(isChatCapable)
    .sort((a, b) => {
      const aStd = isStandardName(a);
      const bStd = isStandardName(b);
      if (aStd !== bStd) return aStd ? -1 : 1;
      const aSmall = isSmallName(a);
      const bSmall = isSmallName(b);
      if (aSmall !== bSmall) return aSmall ? -1 : 1;
      return a.localeCompare(b);
    });
}

interface CacheKey {
  /** Stable identifier for the provider+endpoint combination */
  key: string;
}

export interface DiscoveryOutcome {
  model: string | null;
  /** Diagnostic on failure (connection refused, no models, etc.). */
  reason?: string;
}

/**
 * Read the cache. If `exclude` contains models, return the first ranked
 * candidate not in the exclude set — lets the probe loop walk past models
 * that already failed.
 */
function cacheGet(key: string, exclude: ReadonlySet<string> = new Set()): DiscoveryOutcome | undefined {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  if (hit.ranked.length === 0) {
    return { model: null, reason: hit.reason };
  }
  const pick = hit.ranked.find((m) => !exclude.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${hit.ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

/** Cache miss outcome (no ranked list, only a failure reason). */
function cacheSetFailure(key: string, reason: string): void {
  _cache.set(key, { ranked: [], reason, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Cache hit outcome (one or more candidates in priority order). */
function cacheSetRanked(key: string, ranked: string[]): void {
  _cache.set(key, { ranked, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Discover via OpenAI-compatible `GET /v1/models`.
 *
 * Used by LiteLLM, OllamaCloud, vLLM, LM Studio, MLX — anything that
 * exposes the standard OpenAI /v1/models endpoint.
 *
 * @param endpoint  Full URL to /v1/models (or equivalent)
 * @param headers   Auth + content headers from transport.getHeaders()
 * @param cacheKey  Unique per provider+endpoint
 */
export async function discoverViaOpenAIModels(
  endpoint: string,
  headers: Record<string, string>,
  cacheKey: CacheKey & { displayName?: string; exclude?: ReadonlySet<string> }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    const reason = classifyFetchError(e, endpoint);
    log(
      `[probe-discovery${cacheKey.displayName ? ":" + cacheKey.displayName : ""}] fetch failed: ${reason}`
    );
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  if (!response.ok) {
    const reason = `HTTP ${response.status} from ${endpoint}`;
    log(
      `[probe-discovery${cacheKey.displayName ? ":" + cacheKey.displayName : ""}] ${reason}`
    );
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const reason = "invalid /v1/models response (not JSON)";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  const ids = extractModelIds(body);
  if (ids.length === 0) {
    const url = tryParseUrl(endpoint);
    const host = url?.host ?? endpoint;
    const reason = `${host} reachable but no models loaded — load a model in the server UI`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  const ranked = rankProbeCandidates(ids);
  if (ranked.length === 0) {
    const reason = `no chat-capable model among ${ids.length} listed`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

/**
 * Translate fetch-level failures into actionable user-facing messages.
 *
 * Localhost URLs distinguish from remote: a localhost failure almost always
 * means "the local service isn't running" (the user can start it). A remote
 * failure is more ambiguous — could be wrong URL, firewall, VPN, server down.
 *
 * Bun's fetch returns "Unable to connect. Is the computer able to access the
 * url?" with no `cause.code` field for refused/unreachable connections, so we
 * match on the message text as well as the standard Node-style error codes.
 */
function classifyFetchError(e: unknown, endpoint: string): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);

  // Extract just the host:port for compact display.
  const url = tryParseUrl(endpoint);
  const host = url?.host ?? endpoint;
  const isLocal = !!url && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(url.hostname);

  if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
    return `${host} unresponsive (>${FETCH_TIMEOUT_MS / 1000}s) — check if the server is overloaded`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `cannot resolve host ${url?.hostname ?? endpoint} — check the URL`;
  }
  // Connection refused / unreachable. Bun's message form doesn't set cause.code.
  const isConnRefused =
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    /unable to connect|connection refused|fetch failed/i.test(msg);
  if (isConnRefused) {
    if (isLocal) {
      return `${host} not reachable — is the server running? Press u to change URL.`;
    }
    return `${host} not reachable — check the URL or network. Press u to change.`;
  }

  // Fall back to the raw message but tag the host so it's not anonymous.
  return `${host}: ${msg}`;
}

function tryParseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Pull model IDs from a /v1/models response body. */
function extractModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = body as Record<string, unknown>;
  // OpenAI shape: { data: [{ id: "..." }, ...] }
  if (Array.isArray(data.data)) {
    return data.data
      .map((m: unknown) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  // LiteLLM model-groups shape: { data: [{ model_name: "..." }] }
  if (Array.isArray((data as { models?: unknown }).models)) {
    return (data as { models: unknown[] }).models
      .map((m: unknown) =>
        m && typeof m === "object"
          ? ((m as { id?: unknown; model_name?: unknown }).id ??
            (m as { model_name?: unknown }).model_name)
          : null
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return [];
}

interface OllamaModel {
  name: string;
  size?: number;
}

/**
 * Discover via Ollama-native API: prefer currently-loaded models from
 * /api/ps, fall back to /api/tags for all available.
 *
 * @param baseUrl   Ollama base URL (no trailing slash, no path)
 * @param cacheKey  Unique per endpoint
 */
export async function discoverViaOllama(
  baseUrl: string,
  cacheKey: CacheKey & { displayName?: string; exclude?: ReadonlySet<string> }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  // Try /api/ps first (loaded models). If it errors at the connection level,
  // capture the reason so we can surface a useful error if /api/tags also
  // fails — otherwise both falling back to empty would look like "no models"
  // when the real problem is "ollama isn't running."
  let connectionError: string | undefined;
  let loadedRaw: OllamaModel[] = [];
  try {
    loadedRaw = await fetchOllamaModels(`${baseUrl}/api/ps`);
  } catch (e: unknown) {
    connectionError = classifyFetchError(e, `${baseUrl}/api/ps`);
  }

  let allRaw = loadedRaw;
  if (allRaw.length === 0) {
    try {
      allRaw = await fetchOllamaModels(`${baseUrl}/api/tags`);
    } catch (e: unknown) {
      connectionError ??= classifyFetchError(e, `${baseUrl}/api/tags`);
    }
  }

  // Filter out embedding/image/TTS models — they're listed in /api/tags
  // alongside chat models but will 404 on /v1/chat/completions.
  const candidates = allRaw.filter((m) => isChatCapable(m.name));

  if (candidates.length === 0) {
    const reason =
      connectionError ??
      (allRaw.length === 0
        ? `no models on ${baseUrl} (pull one: ollama pull llama3.2)`
        : `only embedding/non-chat models on ${baseUrl}`);
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // Build the ranked list: smallest first by size if available, then by
  // name heuristic. This becomes the cached candidate sequence — the probe
  // loop can fall through by exclude'ing failed models.
  const sized = candidates.filter((m) => typeof m.size === "number");
  let ranked: string[];
  if (sized.length > 0) {
    ranked = [...sized]
      .sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))
      .map((m) => m.name);
  } else {
    ranked = rankProbeCandidates(candidates.map((m) => m.name));
  }
  if (ranked.length === 0) {
    const reason = "no chat-capable model on Ollama endpoint";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

interface LMStudioModel {
  id: string;
  state?: string; // "loaded" | "not-loaded"
  type?: string; // "llm" | "vlm" | "embeddings" | ...
}

/**
 * Discover via LM Studio's native `/api/v0/models` endpoint, which returns
 * per-model `state: "loaded" | "not-loaded"`. Probing a loaded model is
 * safe; probing a not-loaded one might 400 with "model loading error" if
 * LM Studio fails to JIT-load it.
 *
 * Falls back to standard `/v1/models` discovery if `/api/v0/models` is
 * unavailable (older LM Studio versions, or a different OpenAI-compat
 * server pretending to be LM Studio).
 */
export async function discoverViaLMStudio(
  baseUrl: string,
  headers: Record<string, string>,
  cacheKey: CacheKey & { displayName?: string; exclude?: ReadonlySet<string> }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v0/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    // Fallback to /v1/models for older LM Studio or non-LM-Studio servers.
    return discoverViaOpenAIModels(`${baseUrl}/v1/models`, headers, cacheKey);
  }

  if (!response.ok) {
    // /api/v0/models not supported on this version — try /v1/models.
    return discoverViaOpenAIModels(`${baseUrl}/v1/models`, headers, cacheKey);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const reason = "invalid /api/v0/models response (not JSON)";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  const models = extractLMStudioModels(body);
  if (models.length === 0) {
    const url = tryParseUrl(baseUrl);
    const host = url?.host ?? baseUrl;
    const reason = `${host} reachable but no models present — download one in the LM Studio UI`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // Filter out non-chat models (embeddings, etc) and rank: loaded first,
  // then by the standard small-name heuristic among each tier.
  const chatModels = models.filter(
    (m) => isChatCapable(m.id) && m.type !== "embeddings" && m.type !== "embedding"
  );
  const loaded = chatModels.filter((m) => m.state === "loaded");
  const notLoaded = chatModels.filter((m) => m.state !== "loaded");

  const ranked = [
    ...rankProbeCandidates(loaded.map((m) => m.id)),
    ...rankProbeCandidates(notLoaded.map((m) => m.id)),
  ];

  if (ranked.length === 0) {
    const url = tryParseUrl(baseUrl);
    const host = url?.host ?? baseUrl;
    const reason = `${host} has ${models.length} model(s) but none are chat-capable`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

function extractLMStudioModels(body: unknown): LMStudioModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: LMStudioModel[] = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const r = m as { id?: unknown; state?: unknown; type?: unknown };
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      state: typeof r.state === "string" ? r.state : undefined,
      type: typeof r.type === "string" ? r.type : undefined,
    });
  }
  return out;
}

async function fetchOllamaModels(url: string): Promise<OllamaModel[]> {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => null)) as
    | { models?: Array<{ name?: unknown; size?: unknown }> }
    | null;
  if (!body?.models) return [];
  return body.models
    .map((m) => ({
      name: typeof m.name === "string" ? m.name : "",
      size: typeof m.size === "number" ? m.size : undefined,
    }))
    .filter((m) => m.name.length > 0);
}

/** Test-only: clear the in-memory cache between runs. */
export function _clearProbeDiscoveryCache(): void {
  _cache.clear();
}

/**
 * Invalidate any cached discovery result whose key contains the given
 * provider slug. Called from the TUI when the user changes a URL or key —
 * the next probe should re-fetch instead of returning the stale model.
 */
export function invalidateProbeDiscovery(providerSlug: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${providerSlug}:`)) {
      _cache.delete(key);
    }
  }
}
