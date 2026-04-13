import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const OPENCODE_ZEN_API_KEY = defineSecret("OPENCODE_ZEN_API_KEY");

interface ZenModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  pricing?: {
    input?: number;   // USD per million tokens
    output?: number;
  };
}

interface ZenListResponse {
  object?: string;
  data: ZenModel[];
}

export class OpenCodeZenCollector extends BaseCollector {
  readonly collectorId = "opencode-zen-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://opencode.ai/zen/v1/models", {
        headers: {
          Authorization: `Bearer ${OPENCODE_ZEN_API_KEY.value()}`,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`OpenCode Zen API ${resp.status}: ${await resp.text()}`);
      }

      // Guard against non-JSON responses (endpoint sometimes returns plain text "Not Found")
      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const body = await resp.text();
        throw new Error(`OpenCode Zen API returned non-JSON (${contentType}): ${body.slice(0, 100)}`);
      }

      const data = await resp.json() as ZenListResponse;

      for (const m of data.data ?? []) {
        const pricing =
          m.pricing?.input !== undefined && m.pricing?.output !== undefined
            ? { input: m.pricing.input, output: m.pricing.output }
            : undefined;

        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        // Derive provider from model ID prefix (NOT owned_by — Zen always returns "opencode")
        const slashIdx = m.id.indexOf("/");
        const providerFromId = slashIdx > 0 ? m.id.slice(0, slashIdx) : undefined;
        // Only use owned_by if it's an actual vendor, not a gateway name
        const GATEWAY_NAMES = new Set(["opencode", "opencode-zen", "system"]);
        const ownedByProvider = m.owned_by && !GATEWAY_NAMES.has(m.owned_by) ? m.owned_by : undefined;
        const provider = ownedByProvider ?? providerFromId;

        // Detect thinking models by ID heuristics
        const modelIdLower = m.id.toLowerCase();
        const isThinking =
          modelIdLower.includes("thinking") ||
          modelIdLower.includes("reasoner") ||
          modelIdLower.includes("r1") ||
          modelIdLower.includes("o1") ||
          modelIdLower.includes("o3");

        models.push({
          collectorId: this.collectorId,
          confidence: "gateway_official",
          sourceUrl: "https://opencode.ai/zen/v1/models",
          externalId: m.id,
          canonicalId: slashIdx > 0 ? m.id.slice(slashIdx + 1) : m.id,
          provider,
          contextWindow: m.context_length,
          pricing,
          releaseDate,
          capabilities: {
            vision: false,
            tools: true,
            streaming: true,
            jsonMode: false,
            structuredOutput: false,
            thinking: isThinking,
            batchApi: false,
            citations: false,
            codeExecution: false,
            pdfInput: false,
            fineTuning: false,
          },
          status: "active",
        });
      }

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
