import type { CollectorResult } from "./schema.js";
import type { BaseCollector } from "./collectors/base-collector.js";
import { AnthropicCollector } from "./collectors/api/anthropic.js";
import { OpenAICollector } from "./collectors/api/openai.js";
import { GoogleCollector } from "./collectors/api/google.js";
import { OpenRouterCollector } from "./collectors/api/openrouter.js";
import { TogetherAICollector } from "./collectors/api/together-ai.js";
import { MistralCollector } from "./collectors/api/mistral.js";
import { DeepSeekCollector } from "./collectors/api/deepseek.js";
import { FireworksCollector } from "./collectors/api/fireworks.js";
import { OpenCodeZenCollector } from "./collectors/api/opencode-zen.js";
import { AnthropicPricingScraper } from "./collectors/scraper/anthropic-pricing.js";
import { OpenAIPricingScraper } from "./collectors/scraper/openai-pricing.js";
import { GooglePricingScraper } from "./collectors/scraper/google-pricing.js";
import { GLMScraper } from "./collectors/scraper/glm.js";
import { DeepSeekScraper } from "./collectors/scraper/deepseek.js";
import { XAIScraper } from "./collectors/scraper/xai.js";
import { MistralPricingScraper } from "./collectors/scraper/mistral-pricing.js";

export class CollectorOrchestrator {
  // API collectors — no external rate limits, safe to run fully in parallel
  private apiCollectors: BaseCollector[] = [
    new AnthropicCollector(),
    new OpenAICollector(),
    new GoogleCollector(),
    new OpenRouterCollector(),
    new TogetherAICollector(),
    new MistralCollector(),
    new DeepSeekCollector(),
    new FireworksCollector(),
    new OpenCodeZenCollector(),
  ];

  // Firecrawl scrapers — share a single Firecrawl API key with concurrency limits.
  // Run in batches of 3 to avoid queueing timeouts.
  private scraperCollectors: BaseCollector[] = [
    new AnthropicPricingScraper(),
    new OpenAIPricingScraper(),
    new GooglePricingScraper(),
    new GLMScraper(),
    new DeepSeekScraper(),
    new XAIScraper(),
    new MistralPricingScraper(),
  ];

  private static readonly SCRAPER_BATCH_SIZE = 3;

  async runAll(): Promise<CollectorResult[]> {
    const start = Date.now();
    const totalCount = this.apiCollectors.length + this.scraperCollectors.length;
    console.log(
      `[catalog] running ${totalCount} collectors ` +
      `(${this.apiCollectors.length} API parallel + ${this.scraperCollectors.length} scrapers in batches of ${CollectorOrchestrator.SCRAPER_BATCH_SIZE})`
    );

    // Run API collectors fully in parallel (no shared rate limits)
    const apiPromise = Promise.allSettled(
      this.apiCollectors.map(c => c.collect())
    );

    // Run Firecrawl scrapers in batches to respect concurrency limits
    const scraperResults: PromiseSettledResult<CollectorResult>[] = [];
    for (let i = 0; i < this.scraperCollectors.length; i += CollectorOrchestrator.SCRAPER_BATCH_SIZE) {
      const batch = this.scraperCollectors.slice(i, i + CollectorOrchestrator.SCRAPER_BATCH_SIZE);
      const batchResults = await Promise.allSettled(batch.map(c => c.collect()));
      scraperResults.push(...batchResults);
    }

    // Wait for API collectors (likely already done by now)
    const apiResults = await apiPromise;

    const allResults = [...apiResults, ...scraperResults];
    const collected: CollectorResult[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const result of allResults) {
      if (result.status === "fulfilled") {
        collected.push(result.value);
        if (result.value.error) {
          errorCount++;
          console.warn(
            `[catalog] collector ${result.value.collectorId} partial failure:`,
            result.value.error
          );
        } else {
          successCount++;
        }
      } else {
        errorCount++;
        console.error("[catalog] collector threw unexpectedly:", result.reason);
      }
    }

    const duration = Date.now() - start;
    const totalModels = collected.reduce((sum, r) => sum + r.models.length, 0);
    console.log(
      `[catalog] collection complete: ${successCount} ok, ${errorCount} failed, ` +
      `${totalModels} raw models, ${duration}ms`
    );

    return collected;
  }
}
