/**
 * Advisor-tool transformer for NativeHandler (monitor mode).
 *
 * PURPOSE — experimental
 * ======================
 * When the client sends `{type: "advisor_20260301", name: "advisor", model: ...}`
 * in `tools[]`, optionally replace it with a regular tool definition named
 * "advisor" so we can observe whether Sonnet still calls it as a normal tool.
 *
 * This is Stage 1 of the advisor-replacement experiment: detection only.
 * No tool loop, no third-party model routing. We just want to see whether
 * the executor still emits `tool_use` for `advisor` when the server-tool
 * version is gone.
 *
 * ENABLING
 * ========
 * Opt-in via env var:
 *
 *   export CLAUDISH_SWAP_ADVISOR=1         # swap tool + strip beta header
 *   export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.log  # optional log path
 *
 * When unset, this module is a no-op and the proxy behaves as before.
 */

import { appendFileSync } from "node:fs";
import { log } from "../logger.js";
import { resolveModelNameSync } from "../providers/catalog-client.js";
import { findEntryByAlias } from "../providers/catalog-query.js";
import { parseModelSpec } from "../providers/model-parser.js";

const ADVISOR_SERVER_TOOL_TYPE = "advisor_20260301";
const ADVISOR_BETA_FLAG = "advisor-tool-2026-03-01";

export interface AdvisorSwapConfig {
  enabled: boolean;
  logPath?: string;
  /** When true, include entire request bodies in the log — large but useful for debugging the tool_result round-trip. */
  dumpBodies?: boolean;
  models?: string[];
  collector?: string | null;
}

export function loadAdvisorSwapConfig(
  cliModels?: string[],
  cliCollector?: string | null
): AdvisorSwapConfig {
  return {
    enabled: process.env.CLAUDISH_SWAP_ADVISOR === "1" || (cliModels?.length ?? 0) > 0,
    logPath: process.env.CLAUDISH_SWAP_ADVISOR_LOG,
    dumpBodies: process.env.CLAUDISH_SWAP_ADVISOR_DUMP === "1",
    models: cliModels,
    collector: cliCollector ?? undefined,
  };
}

interface AdvisorInfo {
  /** The original server-tool definition we removed. */
  originalTool: Record<string, unknown>;
  /** The regular-tool definition we replaced it with. */
  regularTool: Record<string, unknown>;
  /** Original value of the anthropic-beta header (for possible restoration). */
  originalBetaHeader?: string;
  /** Beta header after stripping advisor-tool-2026-03-01. */
  strippedBetaHeader?: string;
}

/**
 * Mutates `payload.tools` in place: finds `advisor_20260301` and replaces it
 * with a regular tool of the same name. Also returns metadata describing
 * what we changed (for logging).
 *
 * Returns `null` if the payload had no advisor server tool (nothing to do).
 */
export function swapAdvisorToolInBody(payload: Record<string, unknown>): AdvisorInfo | null {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return null;

  const idx = tools.findIndex(
    (t) => t && typeof t === "object" && (t as any).type === ADVISOR_SERVER_TOOL_TYPE
  );
  if (idx < 0) return null;

  const originalTool = tools[idx] as Record<string, unknown>;
  const originalName = (originalTool.name as string) || "advisor";
  const originalAdvisorModel = (originalTool.model as string) || "unknown";

  // Regular tool definition. We deliberately keep the same name ("advisor")
  // so we can compare behavior before/after the swap.
  //
  // The description is longer than strictly necessary because the native
  // server-tool has trained behavior baked into the model — a regular tool
  // with the same name does NOT inherit that training, so we compensate
  // with more explicit prompting.
  const regularTool: Record<string, unknown> = {
    name: originalName,
    description:
      "Consult a stronger advisor model for strategic guidance on complex decisions. " +
      "Call this tool when: (a) facing an architectural or design decision with " +
      "multiple valid approaches, (b) stuck after 2+ failed attempts, (c) about to " +
      "make an irreversible change, or (d) when you believe the task is complete " +
      "and want verification. Takes no arguments; the advisor will read the full " +
      "conversation history.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };

  tools[idx] = regularTool;

  return {
    originalTool,
    regularTool,
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    ...{ _note: `replaced advisor_20260301 (advisor model: ${originalAdvisorModel})` },
  } as AdvisorInfo;
}

/**
 * Removes `advisor-tool-2026-03-01` from a comma-separated anthropic-beta
 * header value. Returns `undefined` if the header had no advisor beta flag.
 */
export function stripAdvisorBeta(betaHeader: string | undefined): {
  stripped: string | undefined;
  changed: boolean;
} {
  if (!betaHeader) return { stripped: betaHeader, changed: false };
  const parts = betaHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const filtered = parts.filter((p) => p !== ADVISOR_BETA_FLAG);
  if (filtered.length === parts.length) {
    return { stripped: betaHeader, changed: false };
  }
  return {
    stripped: filtered.length > 0 ? filtered.join(",") : undefined,
    changed: true,
  };
}

/**
 * Appends a structured log entry to the configured advisor-swap log file.
 * Safe to call even if no log path is set (no-op in that case).
 */
export function logAdvisorEvent(cfg: AdvisorSwapConfig, event: Record<string, unknown>): void {
  if (!cfg.logPath) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    appendFileSync(cfg.logPath, line);
  } catch {
    // silent — don't break the proxy if the log file is unwritable
  }
}

