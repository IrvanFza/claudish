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
import { XAICollector } from "./collectors/api/xai.js";
import { MoonshotCollector } from "./collectors/api/moonshot.js";
import { ZhipuCollector } from "./collectors/api/zhipu.js";
import { DashScopeCollector } from "./collectors/api/dashscope.js";
import { AnthropicPricingScraper } from "./collectors/scraper/anthropic-pricing.js";
import { OpenAIPricingScraper } from "./collectors/scraper/openai-pricing.js";
import { GooglePricingScraper } from "./collectors/scraper/google-pricing.js";
import { GLMScraper } from "./collectors/scraper/glm.js";
import { DeepSeekScraper } from "./collectors/scraper/deepseek.js";
// XAIScraper removed — xai-api collector returns pricing natively
import { MistralPricingScraper } from "./collectors/scraper/mistral-pricing.js";

export class CollectorOrchestrator {
  // API collectors — run fully in parallel
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
    new XAICollector(),
    new MoonshotCollector(),
    new ZhipuCollector(),
    new DashScopeCollector(),
  ];

  // Pricing scrapers — HTML-based (no Firecrawl dependency).
  // Anthropic pricing still uses Firecrawl; the rest parse HTML directly.
  // All can run in parallel since they're just HTTP fetches.
  private scraperCollectors: BaseCollector[] = [
    new AnthropicPricingScraper(),   // Firecrawl (only remaining)
    new OpenAIPricingScraper(),      // HTML parse: developers.openai.com
    new GooglePricingScraper(),      // HTML parse: ai.google.dev/pricing
    new GLMScraper(),                // HTML parse: docs.z.ai/pricing
    new DeepSeekScraper(),           // HTML parse: api-docs.deepseek.com
    // xAI scraper removed — xai-api collector returns pricing natively
    new MistralPricingScraper(),     // HTML parse: docs.mistral.ai (Next.js RSC)
  ];

  async runAll(): Promise<CollectorResult[]> {
    const start = Date.now();
    const totalCount = this.apiCollectors.length + this.scraperCollectors.length;
    console.log(
      `[catalog] running ${totalCount} collectors ` +
      `(${this.apiCollectors.length} API + ${this.scraperCollectors.length} scrapers, all parallel)`
    );

    // Run everything in parallel — no more Firecrawl batching needed
    const allResults = await Promise.allSettled([
      ...this.apiCollectors.map(c => c.collect()),
      ...this.scraperCollectors.map(c => c.collect()),
    ]);

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
