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
import { readAllModelsCache } from "../all-models-cache.js";

/**
 * In-memory cache. Stores the FULL ranked list of candidates so the probe
 * loop can fall through on per-model failures (e.g. LM Studio returning
 * "model loading error" 400 for a not-loaded model — the next candidate
 * from the same cache entry might be loaded and succeed).
 */
const _cache = new Map<string, { ranked: string[]; reason?: string; expiresAt: number }>();
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
 * Models that cannot answer a chat turn: image generation, embeddings, TTS,
 * speech-to-text. They appear in `/v1/models` lists beside chat models and 404
 * or 400 a probe.
 *
 * A NEGATIVE name rule: it can deny, never confirm. It is now the FALLBACK, not
 * the rule: the cloud models catalog publishes output modalities, so for a model
 * it describes the published list decides and this list is never consulted. It
 * still decides for what the catalog leaves without an output modality — local
 * servers (Ollama, LM Studio), custom endpoints, LiteLLM deployments, and catalog
 * rows that carry no modality field.
 *
 * VIDEO IS DELIBERATELY NOT HERE. It lives in {@link VIDEO_OUTPUT_NAME_PATTERNS},
 * which `classifyChatCapability` consults only while the catalog is silent on
 * `videoOutput`. A `video` rule in THIS list would run first and override a
 * published `videoOutput: false` — excluding a model that merely READS video,
 * which is still a chat model.
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
  // Speech-to-text. `gemini-3.5-transcribe` is the case `toPickerRows` named as
  // getting through, and `mai-transcribe-*` / `gpt-transcribe` are the observed
  // leaks. No chat model in any served dynamic models catalog carries the word.
  /\btranscribe\b/i,
  /\btranscription\b/i,
  // Text-to-speech under a name that does not say `tts`: `mai-voice-2`,
  // `mai-voice-2-flash`.
  /\bvoice\b/i,
  // REALTIME / LIVE / TRANSLATE — observed leaking into the OpenAI Codex dynamic models catalog as
  // `gpt-live-1`, `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` and
  // `gpt-realtime-translate`, all five offered as launchable coding models. The
  // selected row's own catalog sentence disqualified it: "a distilled reasoning
  // model for faster, lower-cost realtime VOICE interactions... audio and text
  // inputs over WebRTC, WebSocket, or SIP". None of them speaks
  // `/v1/chat/completions` the way an agent needs.
  /\brealtime\b/i,
  // `\b` IS THE WHOLE POINT ON THIS ONE. `-` is a non-word character, so `\blive\b`
  // matches `gpt-live-1` and `x-live-2` and does NOT match `delivery`, `olive`,
  // `livecodebench` or `liveness` — every one of which is a plausible model id and
  // none of which is a realtime endpoint. A bare substring `/live/` would eat all
  // four.
  /\blive\b/i,
  /\btranslate\b/i,
  /\btranslation\b/i,
  /-(image|tts|audio|embedding|vision-only|transcribe|voice|speech|realtime|live|translate)(-|$)/i,
];

/**
 * Ids that LOOK like video generators — a fallback the catalog overrides.
 *
 * Kept apart from {@link NON_CHAT_PATTERNS} because the catalog publishes
 * `videoOutput` (a defined boolean, `false` included), so for any model it knows
 * the fact replaces this guess. The guess still matters for models the catalog
 * does not cover. One word, two directions: `\bvideo\b` cannot tell a video
 * GENERATOR from a model that READS video, and video input alone never excludes a
 * chat model — which is why a published `videoOutput: false` switches this off.
 */
const VIDEO_OUTPUT_NAME_PATTERNS = [
  /\bvideo\b/i, // video-01, wan2.2-video, hunyuan-video
  /(^|[-_.])(t2v|i2v|r2v|v2v)([-_.]|$)/i, // happyhorse-1.1-t2v / -i2v / -r2v; MiniMax T2V-01
  /\bveo\b/i, // Google Veo
  /\bsora\b/i, // OpenAI Sora
];

