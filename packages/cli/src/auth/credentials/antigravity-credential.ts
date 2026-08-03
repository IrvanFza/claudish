/**
 * Antigravity credential (OAuth-based, subscription endpoint).
 *
 * Mirrors gemini-credential.ts, but:
 *  - the OAuth token comes from the SHARED Antigravity store (`agy` keychain
 *    item), refreshed/written back by getValidAntigravityAccessToken();
 *  - the identity is ALWAYS Antigravity (antigravity UA + ideType ANTIGRAVITY),
 *    independent of CLAUDISH_GEMINI_ANTIGRAVITY;
 *  - the requested model id is resolved to a LIVE-served id
 *    (resolveAntigravityModelId over getServedAntigravityModels) before it goes
 *    into the CodeAssist envelope.
 *
 * Request artifact:
 *  - Authorization: Bearer <antigravity oauth token>
 *  - User-Agent: antigravity/cli/1.1.9 (...)
 *  - x-activity-request-id: short random id (matches the Antigravity CLI logger)
 *  - payload wrapped in the CodeAssist envelope
 *    {model, project, user_prompt_id, request: <inner>} (+ enabled_credit_types
 *    for paid tiers).
 */

import { randomUUID } from "node:crypto";
import { resolveAntigravityModelId } from "../../providers/transport/antigravity.js";
import {
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
} from "../antigravity-token.js";
import {
  buildAntigravityUserAgent,
  getServedAntigravityModels,
  setupAntigravityUser,
} from "../gemini-oauth.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/** Generate a short random request ID (matches the Antigravity CLI activity logger). */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

export class AntigravityCredentialProvider implements CredentialProvider {
  readonly catalogName = "antigravity";

  /**
   * Available when a shared Antigravity token exists in the keychain. Never
   * throws (a non-macOS platform or an absent store resolves to false), matching
   * the authority's "readiness never brings down the caller" contract.
   */
  async isAvailable(): Promise<boolean> {
    try {
      return readSharedAntigravityToken() !== null;
    } catch {
      return false;
    }
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await getValidAntigravityAccessToken();
    const { projectId, tierId } = await setupAntigravityUser(token);
    // Resolve the requested id against the LIVE served set (fetchAvailableModels).
    const { servedIds, defaultId } = await getServedAntigravityModels(token, projectId);
    const servedModel = resolveAntigravityModelId(ctx.model, servedIds, defaultId);
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": buildAntigravityUserAgent(),
        "x-activity-request-id": createActivityRequestId(),
      },
      transformPayload: (inner: any) => {
        const env: any = {
          model: servedModel,
          project: projectId,
          user_prompt_id: randomUUID(),
          request: inner,
        };
        if (tierId && tierId !== "free-tier") {
          env.enabled_credit_types = ["GOOGLE_ONE_AI"];
        }
        return env;
      },
    };
  }
}
