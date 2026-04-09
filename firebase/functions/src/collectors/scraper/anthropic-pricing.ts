import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing";

/**
 * Anthropic pricing scraper — parses platform.claude.com (clean HTML tables).
 * Table columns: Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits | Output Tokens
 */
export class AnthropicPricingScraper extends BaseCollector {
  readonly collectorId = "anthropic-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
      if (tables.length === 0) {
        throw new Error("HTML parse broken for Anthropic: no tables found");
      }

      const models: RawModel[] = [];

      // The first table has the main model pricing
      const rows = tables[0]!.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

      for (const row of rows.slice(1)) { // skip header
        const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? [])
          .map(c => c.replace(/<[^>]+>/g, "").trim());

        if (cells.length < 3) continue;

        const modelName = cells[0]; // e.g. "Claude Opus 4.6"
        if (!modelName.startsWith("Claude")) continue;

        const inputStr = cells[1];  // "$5 / MTok"
        const outputStr = cells[cells.length - 1]; // "$25 / MTok"
        const cacheHitStr = cells.length >= 5 ? cells[4] : undefined; // Cache Hits column

        const inputPrice = inputStr.match(/\$([\d.]+)/)?.[1];
        const outputPrice = outputStr.match(/\$([\d.]+)/)?.[1];
        const cacheHitPrice = cacheHitStr?.match(/\$([\d.]+)/)?.[1];

        if (!inputPrice || !outputPrice) continue;

        // Convert model name to API ID: "Claude Opus 4.6" → "claude-opus-4-6"
        const modelId = modelName
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/\./g, "-");

        models.push({
          collectorId: this.collectorId,
          confidence: "scrape_verified",
          sourceUrl: SOURCE_URL,
          externalId: modelId,
          canonicalId: modelId,
          displayName: modelName,
          provider: "anthropic",
          pricing: {
            input: parseFloat(inputPrice),
            output: parseFloat(outputPrice),
            ...(cacheHitPrice ? { cachedRead: parseFloat(cacheHitPrice) } : {}),
          },
          capabilities: {
            vision: true,
            tools: true,
            streaming: true,
            thinking: true,
            pdfInput: true,
            jsonMode: true,
            structuredOutput: true,
            batchApi: true,
            citations: false,
            codeExecution: false,
            fineTuning: false,
          },
          status: "active",
        });
      }

      validateParseResults("Anthropic", models, 3);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