function isSmallName(name: string): boolean {
  return SMALL_MODEL_PATTERNS.some((re) => re.test(name));
}

/**
 * What is known about whether a model can answer a chat turn.
 *
 * The cloud models catalog's OUTPUT MODALITY is the evidence; the name rules are
 * the fallback for models it does not describe.
 *
 * - `"not-chat"` — the catalog's published output modalities exclude `"text"`
 *   (image, audio, video, embeddings, transcription, speech, rerank, decisions);
 *   or, for a model with no published output modality, `videoOutput: true`, a
 *   {@link NON_CHAT_PATTERNS} match, or a LiteLLM wildcard route. Never offered.
 * - `"chat"` — the catalog's published output modalities include `"text"`; or,
 *   with none published, the catalog declares a chat-shaped capability (tools,
 *   thinking or vision).
 * - `"unknown"` — neither. Still offered. Rounding it to `"chat"` would assert
 *   what nothing established; rounding it to `"not-chat"` would hide a newly
 *   shipped chat model with no error and no trace.
 */
export type ChatCapability = "chat" | "not-chat" | "unknown";

/**
 * Memoized projection of the cloud models catalog, rebuilt at most once per TTL:
 * a per-id lookup would re-read the cache file once per model when filtering a
 * 300-model LiteLLM list.
 */
const CATALOG_CHAT_INDEX_TTL_MS = 60_000;
interface CatalogCapabilityIndex {
  /** Ids the catalog declares chat-shaped. */
  chat: Set<string>;
  /** Ids whose published output modalities INCLUDE `"text"`: chat models, by catalog evidence. */
  textOutput: Set<string>;
  /** Ids whose published output modalities EXCLUDE `"text"`: they produce something else only. */
  nonTextOutput: Set<string>;
  /** Ids the catalog declares video GENERATORS (`videoOutput: true`). */
  videoOutput: Set<string>;
  /** Ids with ANY published `videoOutput`, `false` included: a statement, not a silence. */
  videoOutputKnown: Set<string>;
}
const _catalogChatIndex = new Map<string, { index: CatalogCapabilityIndex; expiresAt: number }>();

/** Drop the memoized catalog projection — tests, and after a catalog refresh. */
export function _clearChatCapabilityIndex(): void {
  _catalogChatIndex.clear();
}

/** The catalog key for an id: lowercased, vendor prefix dropped (`openai/x` is `x`). */
function catalogKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

/**
 * File a catalog row's keys under its published OUTPUT modality.
 *
 * Unknown arrives as an absent field; `null` and `[]` read as unknown too, because
 * no model produces nothing — such a row joins neither set and is left to the
 * `videoOutput` boolean and the name rules. The test is "includes text", never
 * "equals text": `["audio", "text"]` speaks AND writes, so it can answer a chat turn.
 *
 * An INPUT modality is never filed here, in either direction: a model that accepts
 * video, audio or images is still a chat model.
 */
function indexOutputModality(
  index: CatalogCapabilityIndex,
  keys: string[],
  modalities: string[] | null | undefined
): void {
  if (!Array.isArray(modalities) || modalities.length === 0) return;
  const target = modalities.includes("text") ? index.textOutput : index.nonTextOutput;
  for (const k of keys) target.add(k);
}

