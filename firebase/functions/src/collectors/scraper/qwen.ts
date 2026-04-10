import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

/**
 * Qwen/DashScope pricing scraper — parses Alibaba Cloud Model Studio pricing page.
 *
 * The page has tabs (International, Global, US, etc.) rendered via JavaScript.
 * Only the International Qwen-Max section and Global tab content are in the initial HTML.
 * The International Qwen-Plus section (with qwen3.6-plus) loads dynamically.
 *
 * Strategy: extract ALL tables from the HTML, prioritizing models from the
 * `data-cond-props="intl"` International sections. This captures Qwen-Max
 * International pricing and Global tab pricing for other models.
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
        if (!table.includes("Input price") && !table.includes("per 1M tokens")) continue;

        const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

        for (const row of rows) {
          const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? [])
            .map(c => c.replace(/<[^>]+>/g, "").trim());

          if (cells.length < 4) continue;

          const rawModelId = cells[0].toLowerCase()
            .replace(/\s+/g, "")           // collapse whitespace
            .replace(/batch.*$/i, "")       // strip "Batch calling 50% off" suffix
            .replace(/context.*$/i, "")     // strip "Context Cache discount" suffix
            .trim();

          if (!rawModelId.startsWith("qwen") && !rawModelId.startsWith("qwq")) continue;
          if (seen.has(rawModelId)) continue;

          // Extract dollar amounts from cells
          const priceCells = cells.filter(c => c.startsWith("$"));
          if (priceCells.length < 2) continue;

          const inputPrice = parseFloat(priceCells[0].replace("$", ""));
          const outputPrice = parseFloat(priceCells[1].replace("$", ""));

          if (isNaN(inputPrice) || isNaN(outputPrice)) continue;

          seen.add(rawModelId);
          models.push({
            collectorId: this.collectorId,
            confidence: "api_official",
            sourceUrl: SOURCE_URL,
            externalId: rawModelId,
            canonicalId: rawModelId,
            displayName: rawModelId,
            provider: "qwen",
            pricing: {
              input: inputPrice,
              output: outputPrice,
            },
            capabilities: {
              tools: true,
              streaming: true,
              vision: rawModelId.includes("vl"),
              thinking: rawModelId.includes("qwq"),
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
