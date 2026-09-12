/**
 * OpenCode Zen ProviderTransport (both tiers: `opencode-zen-go` and `opencode-zen`).
 *
 * The OpenAI transport plus one header. Zen Go began rejecting every request that
 * lacks `x-opencode-session` — measured 2026-09-12, a 400 with error type
 * `MissingSessionID`, which claudish's fallback chain then silently stepped past.
 * OpenCode's docs state the contract: "Send a stable session ID in
 * x-opencode-session for each conversation".
 *
 * The value is `conversationKey()` — Claude Code's session id, hashed, the same
 * derivation Codex uses for `prompt_cache_key`. Hashed because the raw id is a
 * local correlation handle with no reason to leave the machine; the upstream only
 * needs it stable per conversation.
 *
 * The metered `opencode-zen` tier sends it too, on the same docs sentence, but that
 * is UNVERIFIED live: there is no OPENCODE_API_KEY on the machine that measured Go.
 */

import { conversationKey } from "./conversation-key.js";
import { OpenAIProviderTransport } from "./openai.js";

export class OpenCodeZenTransport extends OpenAIProviderTransport {
  /** Derived from `claudeRequest` on every call — never cached on the instance. */
  override async getHeaders(claudeRequest?: unknown): Promise<Record<string, string>> {
    return {
      ...(await super.getHeaders()),
      "x-opencode-session": conversationKey(claudeRequest),
    };
  }
}
