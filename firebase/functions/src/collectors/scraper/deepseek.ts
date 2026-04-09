import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";

/**
 * DeepSeek pricing scraper — parses clean HTML table from API docs.
 * Table has: MODEL | deepseek-chat | deepseek-reasoner
 * Pricing rows: 1M INPUT TOKENS (CACHE HIT/MISS) | $X.XX
 */
export class DeepSeekScraper extends BaseCollector {
  readonly collectorId = "deepseek-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const table = html.match(/<table[\s\S]*?<\/table>/)?.[0];
      if (!table) {
        throw new Error("HTML parse broken for DeepSeek: no pricing table found");
      }

      const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

      // Extract model names from the MODEL row
      let modelNames: string[] = [];
      let cacheMissPrice: string | null = null;
      let cacheHitPrice: string | null = null;
      let outputPrice: string | null = null;
      let contextLength: number | undefined;
      for (const row of rows) {
        const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? [])
          .map(c => c.replace(/<[^>]+>/g, "").trim());

        if (cells.some(c => c === "MODEL")) {
          modelNames = cells.filter(c => c.startsWith("deepseek-"));
        }
        if (cells.some(c => c.includes("CACHE MISS"))) {
          cacheMissPrice = cells.find(c => c.startsWith("$"))?.replace("$", "") ?? null;
        }
        if (cells.some(c => c.includes("CACHE HIT"))) {
          cacheHitPrice = cells.find(c => c.startsWith("$"))?.replace("$", "") ?? null;
        }
        if (cells.some(c => c.includes("OUTPUT TOKENS"))) {
          outputPrice = cells.find(c => c.startsWith("$"))?.replace("$", "") ?? null;
        }
        if (cells.some(c => c.includes("CONTEXT LENGTH"))) {
          const ctxStr = cells.find(c => c.match(/\d+K/i));
          if (ctxStr) contextLength = parseInt(ctxStr) * 1000;
        }
      }

      if (modelNames.length === 0) {
        throw new Error("HTML parse broken for DeepSeek: no model names in table");
      }

      const models: RawModel[] = modelNames.map(name => ({
        collectorId: this.collectorId,
        confidence: "scrape_verified" as const,
        sourceUrl: SOURCE_URL,
        externalId: name,
        canonicalId: name,
        displayName: name,
        provider: "deepseek",
        pricing: {
          input: parseFloat(cacheMissPrice ?? "0"),
          output: parseFloat(outputPrice ?? "0"),
          ...(cacheHitPrice ? { cachedRead: parseFloat(cacheHitPrice) } : {}),
        },
        contextWindow: contextLength,
        capabilities: {
          thinking: name.includes("reasoner"),
          tools: true,
          streaming: true,
          vision: false,
          jsonMode: true,
          batchApi: false,
          structuredOutput: false,
          citations: false,
          codeExecution: false,
          pdfInput: false,
          fineTuning: false,
        },
        status: "active",
      }));

      validateParseResults("DeepSeek", models, 1);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