/**
 * Scans a chunk of raw SSE bytes for advisor-related activity and records
 * any hits to the log file. Call this once per streamed chunk.
 *
 * NOT stateless: SSE frames are reassembled across chunk boundaries (see
 * `SseFrameBuffer`) before they are parsed.
 *
 * Also extracts advisor `tool_use.id`s and stashes them in a module-level
 * Set so that subsequent inbound requests containing tool_result blocks
 * for those ids can be recognized and rewritten (Stage 2).
 */
export function recordAdvisorEventsFromChunk(cfg: AdvisorSwapConfig, chunkText: string): void {
  // Regardless of logPath, always try to extract advisor tool_use ids —
  // Stage 2 rewrite depends on them even when no log file is configured.
  extractAdvisorToolUseIds(chunkText);
  logAdvisorMarkers(cfg, chunkText);
}

/**
 * Advisor tap for a NON-STREAMING response: the parsed JSON body, whose
 * `content[]` carries `{type:"tool_use", name:"advisor", id:...}` blocks.
 * A non-stream response is NOT a `content_block_start`, so the SSE path
 * above would never see it.
 *
 * Prefer this over `recordAdvisorEventsFromChunk(cfg, JSON.stringify(body))`:
 * it reads the object structurally instead of re-serializing and grepping.
 */
export function recordAdvisorEventsFromResponseBody(cfg: AdvisorSwapConfig, body: unknown): void {
  collectAdvisorIdsFromValue(body, 0);
  if (!cfg.logPath) return;
  try {
    logAdvisorMarkers(cfg, JSON.stringify(body));
  } catch {
    // ignore — a body that will not serialize is a logging problem only
  }
}

/**
 * Byte-grep for markers worth flagging in the log. Stage 1 cares about
 * whether the executor emits a regular tool_use for "advisor" (which proves
 * the model still reaches for the advisor when the tool_type is regular).
 *
 * Logging only — id capture never depends on this.
 */
