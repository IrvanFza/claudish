import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const ZHIPU_API_KEY = defineSecret("ZHIPU_API_KEY");

interface ZhipuModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ZhipuListResponse {
  object: string;
  data: ZhipuModel[];
}

export class ZhipuCollector extends BaseCollector {
  readonly collectorId = "zhipu-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://open.bigmodel.cn/api/paas/v4/models", {
        headers: {
          Authorization: `Bearer ${ZHIPU_API_KEY.value()}`,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`Zhipu API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as ZhipuListResponse;

      for (const m of data.data ?? []) {
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        const id = m.id;
        const isVision = id.includes("v") && !id.includes("video"); // GLM-4.6V etc.

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://open.bigmodel.cn/api/paas/v4/models",
          externalId: id,
          canonicalId: id,
          displayName: id,
          provider: "z-ai",
          releaseDate,
          capabilities: {
            vision: isVision,
            tools: true,  // GLM-4+ models support function calling
            streaming: true,
            thinking: false,
            jsonMode: true,
            structuredOutput: true,
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
