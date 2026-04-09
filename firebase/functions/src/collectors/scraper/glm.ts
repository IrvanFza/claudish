import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://docs.z.ai/guides/overview/pricing";

/**
 * GLM/Z.ai pricing scraper — parses docs.z.ai (clean HTML tables with USD).
 * Tables have columns: Model | Input | Cached Input | Cached Input Storage | Output
 */
export class GLMScraper extends BaseCollector {
  readonly collectorId = "glm-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const models: RawModel[] = [];
      const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];

      for (const table of tables) {
        const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

        for (const row of rows.slice(1)) { // skip header
          const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? [])
            .map(c => c.replace(/<[^>]+>/g, "").trim());

          if (cells.length < 3) continue;
          const modelId = cells[0];
          if (!modelId.match(/^[A-Za-z]/)) continue; // skip non-model rows

          const inputStr = cells[1];
          const outputStr = cells[cells.length - 1];

          const inputPrice = inputStr.match(/\$([\d.]+)/)?.[1];
          const outputPrice = outputStr.match(/\$([\d.]+)/)?.[1];
          const isFree = inputStr === "Free" && outputStr === "Free";

          const cachedReadStr = cells.length >= 3 ? cells[2] : undefined;
          const cachedRead = cachedReadStr?.match(/\$([\d.]+)/)?.[1];

          const isVision = modelId.toLowerCase().includes("v") && !modelId.toLowerCase().includes("video");

          models.push({
            collectorId: this.collectorId,
            confidence: "scrape_verified",
            sourceUrl: SOURCE_URL,
            externalId: modelId,
            canonicalId: modelId.toLowerCase(),
            displayName: modelId,
            provider: "z-ai",
            pricing: {
              input: isFree ? 0 : parseFloat(inputPrice ?? "0"),
              output: isFree ? 0 : parseFloat(outputPrice ?? "0"),
              ...(cachedRead ? { cachedRead: parseFloat(cachedRead) } : {}),
            },
            capabilities: {
              vision: isVision,
              tools: true,
              streaming: true,
              thinking: false,
              batchApi: false,
              jsonMode: true,
              structuredOutput: true,
              citations: false,
              codeExecution: false,
              pdfInput: false,
              fineTuning: false,
            },
            status: "active",
          });
        }
      }

      validateParseResults("GLM/Z.ai", models, 8);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