function logAdvisorMarkers(cfg: AdvisorSwapConfig, text: string): void {
  if (!cfg.logPath) return;
  const markers: Array<[string, string]> = [
    ['"name":"advisor"', "tool_use_for_advisor"],
    ['"type":"tool_use"', "any_tool_use"],
    ['"type":"server_tool_use"', "server_tool_use_unexpected"],
    ['"type":"advisor_tool_result"', "advisor_tool_result_unexpected"],
    ['"stop_reason":"tool_use"', "stop_reason_tool_use"],
    ['"stop_reason":"end_turn"', "stop_reason_end_turn"],
  ];
  for (const [needle, kind] of markers) {
    let i = 0;
    while (true) {
      i = text.indexOf(needle, i);
      if (i < 0) break;
      const ctx = text.slice(Math.max(0, i - 40), i + 160);
      logAdvisorEvent(cfg, { kind, needle, ctx });
      i += needle.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 2: ID tracking + tool_result rewrite
// ---------------------------------------------------------------------------

/**
 * Tool-use ids we've seen the model emit for tool_use blocks with
 * name="advisor". Populated from streamed responses; consulted on the next
 * inbound request to detect the Claude-Code-generated "No such tool"
 * error tool_result.
 *
 * Bounded: oldest entry is evicted when the set exceeds MAX_TRACKED.
 */
const advisorToolUseIds = new Set<string>();
const MAX_TRACKED = 256;

/** The tool name we track. Claudish keeps the client's own name on the swap. */
const ADVISOR_TOOL_NAME = "advisor";

/** Guard against a pathological (or hostile) nesting depth while walking JSON. */
const MAX_WALK_DEPTH = 32;

/**
 * Hard cap on the SSE reassembly buffer. A stream that never terminates an
 * event (malformed, or simply not SSE at all) must not grow it without limit;
 * past the cap we keep only the tail, which is where a frame boundary can
 * still appear.
 */
const MAX_SSE_BUFFER_CHARS = 256 * 1024;

/**
 * Reassembles SSE events across chunk boundaries.
 *
 * Anthropic splits `content_block_start` across byte boundaries, so a
 * per-chunk `JSON.parse` of `data:` lines misses exactly the frames we care
 * about. Buffer until an event terminator (`\n\n`, or `\r\n\r\n`), then hand
 * the complete event out.
 */
class SseFrameBuffer {
  private buf = "";

  /** Appends a chunk and returns every COMPLETE event now available. */
  take(chunkText: string): string[] {
    this.buf += chunkText;
    const events: string[] = [];
    while (true) {
      const lf = this.buf.indexOf("\n\n");
      const crlf = this.buf.indexOf("\r\n\r\n");
      // Earliest terminator wins; -1 means "not present".
      let idx = -1;
      let width = 2;
      if (crlf >= 0 && (lf < 0 || crlf < lf)) {
        idx = crlf;
        width = 4;
      } else if (lf >= 0) {
        idx = lf;
      }
      if (idx < 0) break;
      events.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + width);
    }
    if (this.buf.length > MAX_SSE_BUFFER_CHARS) {
      this.buf = this.buf.slice(-MAX_SSE_BUFFER_CHARS);
    }
    return events;
  }

  reset(): void {
    this.buf = "";
  }
}

/**
 * One module-level buffer, shared by every stream that reaches the legacy
 * per-chunk entry point.
 *
 * Two concurrent streams can interleave here and produce a spliced "event".
 * That degrades gracefully rather than losing the id: a spliced event fails
 * `JSON.parse` and falls through to the regex fallback below, which is the
 * same byte-grep this code used to be. P4's decorator should own a
 * per-stream instance instead of sharing this one.
 */
const streamFrameBuffer = new SseFrameBuffer();

/**
 * Records the id of every advisor tool_use block visible in this chunk.
 *
 * Structural first, regex only as a fallback. The id is captured whatever it
 * looks like: `toolu_*` is an ANTHROPIC spelling, and the advisor swap must
 * work behind every parser. `openai-sse.ts` mints `call_*` from the upstream
 * or synthesizes `tool_<ts>_<idx>`, and it is the DEFAULT stream format
 * (`base-api-format.ts`), so a prefix test silently captures nothing for
 * every foreign main model.
 */
function extractAdvisorToolUseIds(chunkText: string): void {
  // Whole-body JSON (the non-streaming branch hands us one). If it parses we
  // have read it structurally and there is nothing for the regex to add.
  if (parseAdvisorIdsFromJsonText(chunkText)) return;

  // SSE: parse each COMPLETE event; a frame that will not parse falls back to
  // the regex so we never capture less than the byte-grep did.
  let sawCompleteFrame = false;
  for (const event of streamFrameBuffer.take(chunkText)) {
    sawCompleteFrame = true;
    if (!scanSseEventForAdvisorIds(event)) matchAdvisorIdsByRegex(event);
  }

  // No complete frame yet — either a fragment (the rest is still coming and
  // will be parsed then) or text that is not SSE at all, e.g. a bare
  // `"content_block":{...}` snippet. Grep it so neither case is dropped.
  if (!sawCompleteFrame) matchAdvisorIdsByRegex(chunkText);
}

/**
 * Reads one complete SSE event structurally: concatenates its `data:` lines
 * per the SSE spec, parses the result and walks it for advisor tool_use
 * blocks. Returns false when the payload did not parse, which is the
 * caller's signal to fall back to the regex.
 */
function scanSseEventForAdvisorIds(rawEvent: string): boolean {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return false;
  const payload = dataLines.join("\n").trim();
  // A comment/heartbeat frame or the terminator carries nothing to capture,
  // but it is not a parse FAILURE either — no regex fallback needed.
  if (!payload || payload === "[DONE]") return true;
  return parseAdvisorIdsFromJsonText(payload);
}

/** Parses `text` as JSON and walks it. Returns false when it is not JSON. */
function parseAdvisorIdsFromJsonText(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  collectAdvisorIdsFromValue(parsed, 0);
  return true;
}

/**
 * Walks any parsed JSON value and records the id of every object that IS an
 * advisor tool_use block. Key order is irrelevant here, which is the point:
 * the old regex required `type`,`id`,`name` adjacent and in that order.
 *
 * Covers both shapes with one walk: the streamed
 * `content_block_start.content_block` and the non-streamed `content[]` entry.
 */
function collectAdvisorIdsFromValue(value: unknown, depth: number): void {
  if (value === null || typeof value !== "object" || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectAdvisorIdsFromValue(item, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.type === "tool_use" &&
    obj.name === ADVISOR_TOOL_NAME &&
    typeof obj.id === "string" &&
    obj.id.length > 0
  ) {
    rememberAdvisorToolUseId(obj.id);
  }
  for (const nested of Object.values(obj)) collectAdvisorIdsFromValue(nested, depth + 1);
}

/**
 * Prefix-agnostic fallback for payloads that do not parse — a truncated
 * frame, a spliced one, or a raw fragment. `[^}]*?` keeps every match inside
 * a single JSON object, so an id belonging to an enclosing object (a
 * `message.id`, say) can never be picked up for the advisor block nested
 * inside it.
 */
const ADVISOR_ID_PATTERNS: RegExp[] = [
  // type → id → name. The canonical fallback from the design doc.
  /"type"\s*:\s*"tool_use"[^}]*?"id"\s*:\s*"([^"]+)"[^}]*?"name"\s*:\s*"advisor"/g,
  // name → id, whatever sits between them (input may be serialized first).
  /"name"\s*:\s*"advisor"[^}]*?"id"\s*:\s*"([^"]+)"/g,
  // id → name with no `type` ahead of them. Adjacency is required precisely
  // because `type` is not there to prove the id belongs to this block.
  /"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"advisor"/g,
];

