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
      // Try Browserbase first for full JS-rendered content.
      //
      // The Alibaba Cloud pricing page has a region tab bar:
      //   [International] [Global] [US] [Chinese Mainland] [China (Hong Kong)] [EU]
      //
      // The International tab contains `qwen3.6-plus` and other Singapore-region
      // pricing tables. These tables are NOT in the initial server-rendered HTML —
      // they are lazy-loaded when the tab is clicked. Without the click, we get
      // ~240KB of shell content and the parser finds 0 tables.
      //
      // So: navigate → click the International tab → wait for the tables to
      // appear → capture HTML.
      let html = await fetchRenderedHTML(SOURCE_URL, {
        waitMs: 8000,
        timeoutMs: 60000,
        afterLoad: async (page) => {
          // Click the International tab. Try several selectors because Alibaba
          // uses Ant Design Tabs whose selectors change between versions.
          const clicked = await page.evaluate(() => {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>(
                // Common Ant Design Tabs selectors + fallbacks
                "[role='tab'], .ant-tabs-tab, button, a, span, div",
              ),
            );
            for (const el of candidates) {
              const text = (el.textContent ?? "").trim();
              if (text === "International") {
                el.click();
                return true;
              }
            }
            return false;
          });

          if (clicked) {
            // Wait for the International tables to render. Look for a <table>
            // whose first <th> row mentions "Input price" (a string unique to
            // these pricing tables).
            try {
              await page.waitForFunction(
                () => {
                  const tables = document.querySelectorAll("table");
                  for (const t of Array.from(tables)) {
                    const txt = t.textContent ?? "";
                    if (txt.includes("Input price") || txt.includes("per 1M tokens")) {
                      return true;
                    }
                  }
                  return false;
                },
                { timeout: 15000 },
              );
            } catch {
              // Fall through — we'll capture whatever is there and let the
              // parser decide. If the tables never appeared, parseQwenPricing
              // will still throw "no tables found" and we fall back to static.
            }
          }
        },
      });

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
