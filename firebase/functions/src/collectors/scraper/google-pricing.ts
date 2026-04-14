import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://ai.google.dev/pricing";

/**
 * Google Gemini pricing scraper — parses ai.google.dev/pricing (SSR HTML).
 * The page has model sections with dollar amounts near model names.
 */
export class GooglePricingScraper extends BaseCollector {
  readonly collectorId = "google-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL);

      const models: RawModel[] = [];
      const seen = new Set<string>();

      // Split page by gemini model ID patterns
      const sections = html.split(/(?=gemini-[\d][\w.-]*)/gi);

      for (const section of sections) {
        const modelMatch = section.match(/^(gemini-[\d][\w.-]*)/i);
        if (!modelMatch) continue;

        const modelId = modelMatch[1].toLowerCase();
        if (seen.has(modelId)) continue;
        if (modelId.includes("tts") || modelId.includes("audio")) continue;
        // Reject category headings scraped as model IDs (e.g. "gemini-2.0-models")
        if (modelId.endsWith("-models") || modelId.endsWith("-model")) continue;

        // Find dollar amounts in the next ~1500 chars
        const chunk = section.slice(0, 1500);
        const prices = chunk.match(/\$([\d.]+)/g)?.map(p => parseFloat(p.replace("$", "")));
        if (!prices || prices.length < 2) continue;

        const inputPrice = prices[0];
        const outputPrice = prices[1];
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