function matchAdvisorIdsByRegex(text: string): void {
  for (const re of ADVISOR_ID_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((m = re.exec(text)) !== null) {
      rememberAdvisorToolUseId(m[1]);
    }
  }
}

function rememberAdvisorToolUseId(id: string): void {
  if (advisorToolUseIds.has(id)) return;
  if (advisorToolUseIds.size >= MAX_TRACKED) {
    // Evict oldest (Set iteration order is insertion order).
    const first = advisorToolUseIds.values().next().value;
    if (first !== undefined) advisorToolUseIds.delete(first);
  }
  advisorToolUseIds.add(id);
}

/** Test helper — direct access for unit tests. */
export function _debug_getTrackedAdvisorIds(): string[] {
  return [...advisorToolUseIds];
}

/** Reset the ID tracker AND the SSE reassembly buffer. Intended for tests. */
export function _debug_resetTrackedAdvisorIds(): void {
  advisorToolUseIds.clear();
  streamFrameBuffer.reset();
}

/**
 * Scans a payload for `tool_result` blocks whose tool_use_id we recorded as
 * an advisor call, and rewrites them in place:
 *   - `is_error: true` → `is_error: false` (dropped)
 *   - `content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>"`
 *     → `content: [{type:"text", text: <advice>}]`
 *
 * Returns the list of rewritten tool_use_ids (empty if nothing changed).
 */
export function rewriteAdvisorToolResults(
  payload: Record<string, unknown>,
  /**
   * Supplies the advice text for a given advisor tool_use_id. Typically this
   * wraps a claudish `run_prompt` call against a third-party model. For PoC
   * use a synchronous stub; for production swap in a real async router.
   *
   * NOTE: must be synchronous for this helper. Callers that need an async
   * model call should pre-fetch advice keyed by tool_use_id before invoking
   * this function.
   */
  getAdviceFor: (toolUseId: string) => string
): string[] {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return [];
  const rewritten: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if ((msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as any).type !== "tool_result") continue;
      const toolUseId = (block as any).tool_use_id;
      if (typeof toolUseId !== "string") continue;
      if (!advisorToolUseIds.has(toolUseId)) continue;

      const advice = getAdviceFor(toolUseId);
      // Rewrite in place.
      (block as any).content = [{ type: "text", text: advice }];
      // Clear error flag if Claude Code set one.
      if ((block as any).is_error) (block as any).is_error = false;
      rewritten.push(toolUseId);
    }
  }
  return rewritten;
}

