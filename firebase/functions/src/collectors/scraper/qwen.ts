import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

/**
 * Qwen/DashScope pricing scraper — parses Alibaba Cloud Model Studio pricing page.
 * Tables have: Model | Input tokens per request | Input price (per 1M tokens) | Output price (per 1M tokens) | Free quota
 * Uses the base tier price (smallest context range) for each model.
 */
export class QwenScraper extends BaseCollector {
  readonly collectorId = "qwen-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL, 20000);

      const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
      if (tables.length === 0) {
        throw new Error("HTML parse broken for Qwen: no tables found");
      }

      const models: RawModel[] = [];
      const seen = new Set<string>();

      for (const table of tables) {
        // Only process tables with pricing headers
        if (!table.includes("Input price") && !table.includes("per 1M tokens")) continue;

        const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

        for (const row of rows) {
          const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? [])
            .map(c => c.replace(/<[^>]+>/g, "").trim());

          if (cells.length < 4) continue;

          // Model name is in first cell, must start with "qwen"
          const modelId = cells[0].toLowerCase();
          if (!modelId.startsWith("qwen")) continue;
          // Skip batch/snapshot variants listed as sub-rows
          if (modelId.includes("batch") || seen.has(modelId)) continue;

          // Find price cells — they contain "$" followed by a number
          const inputPrice = cells.find((c, i) => i > 0 && c.startsWith("$"))?.replace("$", "");
          // Output price — find from the end, skip free quota column
          const priceCells = cells.filter(c => c.startsWith("$"));
          const outputPrice = priceCells.length >= 2 ? priceCells[1].replace("$", "") : undefined;

          if (!inputPrice || !outputPrice) continue;

          seen.add(modelId);
          models.push({
            collectorId: this.collectorId,
            confidence: "api_official",
            sourceUrl: SOURCE_URL,
            externalId: modelId,
            canonicalId: modelId,
            displayName: modelId,
            provider: "qwen",
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

      validateParseResults("Qwen", models, 3);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
