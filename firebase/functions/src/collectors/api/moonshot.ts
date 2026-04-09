import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const MOONSHOT_API_KEY = defineSecret("MOONSHOT_API_KEY");

interface MoonshotModel {
  id: string;
  created: number;
  owned_by: string;
  supports_image_in?: boolean;
  context_length?: number;
}

interface MoonshotListResponse {
  object: string;
  data: MoonshotModel[];
}

export class MoonshotCollector extends BaseCollector {
  readonly collectorId = "moonshot-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.moonshot.ai/v1/models", {
        headers: {
          Authorization: `Bearer ${MOONSHOT_API_KEY.value()}`,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`Moonshot API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as MoonshotListResponse;

      for (const m of data.data ?? []) {
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        const isThinking = m.id.includes("thinking") || m.id.includes("reasoner");

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://api.moonshot.ai/v1/models",
          externalId: m.id,
          canonicalId: m.id,
          displayName: m.id,
          provider: "moonshotai",
          contextWindow: m.context_length,
          releaseDate,
          capabilities: {
            vision: m.supports_image_in ?? false,
            tools: true,  // Moonshot models support function calling
            streaming: true,
            thinking: isThinking,
            jsonMode: true,
            structuredOutput: false,
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