/**
 * Stub advisor: returns a canary string. Used during PoC to prove the
 * rewrite reached the executor without yet wiring up a real third-party
 * model. The canary string is intentionally distinctive so we can grep for
 * it in the executor's continuation.
 */
export function stubAdvisorAdvice(toolUseId: string): string {
  return `CLAUDISH_ADVISOR_STUB_${toolUseId}: Evaluation mode — this advice was supplied by a claudish proxy stub. For the rate-limiter design, consider a hybrid: local token bucket per node for burst tolerance plus a central quota coordinator for cross-region fairness. Use the CAP tradeoff as your framing; expose availability vs accuracy knobs per tenant. The single most important decision is your failure mode: fail-open vs fail-closed.`;
}

// ---------------------------------------------------------------------------
// Stage 3: Multi-model advisor (--advisor flag)
// ---------------------------------------------------------------------------

/**
 * Scans payload for tool_result blocks whose tool_use_id is tracked as an
 * advisor call. Returns the list of matching IDs without modifying the payload.
 * Used to determine which IDs need async pre-fetch before rewriting.
 */
export function findPendingAdvisorToolResults(payload: Record<string, unknown>): string[] {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return [];
  const found: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if ((msg as any).role !== "user") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as any).type !== "tool_result") continue;
      const toolUseId = (block as any).tool_use_id;
      if (typeof toolUseId === "string" && advisorToolUseIds.has(toolUseId)) {
        found.push(toolUseId);
      }
    }
  }
  return found;
}

export function convertToOpenAIMessages(
  anthropicMessages: any[]
): Array<{ role: string; content: string }> {
  return anthropicMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: extractBlocksAsText(m.content),
    }))
    .filter((m) => m.content.length > 0);
}

