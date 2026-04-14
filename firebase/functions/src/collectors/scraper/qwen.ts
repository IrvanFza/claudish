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
    // Alibaba's CDN serves different response bodies to our Browserbase
    // session depending on edge cache / geo / A-B state: sometimes ~240KB
    // shell HTML (no pricing tables), sometimes ~2.4MB fully-rendered.
    // Two requests seconds apart can differ.
    //
    // Strategy: retry up to 3 times with a fresh Browserbase session each
    // attempt. Each retry hits a different edge / cache variant, which
    // usually converges on the 2.4MB response within 3 attempts.
    const MAX_ATTEMPTS = 3;
    let lastErr: string = "no attempts ran";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const html = await fetchQwenPage();
        if (!html) {
          lastErr = "browserbase returned null";
          console.warn(`[qwen-scraper] attempt ${attempt}/${MAX_ATTEMPTS}: ${lastErr}`);
          continue;
        }

        const models = parseQwenPricing(html);
        if (models.length < 3) {
          lastErr = `only parsed ${models.length} models`;
          console.warn(
            `[qwen-scraper] attempt ${attempt}/${MAX_ATTEMPTS}: ${lastErr}, retrying`,
          );
          continue;
        }

        validateParseResults("Qwen", models, 3);
        if (attempt > 1) {
          console.log(
            `[qwen-scraper] succeeded on attempt ${attempt}/${MAX_ATTEMPTS} with ${models.length} models`,
          );
        }
        return this.makeResult(models);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        console.warn(
          `[qwen-scraper] attempt ${attempt}/${MAX_ATTEMPTS} threw: ${lastErr}`,
        );
      }
    }

    // All browserbase retries exhausted — fall back to static HTML fetch
    try {
      const staticHtml = await fetchHTML(SOURCE_URL, 20000);
      const models = parseQwenPricing(staticHtml);
      validateParseResults("Qwen", models, 3);
      console.log(
        `[qwen-scraper] recovered via static HTML fallback with ${models.length} models`,
      );
      return this.makeResult(models);
    } catch (err) {
      return this.makeResult(
        [],
        `all ${MAX_ATTEMPTS} browserbase attempts failed (${lastErr}); static fallback also failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function fetchQwenPage(): Promise<string | null> {
  return fetchRenderedHTML(SOURCE_URL, {
    timeoutMs: 60000,
    waitUntil: "networkidle0",
    waitForTimeoutMs: 25000,
    afterLoad: async (page) => {
      // Scroll into the pricing section — tells virtualized/lazy containers
      // to render this region.
      await page.evaluate(() => window.scrollTo(0, 400));
    },
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
