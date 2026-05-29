/**
 * OllamaCloud ProviderTransport
 *
 * Handles communication with OllamaCloud API (https://ollama.com/api/chat).
 * Uses Bearer token auth and Ollama's native JSONL streaming format.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { discoverViaOpenAIModels } from "./probe-discovery.js";

export class OllamaProviderTransport implements ProviderTransport {
  readonly name = "ollamacloud";
  readonly displayName = "OllamaCloud";
  readonly streamFormat: StreamFormat = "ollama-jsonl";

  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async discoverProbeModel(exclude?: ReadonlySet<string>) {
    // OllamaCloud also exposes /v1/models (OpenAI-compatible alongside its
    // native /api/chat). /v1/models with bearer auth lists the user's
    // available cloud models.
    return discoverViaOpenAIModels(
      `${this.provider.baseUrl}/v1/models`,
      await this.getHeaders(),
      {
        key: `ollamacloud:${this.provider.baseUrl}`,
        displayName: this.displayName,
        exclude,
      }
    );
  }
}

// Backward-compatible alias
/** @deprecated Use OllamaProviderTransport */
export { OllamaProviderTransport as OllamaCloudProvider };
