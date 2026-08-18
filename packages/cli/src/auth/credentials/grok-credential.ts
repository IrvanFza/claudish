/**
 * Grok Build subscription credential — the Grok CLI's own OIDC token.
 *
 * The `grok-subscription` provider definition sets `apiKeyEnvVar: ""`, and that
 * is load-bearing rather than an oversight. proxy-server's generic
 * credential-extraction block runs only for a NON-empty value and derives the
 * key by stripping `Bearer ` from `auth.headers.Authorization`. That would
 * "work" here by accident — the artifact really is a bearer token — but it would
 * hand proxy-server a token that expires in six hours and cache it past its
 * life, bypassing the refresh this provider exists to perform. Keeping the env
 * var empty makes proxy-server skip the block and forces every request through
 * `getRequestAuth()`, which is the only place expiry is checked. Same structural
 * choice as Devin and Antigravity, for a different underlying reason.
 *
 * `XAI_API_KEY` is deliberately NOT aliased here. That key is the METERED `x-ai`
 * credential; honouring it would let a pay-per-token key authenticate a provider
 * claudish reports as flat-rate `SUB` — the exact ambiguity that keeps
 * `openai-codex` out of `SUBSCRIPTION_PROVIDERS`.
 */

import {
  grokAuthHeaders,
  hasGrokCredentials,
  resolveGrokAccessToken,
  resolveGrokClientVersion,
} from "../../providers/grok/grok-credentials.js";
import type { CredentialProvider, RequestAuth } from "./types.js";

export class GrokSubscriptionCredentialProvider implements CredentialProvider {
  readonly catalogName = "grok-subscription";

  /**
   * Available when `grok login` has written a credential. Never throws — an
   * absent Grok CLI is the normal state for every user who does not have one.
   */
  async isAvailable(): Promise<boolean> {
    try {
      return hasGrokCredentials();
    } catch {
      return false;
    }
  }

  /**
   * Resolve (refreshing when expired) and sign.
   *
   * No memoization here on purpose: the token has a 6-hour life and
   * `resolveGrokAccessToken` already single-flights the refresh, so caching at
   * this layer would only add a way to serve an expired token.
   */
  async getRequestAuth(): Promise<RequestAuth> {
    // Both resolved async so the client version can come from the live channel
    // pointer when no Grok CLI is installed — the standalone
    // `claudish login grok` case, where a shipped constant would eventually
    // fall below the proxy's minimum and 426 every request.
    const [token, version] = await Promise.all([
      resolveGrokAccessToken(),
      resolveGrokClientVersion(),
    ]);
    return { headers: grokAuthHeaders(token, version) };
  }
}
