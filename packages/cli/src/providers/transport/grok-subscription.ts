/**
 * Grok Build subscription transport.
 *
 * The wire is ordinary OpenAI Chat Completions — the proxy answered a plain
 * `{model, messages}` body and streams `chat.completion.chunk` with
 * `delta.reasoning_content` — so this subclasses `OpenAIProviderTransport` and
 * changes exactly two things:
 *
 *  1. **Auth comes from the credential authority, not a static key.** The token
 *     lives for six hours, so the base class's constructor-injected `apiKey`
 *     cannot express it; `getRequestAuth()` is where expiry is checked and a
 *     refresh happens.
 *  2. **Two client-identity headers are mandatory.** The proxy enforces a
 *     minimum CLI version and rejects anything without them:
 *     `{"error":"Your Grok CLI version (none) is outdated..."}`. Both are
 *     produced by `grokAuthHeaders`, which reads the version from the user's own
 *     install rather than pinning a literal.
 *
 * The served models declare `api_backend: "responses"`, and `/v1/responses`
 * does work — but claudish deliberately uses Chat Completions, because its
 * Layer-2 `GrokAdapter` (model dialect + reasoning-effort mapping) applies on
 * that path only. See `ai-docs/reports/grok-subscription/protocol-spec.md`.
 */

import { credentials } from "../../auth/credentials/authority.js";
import { forceRefreshGrokAccessToken } from "../grok/grok-credentials.js";
import { OpenAIProviderTransport } from "./openai.js";

export class GrokSubscriptionProviderTransport extends OpenAIProviderTransport {
  /**
   * Sign from the credential authority.
   *
   * Deliberately NOT cached on the instance, unlike the Codex/Devin transports:
   * ComposedHandler caches one transport per model for the life of the process,
   * which is routinely longer than this token's six hours. `getRequestAuth()`
   * is cheap when the token is live (one small file read) and is the only place
   * that notices expiry, so calling it per request is what keeps a long session
   * working.
   */
  async getHeaders(): Promise<Record<string, string>> {
    const auth = await credentials.getRequestAuth("grok-subscription", {
      model: this.modelName,
    });
    const headers: Record<string, string> = { ...auth.headers };
    // Provider-declared headers still merge, for parity with the base class.
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }
    return headers;
  }

  /**
   * ComposedHandler's 401 hook: refresh once and retry, ignoring `expires_at`.
   *
   * The local expiry is advisory — the server can revoke a token early, and a
   * skewed clock can make a dead token look live. Without this the same dead
   * token is re-sent on every request and the session is stuck until the user
   * works out that they need to re-run `grok login`.
   */
  async forceRefreshAuth(): Promise<void> {
    await forceRefreshGrokAccessToken();
  }
}
