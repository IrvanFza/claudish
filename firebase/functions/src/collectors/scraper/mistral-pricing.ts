import { BaseCollector } from "../base-collector.js";
import { fetchHTML, validateParseResults } from "./html-parse.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://docs.mistral.ai/getting-started/models/models_overview/";

/**
 * Mistral pricing scraper — parses Next.js RSC JSON embedded in the HTML.
 * The page has model data in script tags with escaped JSON containing
 * apiNames and pricing blocks.
 */
export class MistralPricingScraper extends BaseCollector {
  readonly collectorId = "mistral-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const html = await fetchHTML(SOURCE_URL, 20000);

      // Find the script tag containing model data
      const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      const dataScript = scripts.find(s =>
        s.includes("pricing") && s.includes("M Token")
      );
      if (!dataScript) {
        throw new Error("HTML parse broken for Mistral: no data script found with pricing");
      }

      // Unescape the Next.js RSC serialized JSON
      // Raw text has literal \" sequences that need to become actual quotes
      let content = dataScript.replace(/<\/?script[^>]*>/gi, "");
      content = content.replace(/\\"/g, '"');

      // Find all apiNames and their preceding pricing blocks
      const models: RawModel[] = [];
      const apiRe = /"apiNames":\["([^"]+)"\]/g;
      let m;

      while ((m = apiRe.exec(content)) !== null) {
        const apiName = m[1];
        const pos = m.index;

        // Look backwards up to 1500 chars for pricing
        const before = content.slice(Math.max(0, pos - 1500), pos);
        const inputMatch = before.match(/"input":\[\{"type":"range","price":([\d.]+)/);
        const outputMatch = before.match(/"output":\[\{"type":"range","price":([\d.]+)/);

        if (!inputMatch || !outputMatch) continue;

        // Check if this is a free model
        const freeMatch = before.match(/"free":(true|false)/);
        const isFree = freeMatch?.[1] === "true";

        models.push({
          collectorId: this.collectorId,
          confidence: "scrape_verified",
          sourceUrl: SOURCE_URL,
          externalId: apiName,
          canonicalId: apiName,
          displayName: apiName,
          provider: "mistral",
          pricing: {
            input: isFree ? 0 : parseFloat(inputMatch[1]),
            output: isFree ? 0 : parseFloat(outputMatch[1]),
          },
          capabilities: {
            vision: apiName.includes("pixtral") || apiName.includes("ocr"),
            tools: true,
            streaming: true,
            thinking: apiName.includes("magistral"),
            batchApi: false,
            jsonMode: true,
            structuredOutput: true,
            citations: false,
            codeExecution: apiName.includes("codestral") || apiName.includes("devstral"),
            pdfInput: false,
            fineTuning: false,
          },
          status: "active",
        });
      }

      validateParseResults("Mistral", models, 5);
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