export function extractBlocksAsText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") {
        const inputStr = JSON.stringify(b.input ?? {}).slice(0, 500);
        return `[Called tool: ${b.name} with input: ${inputStr}]`;
      }
      if (b.type === "tool_result") {
        const resultText =
          typeof b.content === "string"
            ? b.content.slice(0, 500)
            : Array.isArray(b.content)
              ? b.content
                  .filter((x: any) => x.type === "text")
                  .map((x: any) => x.text)
                  .join("\n")
                  .slice(0, 500)
              : "(binary)";
        return `[Tool result (${b.tool_use_id}): ${resultText}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const ADVISOR_SYSTEM_PROMPT = `You are a strategic advisor to a coding agent. \
You have been given the full conversation history between a user and a Claude Code \
coding assistant. The assistant has paused to consult you for guidance.

Review the conversation and provide concise, actionable advice. Focus on:
- Architectural decisions and trade-offs
- Potential pitfalls the assistant might miss
- Alternative approaches worth considering
- Security, performance, or correctness concerns

Be direct. Limit your response to 300-500 words.`;

const COLLECTOR_SYSTEM_PROMPT = `You are synthesizing advice from multiple AI models \
for a coding agent. You will receive several independent advisor opinions about the \
same coding problem. Synthesize them into a single, coherent response that:
- Identifies consensus points (where advisors agree)
- Highlights disagreements and explains which perspective is stronger
- Produces a clear, actionable recommendation
Be concise. Do not attribute advice to specific models.`;

function buildAdvisorRequest(
  parsed: ReturnType<typeof parseModelSpec>,
  messages: any[],
  apiKeys: { openrouter?: string; google?: string; openai?: string },
  systemPrompt: string = ADVISOR_SYSTEM_PROMPT
): { url: string; headers: Record<string, string>; body: any } {
  const openaiMessages = convertToOpenAIMessages(messages);
  const provider = parsed.provider;

  if (provider === "google" || provider === "gemini") {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKeys.google ?? ""}`,
      },
      body: {
        model: parsed.model,
        max_tokens: 2048,
        messages: [{ role: "system", content: systemPrompt }, ...openaiMessages],
      },
    };
  }

  if (provider === "openai" || provider === "oai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKeys.openai ?? ""}`,
      },
      body: {
        model: parsed.model,
        max_tokens: 2048,
        messages: [{ role: "system", content: systemPrompt }, ...openaiMessages],
      },
    };
  }

  // Everything else -> OpenRouter
  const rawModelId =
    parsed.isExplicitProvider && provider !== "openrouter"
      ? `${provider}/${parsed.model}`
      : parsed.model;
  const modelId = resolveModelNameSync("openrouter", rawModelId) ?? rawModelId;

  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKeys.openrouter ?? ""}`,
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish Advisor",
    },
    body: {
      model: modelId,
      max_tokens: 2048,
      messages: [{ role: "system", content: systemPrompt }, ...openaiMessages],
    },
  };
}

async function callAdvisorModel(
  modelSpec: string,
  messages: any[],
  apiKeys: { openrouter?: string; google?: string; openai?: string }
): Promise<string> {
  const parsed = parseModelSpec(modelSpec);
  const { url, headers, body } = buildAdvisorRequest(parsed, messages, apiKeys);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content ?? "(no response)";
  } finally {
    clearTimeout(timeout);
  }
}

function isAnthropicModel(parsed: ReturnType<typeof parseModelSpec>): boolean {
  const m = parsed.model.toLowerCase();
  return (
    parsed.provider === "anthropic" ||
    m.startsWith("claude-") ||
    m === "haiku" ||
    m === "sonnet" ||
    m === "opus"
  );
}

async function callAnthropicCollector(
  model: string,
  adviceText: string,
  apiKey?: string
): Promise<string> {
  const aliasResolved =
    model === "haiku" || model === "sonnet" || model === "opus"
      ? findEntryByAlias(model)?.modelId
      : null;
  const resolvedModel = aliasResolved ?? model;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: 1024,
      system: COLLECTOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: adviceText }],
    }),
  });

  if (!resp.ok) throw new Error(`anthropic collector ${resp.status}`);
  const data = (await resp.json()) as any;
  return data.content?.find((b: any) => b.type === "text")?.text ?? "(empty)";
}

async function callCollectorModel(
  collectorSpec: string,
  advice: Array<{ model: string; text: string }>,
  apiKeys: { openrouter?: string; google?: string; openai?: string; anthropic?: string }
): Promise<string> {
  const adviceText = advice
    .map((a, i) => `### Advisor ${i + 1} (${a.model})\n${a.text}`)
    .join("\n\n");

  const parsed = parseModelSpec(collectorSpec);

  if (isAnthropicModel(parsed)) {
    return callAnthropicCollector(parsed.model, adviceText, apiKeys.anthropic);
  }

  // External collector via OpenRouter/Google/OpenAI
  const collectorMessages = [{ role: "user", content: adviceText }];
  const { url, headers, body } = buildAdvisorRequest(
    parsed,
    collectorMessages as any,
    apiKeys,
    COLLECTOR_SYSTEM_PROMPT
  );
  // Override messages since buildAdvisorRequest would try to convert
  body.messages = [
    { role: "system", content: COLLECTOR_SYSTEM_PROMPT },
    { role: "user", content: adviceText },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`collector ${resp.status}`);
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content ?? "(collector returned empty)";
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchMultiModelAdvice(
  _toolUseId: string,
  messages: any[],
  models: string[],
  collector: string | null,
  apiKeys: { openrouter?: string; google?: string; openai?: string; anthropic?: string }
): Promise<string> {
  // Step 1: Call all advisors in parallel
  const results = await Promise.allSettled(
    models.map((model) => callAdvisorModel(model, messages, apiKeys))
  );

  const sections: string[] = [];
  const successfulAdvice: Array<{ model: string; text: string }> = [];
  for (let i = 0; i < models.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      sections.push(`## ${models[i]}\n${result.value}`);
      successfulAdvice.push({ model: models[i], text: result.value });
    } else {
      sections.push(`## ${models[i]}\n[Error: ${(result.reason as any)?.message ?? "unknown"}]`);
    }
  }

  // Step 2: Single advisor or no collector -> return as-is
  if (models.length === 1 && successfulAdvice.length === 1) {
    return successfulAdvice[0].text;
  }
  if (!collector || successfulAdvice.length === 0) {
    return sections.join("\n\n");
  }

  // Step 3: Run collector to synthesize
  try {
    const synthesized = await callCollectorModel(collector, successfulAdvice, apiKeys);
    return synthesized;
  } catch (err: any) {
    log(`[advisor] collector ${collector} failed: ${err.message}, falling back to concat`);
    return sections.join("\n\n");
  }
}
