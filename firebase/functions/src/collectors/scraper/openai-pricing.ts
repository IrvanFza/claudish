import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://developers.openai.com/api/docs/models";

/**
 * OpenAI pricing scraper — parses developers.openai.com (no Firecrawl needed).
 * The page has model sections with "Input price $X.XX / Input MTok" patterns.
 */
export class OpenAIPricingScraper extends BaseCollector {
  readonly collectorId = "openai-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const parts = html.split(/Input price/);
      const models: RawModel[] = [];

      for (let i = 1; i < parts.length; i++) {
        const before = parts[i - 1].slice(-3000).replace(/<[^>]+>/g, " ");
        const after = parts[i].slice(0, 500);

        const inputPrice = after.match(/\$([\d.]+)/)?.[1];
        const outputPrice = after.match(/Output price[\s\S]*?\$([\d.]+)/)?.[1];

        // Find model ID: last gpt-X.Y or o1/o3/o4 pattern before "Input price"
        const modelIds = before.match(/(?:gpt-[\w.-]+|o[134]-[\w.-]+|chatgpt-[\w.-]+)/gi) ?? [];
        const modelId = modelIds[modelIds.length - 1];

        if (modelId && inputPrice && outputPrice) {
          models.push({
            collectorId: this.collectorId,
            confidence: "scrape_verified",
            sourceUrl: SOURCE_URL,
            externalId: modelId,
            canonicalId: modelId,
            displayName: modelId,
            provider: "openai",
            pricing: {
              input: parseFloat(inputPrice),
              output: parseFloat(outputPrice),
            },
            capabilities: {
              tools: true,
              streaming: true,
              vision: false,
              thinking: false,
              batchApi: false,
              jsonMode: false,
              structuredOutput: false,
              citations: false,
              codeExecution: false,
              pdfInput: false,
              fineTuning: false,
            },
            status: "active",
          });
        }
      }

      validateParseResults("OpenAI", models, 2);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
