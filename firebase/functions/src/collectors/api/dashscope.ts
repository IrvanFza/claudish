import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const DASHSCOPE_API_KEY = defineSecret("DASHSCOPE_API_KEY");

interface DashScopeModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

interface DashScopeListResponse {
  data: DashScopeModel[];
}

/**
 * DashScope (Alibaba Cloud Model Studio) — international endpoint.
 * Source of truth for Qwen model availability and IDs.
 */
export class DashScopeCollector extends BaseCollector {
  readonly collectorId = "dashscope-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", {
        headers: {
          Authorization: `Bearer ${DASHSCOPE_API_KEY.value()}`,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`DashScope API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as DashScopeListResponse;

      for (const m of data.data ?? []) {
        // Only collect Qwen text/chat models (skip embedding, audio, image, video models)
        const id = m.id;
        if (!id.startsWith("qwen")) continue;
        if (id.includes("embed") || id.includes("audio") || id.includes("vl-ocr")) continue;

        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        const isVision = id.includes("vl") || id.includes("omni");
        const isThinking = id.includes("thinking") || id.includes("reasoner");

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
          externalId: id,
          canonicalId: id,
          displayName: id,
          provider: "qwen",
          releaseDate,
          capabilities: {
            vision: isVision,
            tools: true,  // Qwen Plus/Max/Coder models support function calling
            streaming: true,
            thinking: isThinking,
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
