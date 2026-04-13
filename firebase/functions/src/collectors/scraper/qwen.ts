import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import { fetchRenderedHTML } from "./browserbase.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

/**
 * Qwen/DashScope pricing scraper.
 *
 * The Alibaba pricing page uses JavaScript to render tab content.
 * The International tab (with qwen3.6-plus pricing) is NOT in the static HTML.
 *
 * Strategy:
 * 1. Try Browserbase (rendered HTML with all JS content) — gets everything
 * 2. Fall back to plain fetch (static HTML) — gets Global tab only
 */
export class QwenScraper extends BaseCollector {
  readonly collectorId = "qwen-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      // Try Browserbase first for full JS-rendered content
      let html = await fetchRenderedHTML(SOURCE_URL, 15000, 60000);

      // Fall back to static HTML if Browserbase unavailable
      if (!html) {
        html = await fetchHTML(SOURCE_URL, 20000);
      }

      const models = parseQwenPricing(html);

      validateParseResults("Qwen", models, 3);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}

function parseQwenPricing(html: string): RawModel[] {
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
        .replace(/\s+/g, "")
        .replace(/batch.*$/i, "")
        .replace(/context.*$/i, "")
        .trim();

      if (!rawModelId.startsWith("qwen") && !rawModelId.startsWith("qwq")) continue;
      if (seen.has(rawModelId)) continue;

      const priceCells = cells.filter(c => c.startsWith("$"));
      if (priceCells.length < 2) continue;

      const inputPrice = parseFloat(priceCells[0].replace("$", ""));
      const outputPrice = parseFloat(priceCells[1].replace("$", ""));

      if (isNaN(inputPrice) || isNaN(outputPrice)) continue;

      seen.add(rawModelId);
      models.push({
        collectorId: "qwen-pricing-scrape",
        confidence: "api_official",
        sourceUrl: SOURCE_URL,
        externalId: rawModelId,
        canonicalId: rawModelId,
        displayName: rawModelId,
        provider: "qwen",
        pricing: { input: inputPrice, output: outputPrice },
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

  return models;
}