function catalogCapabilityIndex(cachePath?: string): CatalogCapabilityIndex {
  const key = cachePath ?? "";
  const hit = _catalogChatIndex.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.index;

  const index: CatalogCapabilityIndex = {
    chat: new Set(),
    textOutput: new Set(),
    nonTextOutput: new Set(),
    videoOutput: new Set(),
    videoOutputKnown: new Set(),
  };
  for (const entry of readAllModelsCache(cachePath)?.entries ?? []) {
    const keys = [catalogKey(entry.modelId), ...(entry.aliases ?? []).map(catalogKey)];
    // Filed BEFORE the `videoOutput: true` `continue` below, so a video generator
    // still contributes its published output modality — and where the two disagree
    // the modality list wins, being the more specific statement.
    indexOutputModality(index, keys, entry.outputModalities);
    // `videoOutput` is read in both directions; `videoInput` is never read as a
    // denial, because a model that reads video is still a chat model.
    if (entry.videoOutput !== undefined) {
      for (const k of keys) index.videoOutputKnown.add(k);
    }
    if (entry.videoOutput === true) {
      for (const k of keys) index.videoOutput.add(k);
      continue;
    }
    // Positive flags only: `undefined` means no opinion and must stay `unknown`.
    const chatShaped =
      entry.supportsTools === true ||
      entry.supportsThinking === true ||
      entry.supportsVision === true;
    if (chatShaped) for (const k of keys) index.chat.add(k);
  }
  _catalogChatIndex.set(key, { index, expiresAt: Date.now() + CATALOG_CHAT_INDEX_TTL_MS });
  return index;
}

/**
 * Classify whether a model can answer a chat turn — see {@link ChatCapability}.
 *
 * The cloud models catalog's published OUTPUT MODALITY outranks every name rule,
 * in both directions: a model named like an image generator whose published output
 * is `["text"]` IS a chat model, and a model with a blameless name whose output is
 * `["image"]` is NOT. Only where the catalog publishes no output modality — local
 * servers, custom endpoints, LiteLLM deployments, catalog rows without the field —
 * do the older `videoOutput` boolean and the name rules decide.
 *
 * Order: wildcard route, non-text output, text output, `videoOutput: true`,
 * {@link NON_CHAT_PATTERNS}, the video name guess (only while `videoOutput` is
 * unpublished), the chat-shaped capability flags, then `"unknown"`.
 *
 * @param cachePath Override the catalog cache path. Tests only.
 */
export function classifyChatCapability(name: string, cachePath?: string): ChatCapability {
  // Wildcard entries ("gemini/*") are LiteLLM route patterns, not models.
  if (name.includes("*")) return "not-chat";

  const index = catalogCapabilityIndex(cachePath);
  const key = catalogKey(name);

  // Catalog evidence, ahead of every name rule.
  if (index.nonTextOutput.has(key)) return "not-chat";
  if (index.textOutput.has(key)) return "chat";

  if (index.videoOutput.has(key)) return "not-chat";
  if (NON_CHAT_PATTERNS.some((re) => re.test(name))) return "not-chat";
  if (!index.videoOutputKnown.has(key) && VIDEO_OUTPUT_NAME_PATTERNS.some((re) => re.test(name))) {
    return "not-chat";
  }
  if (index.chat.has(key)) return "chat";
  return "unknown";
}

/**
 * Whether a model may be offered as a chat model: everything but `"not-chat"`.
 * A projection of {@link classifyChatCapability}, so every caller shares one rule.
 */
