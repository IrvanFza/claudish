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
      // The Alibaba Cloud pricing page has a region tab bar:
      //   [International] [Global] [US] [Chinese Mainland] [China (Hong Kong)] [EU]
      //
      // qwen3.6-plus and other Singapore-region pricing live inside the
      // International tab. The tables are rendered by client-side JS when
      // the tab is active — they are NOT in the initial server HTML. Without
      // the click + JS render, Browserbase returns ~240KB of shell with
      // 0 parseable tables.
      //
      // Strategy: click the International tab in afterLoad, then ASK
      // BROWSERBASE TO WAIT FOR THE JS-RENDERED CONTENT via waitForFunction.
      // The wait is the authoritative signal that we can capture HTML —
      // no blind setTimeout.
      let html = await fetchRenderedHTML(SOURCE_URL, {
        timeoutMs: 60000,
        waitUntil: "networkidle0",
        waitForTimeoutMs: 20000,
        // Click the International tab so its content starts rendering
        afterLoad: async (page) => {
          await page.evaluate(() => {
            // Alibaba uses Ant Design Tabs; the accessible name is
            // "International". Search any clickable element whose text
            // matches exactly.
            const nodes = Array.from(
              document.querySelectorAll<HTMLElement>(
                "[role='tab'], .ant-tabs-tab, button, a",
              ),
            );
            for (const el of nodes) {
              if ((el.textContent ?? "").trim() === "International") {
                el.click();
                return;
              }
            }
          });
        },
        // Block until a <table> containing our target strings actually
        // exists in the DOM. This is the JS-render readiness signal.
        waitForFunction: () => {
          const tables = document.querySelectorAll("table");
          for (const t of Array.from(tables)) {
            const txt = t.textContent ?? "";
            if (txt.includes("Input price") || txt.includes("per 1M tokens")) {
              return true;
            }
          }
          return false;
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
