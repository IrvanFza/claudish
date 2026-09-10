import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
// The HARNESS extractSessionId: takes the whole request and reads
// `metadata.user_id`'s JSON `session_id`. NOT the same-named function in
// session-events/index.ts, which takes the metadata object instead.
import { extractSessionId } from "../behavior/harness.js";
import { log, maskCredential } from "../logger.js";
import {
  type AdvisorApiKeys,
  type AdvisorRouteKind,
  advisorCredentialsFor,
  createAdvisorStreamScanner,
  findPendingAdvisorToolResults,
  getAdvisorCall,
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  markAdvisorCallConsumed,
  missingAdvisorResult,
  prepareLegacyStubResult,
  recordAdvisorEventsFromResponseBody,
  reportUnrecordedAdvisorCalls,
  rewriteAdvisorToolResults,
  runAdvisorCall,
  stripAdvisorBeta,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { stripUnsignedThinkingBlocks } from "./shared/thinking-signature.js";
import type { ModelHandler } from "./types.js";

/**
 * True for the placeholder key claude-runner installs in proxy-auth mode
 * (`sk-ant-api03-placeholder-not-used-…`). It is not a credential: sending it
 * to api.anthropic.com is a guaranteed 401.
 */
function isPlaceholderAnthropicKey(key: string): boolean {
  return /placeholder/i.test(key);
}

/**
 * Resolve the advisor keys through the credential authority — env → aliases →
 * config → keychain → op:// — the single layer every other signer uses. Only
 * the credentials the configured routes need (`advisorCredentialsFor`) are
 * resolved, so an unused provider never triggers a 1Password handshake.
 *
 * google: the authority's "google" provider is the DIRECT Gemini API
 * (GEMINI_API_KEY); Antigravity and Code Assist are registered under their own
 * names. GOOGLE_API_KEY, which that provider does not alias, stays as a
 * last-resort env fallback because the advisor always accepted it.
 *
 * anthropic (collector only): the inbound `x-api-key` when it is a real key,
 * else ANTHROPIC_API_KEY from the authority. The inbound `authorization`
 * header is Claude Code's OAuth bearer and is NEVER sent to a collector; nor is
 * ANTHROPIC_AUTH_TOKEN, which the native-anthropic provider would otherwise
 * hand out as an `x-api-key`.
 */
async function resolveAdvisorKeys(
  needed: ReadonlySet<AdvisorRouteKind>,
  inboundApiKey: string | undefined
): Promise<AdvisorApiKeys> {
  const keyFromAuthority = async (name: string): Promise<string | undefined> => {
    try {
      const auth = await credentials.getRequestAuth(name, { model: "" });
      const k = auth.headers.Authorization?.replace(/^Bearer\s+/i, "") || auth.headers["x-api-key"];
      return k || undefined;
    } catch {
      return undefined;
    }
  };
  const googleKey = async (): Promise<string | undefined> =>
    (await keyFromAuthority("google")) || process.env.GOOGLE_API_KEY || undefined;
  const anthropicKey = async (): Promise<string | undefined> => {
    if (inboundApiKey && !isPlaceholderAnthropicKey(inboundApiKey)) return inboundApiKey;
    try {
      const auth = await credentials.getRequestAuth("native-anthropic", { model: "" });
      const k = auth.headers["x-api-key"];
      if (!k || k === process.env.ANTHROPIC_AUTH_TOKEN || isPlaceholderAnthropicKey(k)) {
        return undefined;
      }
      return k;
    } catch {
      return undefined;
    }
  };
  const [openrouter, google, openai, anthropic] = await Promise.all([
    needed.has("openrouter") ? keyFromAuthority("openrouter") : undefined,
    needed.has("google") ? googleKey() : undefined,
    needed.has("openai") ? keyFromAuthority("openai") : undefined,
    needed.has("anthropic") ? anthropicKey() : undefined,
  ]);
  return { openrouter, google, openai, anthropic };
}

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    // Drop thinking blocks Anthropic cannot have signed, before anything else
    // reads the payload — so the advisor logging below dumps what actually goes
    // on the wire rather than what arrived.
    //
    // Foreign reasoning reaches the client as `{type:"thinking", signature:""}`
    // (openai-sse has no signature to give it), and a single mixed-provider
    // session then 400s every subsequent native turn with
    // "Invalid signature in thinking block". See thinking-signature.ts for why
    // this belongs on the native path only, and which case it deliberately
    // still misses.
    const strippedThinking = stripUnsignedThinkingBlocks(payload.messages);
    if (strippedThinking > 0) {
      log(
        `[Native] stripped ${strippedThinking} unsigned thinking block(s) from history for ${target} (foreign-provider origin)`
      );
    }

    // -------------------------------------------------------------------
    // Advisor-swap experiment (opt-in via CLAUDISH_SWAP_ADVISOR=1).
    // No-op if the env var is unset. See native-handler-advisor.ts.
    //
    // Two-way mutation on each request:
    //   1. Outbound swap: advisor_20260301 server tool → regular tool named
    //      "advisor". Also strips advisor-tool-2026-03-01 beta flag.
    //   2. Inbound rewrite (Stage 2): any tool_result blocks targeting an
    //      advisor tool_use_id we've previously seen in a streamed response
    //      get their error payload replaced with stubbed advisor advice.
    // -------------------------------------------------------------------
    const advisorCfg = loadAdvisorSwapConfig(this.advisorModels, this.advisorCollector);
    // Pending advisor calls are keyed by Claude Code session: `serve` and the
    // MCP path run several conversations through one proxy. Absent → the
    // documented `__no_session__` bucket (see NO_SESSION_BUCKET).
    const advisorSessionId = extractSessionId(payload);
    let advisorSwapped: ReturnType<typeof swapAdvisorToolInBody> = null;
    let advisorRewrittenIds: string[] = [];
    if (advisorCfg.enabled) {
      // Stage 1: tool-definition swap (outbound).
      advisorSwapped = swapAdvisorToolInBody(payload);
      if (advisorSwapped) {
        log("[Native][advisor-swap] replaced advisor_20260301 with regular tool 'advisor'");
        logAdvisorEvent(advisorCfg, {
          kind: "swap_applied",
          model: target,
          originalTool: advisorSwapped.originalTool,
          regularTool: advisorSwapped.regularTool,
        });
      }

      // Stage 2: tool_result rewrite (inbound). Runs AFTER the Stage-1 swap
      // so it sees the possibly-mutated payload. In practice the two are
      // orthogonal — rewrite looks at messages[].content tool_result blocks,
      // swap looks at tools[].
      // A call's result is prepared once and RETAINED: Claude Code re-sends
      // every earlier advisor tool_result on each turn, still carrying its own
      // "No such tool" error, and each must get the same text back — replayed,
      // never re-fetched. Entries are keyed by this request's session.
      const cachedResult = (id: string) => getAdvisorCall(id, advisorSessionId)?.result;

      if (advisorCfg.models && advisorCfg.models.length > 0) {
        // Multi-model advisor: async pre-fetch from external models.
        //
        // Pass 1 restores advice already delivered on earlier turns, so the
        // panel below reads the conversation the model actually saw.
        rewriteAdvisorToolResults(payload, cachedResult, advisorSessionId);

        const pendingIds = findPendingAdvisorToolResults(payload, advisorSessionId);
        if (pendingIds.length > 0) {
          const freshIds: string[] = [];
          for (const id of pendingIds) {
            if (cachedResult(id)) continue;
            // Resolve advisor provider keys through the credential authority
            // (env → config → keychain → op://) — the single source of truth.
            const advisorKeys = await resolveAdvisorKeys(
              advisorCredentialsFor(advisorCfg.models, advisorCfg.collector),
              originalHeaders["x-api-key"]
            );
            const outcome = await runAdvisorCall({
              toolUseId: id,
              sessionId: advisorSessionId,
              messages: payload.messages as any[],
              models: advisorCfg.models,
              collector: advisorCfg.collector ?? null,
              apiKeys: advisorKeys,
              cfg: advisorCfg,
            });
            markAdvisorCallConsumed(id, outcome.result, advisorSessionId);
            freshIds.push(id);
          }
          // Pass 2: every tracked call now has a result. The S2 fallback is
          // unreachable by construction and reports itself as an error if not.
          advisorRewrittenIds = rewriteAdvisorToolResults(
            payload,
            (id) => cachedResult(id) ?? missingAdvisorResult(id),
            advisorSessionId
          );
          if (advisorRewrittenIds.length > 0) {
            log(
              `[Native][advisor] rewrote ${advisorRewrittenIds.length} tool_result(s) with multi-model advice from [${advisorCfg.models.join(", ")}]${advisorCfg.collector ? ` (collector: ${advisorCfg.collector})` : " (no collector)"}`
            );
            logAdvisorEvent(advisorCfg, {
              kind: "multi_model_rewrite",
              ids: advisorRewrittenIds,
              freshIds,
              models: advisorCfg.models,
              collector: advisorCfg.collector,
              model: target,
            });
          }
        }
      } else {
        // Legacy: stub advice (env var mode), stub path S1.
        for (const id of findPendingAdvisorToolResults(payload, advisorSessionId)) {
          if (!cachedResult(id)) prepareLegacyStubResult(advisorCfg, id, advisorSessionId);
        }
        advisorRewrittenIds = rewriteAdvisorToolResults(
          payload,
          (id) => cachedResult(id) ?? stubAdvisorAdvice(id),
          advisorSessionId
        );
        if (advisorRewrittenIds.length > 0) {
          log(
            `[Native][advisor-swap] rewrote ${advisorRewrittenIds.length} error tool_result(s) with stub advice: ${advisorRewrittenIds.join(", ")}`
          );
          logAdvisorEvent(advisorCfg, {
            kind: "tool_result_rewritten",
            ids: advisorRewrittenIds,
            model: target,
          });
        }
      }

      // Stub path S10: an advisor tool_result still carrying Claude Code's own
      // "No such tool" error for an id this session never recorded. Must run
      // after the rewrite, which clears the error text from every known call.
      reportUnrecordedAdvisorCalls(advisorCfg, payload, advisorSessionId);

      // Dump request body (trimmed) so we can inspect follow-ups that carry
      // tool_result blocks — critical evidence for Stage 2 debugging.
      if (advisorCfg.dumpBodies) {
        logAdvisorEvent(advisorCfg, {
          kind: "request_body",
          swapApplied: !!advisorSwapped,
          rewrittenIds: advisorRewrittenIds,
          model: target,
          body: trimForLog(payload),
        });
      }
    }

    log("\n=== [NATIVE] Claude Code → Anthropic API Request ===");
    log(
      `[Native] x-api-key: ${originalHeaders["x-api-key"] ? maskCredential(originalHeaders["x-api-key"]) : "(not set)"}`
    );
    log(
      `[Native] authorization: ${originalHeaders.authorization ? maskCredential(originalHeaders.authorization) : "(not set)"}`
    );
    log(`Request body (Model: ${target}):`);
    log("=== End Request ===\n");

    // Build headers - pass through auth headers exactly as received
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": originalHeaders["anthropic-version"] || "2023-06-01",
    };

    // Pass through auth headers as-is. If the incoming request carries NO auth
    // (e.g. the --probe client, which doesn't replicate Claude Code's injected
    // key) fall back to the api key this handler was constructed with, so the
    // native passthrough can still authenticate against api.anthropic.com.
    if (originalHeaders.authorization) {
      headers.authorization = originalHeaders.authorization;
    }
    if (originalHeaders["x-api-key"]) {
      headers["x-api-key"] = originalHeaders["x-api-key"];
    }
    if (!originalHeaders.authorization && !originalHeaders["x-api-key"]) {
      // No inbound auth → fall back to the construction-time key, else resolve
      // ANTHROPIC_API_KEY through the credential authority (env → config → op://),
      // so even the native fallback is sourced from the single layer.
      let fallbackKey = this.apiKey;
      if (!fallbackKey) {
        const auth = await credentials.getRequestAuth("native-anthropic", { model: target });
        fallbackKey = auth.headers["x-api-key"];
      }
      if (fallbackKey) {
        headers["x-api-key"] = fallbackKey;
      }
    }
    if (originalHeaders["anthropic-beta"]) {
      const incomingBeta = originalHeaders["anthropic-beta"];
      if (advisorSwapped) {
        // When we swap the advisor tool we must also strip the matching beta
        // flag; otherwise Anthropic rejects the request (beta enabled but no
        // matching server tool declared).
        const { stripped, changed } = stripAdvisorBeta(incomingBeta);
        if (changed) {
          log(
            `[Native][advisor-swap] stripped advisor-tool beta; before=${incomingBeta} after=${stripped ?? "(empty)"}`
          );
          logAdvisorEvent(advisorCfg, {
            kind: "beta_stripped",
            before: incomingBeta,
            after: stripped ?? "",
          });
        }
        if (stripped) headers["anthropic-beta"] = stripped;
      } else {
        headers["anthropic-beta"] = incomingBeta;
      }
    }

    // Execute fetch
    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const contentType = anthropicResponse.headers.get("content-type") || "";

      // Handle streaming
      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        return c.body(
          new ReadableStream({
            async start(controller) {
              const reader = anthropicResponse.body?.getReader();
              if (!reader) throw new Error("No reader");

              const decoder = new TextDecoder();
              // One advisor tap per stream: its own SSE reassembly buffer, and
              // ids recorded into this request's session bucket.
              const advisorScanner = createAdvisorStreamScanner(advisorCfg, advisorSessionId);
              let buffer = "";
              let eventLog = "";

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  controller.enqueue(value);

                  // Basic logging
                  const chunkText = decoder.decode(value, { stream: true });
                  buffer += chunkText;
                  // Advisor tap: extract any advisor tool_use ids and record
                  // stream events to the log (no-op when disabled).
                  advisorScanner.push(chunkText);
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) if (line.trim()) eventLog += `${line}\n`;
                }
                if (eventLog) log(eventLog);
                controller.close();
              } catch (e) {
                log(`[Native] Stream Error: ${e}`);
                controller.close();
              }
            },
          }),
          {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "anthropic-version": "2023-06-01",
            },
          }
        );
      }

      // Handle JSON
      const data = await anthropicResponse.json();
      log("\n=== [NATIVE] Response ===");
      log(JSON.stringify(data, null, 2));

      // Advisor tap for the non-streaming branch (mostly for title-classifier
      // calls on Haiku which return JSON). A non-stream body is NOT a
      // content_block_start — its advisor tool_use blocks live in `content[]`
      // — so it is read structurally rather than grepped as SSE bytes.
      if (advisorCfg.enabled) {
        try {
          recordAdvisorEventsFromResponseBody(advisorCfg, data, advisorSessionId);
        } catch {
          // ignore scan failures — logging-only
        }
      }

      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (anthropicResponse.headers.has("anthropic-version")) {
        responseHeaders["anthropic-version"] = anthropicResponse.headers.get("anthropic-version")!;
      }

      return c.json(data, { status: anthropicResponse.status as any, headers: responseHeaders });
    } catch (error) {
      log(`[Native] Fetch Error: ${error}`);
      return c.json(wrapAnthropicError(500, String(error)), 500);
    }
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}

/**
 * Produces a logging-friendly copy of a request payload. Trims long text
 * fields (system prompts can exceed 30KB) so the advisor-swap log stays
 * readable. Preserves block structure so you can still inspect the shape
 * of tool_use / tool_result / server_tool_use blocks.
 */
function trimForLog(payload: any): any {
  const TEXT_TRUNC = 400;
  const clone = structuredClone(payload);
  const trimStr = (s: string) =>
    typeof s === "string" && s.length > TEXT_TRUNC
      ? `${s.slice(0, TEXT_TRUNC)}… [+${s.length - TEXT_TRUNC} chars]`
      : s;
  const walk = (v: any): any => {
    if (typeof v === "string") return trimStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(clone);
}
