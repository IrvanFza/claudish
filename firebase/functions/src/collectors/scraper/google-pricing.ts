import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://ai.google.dev/pricing";

const EXCLUDED_SUFFIXES = ["-models", "-model"];
const EXCLUDED_KEYWORDS = ["tts", "audio", "embedding", "robotics", "image"];

/**
 * Google Gemini pricing scraper — parses ai.google.dev/pricing (SSR HTML).
 * Splits on <h2 id="gemini-*"> section boundaries and extracts pricing
 * from the Standard tier <table> within each section.
 */
export class GooglePricingScraper extends BaseCollector {
  readonly collectorId = "google-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const models: RawModel[] = [];
      const seen = new Set<string>();

      // Split on <h2 id="gemini-..."> section boundaries
      const sections = html.split(/<h2\s+id="(gemini-[^"]+)"/i);
      // After split: [preamble, id1, content1, id2, content2, ...]

      for (let i = 1; i < sections.length; i += 2) {
        const modelId = sections[i].toLowerCase();
        const content = sections[i + 1] ?? "";

        if (seen.has(modelId)) continue;
        if (EXCLUDED_SUFFIXES.some(s => modelId.endsWith(s))) continue;
        if (EXCLUDED_KEYWORDS.some(k => modelId.includes(k))) continue;

        // Extract pricing from the Standard tier table (first pricing-table)
        const tableMatch = content.match(/<table class="pricing-table">([\s\S]*?)<\/table>/i);
        if (!tableMatch) continue;

        const table = tableMatch[1];

        // Find "Paid Tier" column pricing — dollar amounts in <td> cells
        // The table has: [label, Free Tier, Paid Tier] columns
        // Extract all <td> contents
        const rows = table.match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];

        let inputPrice: number | null = null;
        let outputPrice: number | null = null;

        for (const row of rows) {
          const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? [];
          if (cells.length < 3) continue;

          const label = cells[0]!.toLowerCase();
          // Paid tier is the last column
          const paidCell = cells[cells.length - 1]!;

          const priceMatch = paidCell.match(/\$([\d.]+)/);
          if (!priceMatch) continue;
          const price = parseFloat(priceMatch[1]);

          if (label.includes("input") && inputPrice === null) {
            inputPrice = price;
          } else if (label.includes("output") && outputPrice === null) {
            outputPrice = price;
          }
        }

        if (inputPrice === null || outputPrice === null) continue;
        if (inputPrice > 20 || outputPrice > 50) continue;

        seen.add(modelId);
        models.push({
          collectorId: this.collectorId,
          confidence: "scrape_verified",
          sourceUrl: SOURCE_URL,
          externalId: modelId,
          canonicalId: modelId,
          displayName: modelId,
          provider: "google",
          pricing: { input: inputPrice, output: outputPrice },
          capabilities: {
            vision: true,
            tools: true,
            streaming: true,
            thinking: false,
            batchApi: false,
            jsonMode: true,
            structuredOutput: true,
            citations: false,
            codeExecution: true,
            pdfInput: false,
            fineTuning: false,
          },
          status: modelId.includes("preview") ? "preview" : "active",
        });
      }

      validateParseResults("Google", models, 5);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