export function isChatCapable(name: string): boolean {
  return classifyChatCapability(name) !== "not-chat";
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
  return names.filter(isChatCapable).sort((a, b) => {
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
function cacheGet(
  key: string,
  exclude: ReadonlySet<string> = new Set()
): DiscoveryOutcome | undefined {
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
  cacheKey: CacheKey & {
    displayName?: string;
    exclude?: ReadonlySet<string>;
    /**
     * Whether a key is configured for this provider, for the 401/403 message.
     *
     * A local server that wants a key and a local server that rejects the key
     * are different problems with different fixes, and "HTTP 401 from
     * http://localhost:8000/v1/models" told the reader neither. Measured
     * 2026-09-19: an oMLX server on vLLM's default port answers
     * `401 {"error":{"message":"API key required"}}` to an unauthenticated list.
     */
    hasApiKey?: boolean;
  }
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
      `[probe-discovery${cacheKey.displayName ? `:${cacheKey.displayName}` : ""}] fetch failed: ${reason}`
    );
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  if (!response.ok) {
    const who = cacheKey.displayName ?? "this provider";
    const authFailure =
      response.status === 401 || response.status === 403
        ? cacheKey.hasApiKey === false
          ? `the server requires an API key and none is configured for ${who}`
          : `the server rejected the configured API key for ${who}`
        : "";
    const reason = authFailure
      ? `HTTP ${response.status} from ${endpoint} — ${authFailure}`
      : `HTTP ${response.status} from ${endpoint}`;
    log(`[probe-discovery${cacheKey.displayName ? `:${cacheKey.displayName}` : ""}] ${reason}`);
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
 * Order one tier of Ollama models cheapest-first.
 *
 * Both /api/ps and /api/tags report a byte size (VRAM and disk respectively),
 * and in both cases smaller means a faster probe. Models the endpoint didn't
 * size are appended via the shared name heuristic rather than dropped — an
 * unsized model is still a usable probe candidate, and discarding it shrinks
 * the fall-through list the probe loop depends on.
 */
function orderByCost(models: OllamaModel[]): string[] {
  const sized = models.filter((m) => typeof m.size === "number");
  const unsized = models.filter((m) => typeof m.size !== "number");
  const bySize = [...sized]
    .sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY))
    .map((m) => m.name);
  return [...bySize, ...rankProbeCandidates(unsized.map((m) => m.name))];
}

/**
 * Discover via Ollama-native API: rank currently-loaded models from /api/ps
 * ahead of everything on disk from /api/tags.
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

  // Fetch BOTH lists. /api/ps is what's loaded in VRAM (fastest to probe),
  // /api/tags is everything on disk. Connection-level errors are captured so
  // we can surface a useful reason if both come back empty — otherwise
  // "ollama isn't running" would render as "no models".
  //
  // The /api/tags fetch used to be gated on `loaded.length === 0` — the RAW
  // count, taken BEFORE the chat-capability filter. A box whose only loaded
  // model was an embedder (nomic-embed-text pinned by a background indexer, a
  // common setup) therefore reported "only embedding/non-chat models" while
  // dozens of chat models sat unlisted on disk. Both lists also feed the ranked
  // candidate array that the probe loop falls through on, so one broken model
  // no longer fails the whole row.
  // Issued in PARALLEL — they're independent reads of the same daemon, so
  // serializing them would bill their latencies additively for nothing.
  const [psResult, tagsResult] = await Promise.allSettled([
    fetchOllamaModels(`${baseUrl}/api/ps`),
    fetchOllamaModels(`${baseUrl}/api/tags`),
  ]);

  const loadedRaw = psResult.status === "fulfilled" ? psResult.value : [];
  const tagsRaw = tagsResult.status === "fulfilled" ? tagsResult.value : [];
  // /api/ps's error wins when both fail: same daemon, same cause, and it's the
  // first URL we'd have tried. Only consulted if we end up with no candidates.
  const connectionError =
    psResult.status === "rejected"
      ? classifyFetchError(psResult.reason, `${baseUrl}/api/ps`)
      : tagsResult.status === "rejected"
        ? classifyFetchError(tagsResult.reason, `${baseUrl}/api/tags`)
        : undefined;

  // Filter out embedding/image/TTS models — they're listed in /api/tags
  // alongside chat models but will 404 on /v1/chat/completions.
  const loaded = loadedRaw.filter((m) => isChatCapable(m.name));
  const loadedNames = new Set(loaded.map((m) => m.name));
  const rest = tagsRaw.filter((m) => isChatCapable(m.name) && !loadedNames.has(m.name));

  if (loaded.length === 0 && rest.length === 0) {
    const reason =
      connectionError ??
      (loadedRaw.length === 0 && tagsRaw.length === 0
        ? `no models on ${baseUrl} (pull one: ollama pull llama3.2)`
        : `only embedding/non-chat models on ${baseUrl}`);
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // Loaded models first (already in VRAM → fastest probe), then the rest.
  // This becomes the cached candidate sequence — the probe loop can fall
  // through by exclude'ing failed models.
  const ranked = [...orderByCost(loaded), ...orderByCost(rest)];
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
  const body = (await response.json().catch(() => null)) as {
    models?: Array<{ name?: unknown; size?: unknown }>;
  } | null;
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
