import { BaseCollector } from "../base-collector.js";
import type { CollectorResult } from "../../schema.js";

/**
 * xAI pricing scraper — NO-OP.
 * Replaced by xai-api collector which returns pricing natively
 * (prompt_text_token_price, completion_text_token_price in nano-dollars).
 */
export class XAIScraper extends BaseCollector {
  readonly collectorId = "xai-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    return this.makeResult([], "xAI pricing sourced from native API — scraper not needed");
  }
}
