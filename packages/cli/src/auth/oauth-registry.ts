import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface OAuthProviderDescriptor {
  credentialFile: string;
  validationMode: "file-exists" | "check-expiry";
  expiresAtField?: string;
  expiryBufferMs?: number;
}

/**
 * Providers with working OAuth device authorization flows.
 *
 * Providers NOT listed here use API keys only (no public OAuth device-auth endpoint):
 *   - openai        (OPENAI_API_KEY) - OpenAI direct API uses API keys only
 *   - minimax       (MINIMAX_API_KEY) - API key only
 *   - minimax-coding (MINIMAX_CODING_API_KEY) - API key only
 *   - glm           (ZHIPU_API_KEY) - API key only
 *   - glm-coding    (GLM_CODING_API_KEY) - API key only
 *   - ollamacloud   (OLLAMA_API_KEY) - API key only
 *   - z-ai          (ZAI_API_KEY) - API key only
 *   - litellm       (LITELLM_API_KEY) - API key only
 *   - vertex        (VERTEX_API_KEY / VERTEX_PROJECT) - uses ADC / service account
 *
 * These providers are covered by the direct API-key step (Step 3) in the
 * auto-routing priority chain.  OAuth entries can be added here in future
 * phases if those providers implement a public device-auth grant.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDescriptor> = {
  // Kimi / Moonshot AI - Device Authorization Grant (RFC 8628)
  // Login via: claudish login kimi
  "kimi-coding": {
    credentialFile: "kimi-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  kimi: {
    credentialFile: "kimi-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  // OpenAI Codex - OAuth2 PKCE flow (browser-based, ChatGPT Plus/Pro subscription)
  // Login via: claudish login codex
  "openai-codex": {
    credentialFile: "codex-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  // NOTE: there is deliberately no `google` / `gemini-codeassist` entry here.
  // Both used to point at ~/.claudish/gemini-oauth.json, the Gemini Code Assist
  // token. That product was retired by Google for individuals and the provider
  // has been removed; `google` is now purely the direct Gemini API, keyed by
  // GEMINI_API_KEY, and the Gemini subscription flow is `antigravity` (whose
  // token lives in the shared agy keychain, not in a file here).
  //
  // Leaving them registered meant a leftover gemini-oauth.json still read as a
  // live credential — which is how a dead provider kept its place in the config
  // TUI's provider list and failed every Test All run.
};

function hasValidOAuthCredentials(descriptor: OAuthProviderDescriptor): boolean {
  const credPath = join(homedir(), ".claudish", descriptor.credentialFile);
  if (!existsSync(credPath)) return false;

  if (descriptor.validationMode === "file-exists") {
    return true;
  }

  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (!data.access_token) return false;

    // If a refresh_token is present the handler can refresh at request time,
    // so the credential is usable regardless of whether the access token has expired.
    if (data.refresh_token) return true;

    // No refresh token - must verify the access token itself hasn't expired.
    if (descriptor.expiresAtField && data[descriptor.expiresAtField]) {
      const buffer = descriptor.expiryBufferMs ?? 0;
      return data[descriptor.expiresAtField] > Date.now() + buffer;
    }

    return true;
  } catch {
    return false;
  }
}

export function hasOAuthCredentials(providerName: string): boolean {
  const descriptor = OAUTH_PROVIDERS[providerName];
  if (!descriptor) return false;
  return hasValidOAuthCredentials(descriptor);
}
