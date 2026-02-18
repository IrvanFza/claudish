/**
 * PoeProvider — Poe API transport.
 *
 * Transport concerns:
 * - Bearer token auth (POE_API_KEY)
 * - Fixed endpoint: https://api.poe.com/v1/chat/completions
 * - Standard OpenAI SSE format
 */

import type { ProviderTransport, StreamFormat } from "./types.js";

const POE_API_URL = "https://api.poe.com/v1/chat/completions";

export class PoeProvider implements ProviderTransport {
  readonly name = "poe";
  readonly displayName = "Poe";
  readonly streamFormat: StreamFormat = "openai-sse";

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getEndpoint(): string {
    return POE_API_URL;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
