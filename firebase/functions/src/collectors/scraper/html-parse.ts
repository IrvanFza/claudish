/**
 * Shared HTML fetching and parse-validation utilities for HTML-based scrapers.
 * These replace the Firecrawl-dependent scrapers with free, plain HTTP fetching.
 *
 * Parse validation: each scraper declares expected model patterns. If the parser
 * returns fewer models than expected, it reports a parse-broken error (which
 * triggers a Slack alert via the existing alertCatalogResults pipeline).
 */

export interface ParsedModel {
  modelId: string;
  displayName?: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedReadPerMTok?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Fetch HTML from a URL with a reasonable timeout and user-agent.
 */
export async function fetchHTML(url: string, timeoutMs = 15000): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "claudish-catalog/1.0",
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}`);
  }
  return resp.text();
}

/**
 * Validate parse results. If fewer models than minExpected, throw with a
 * descriptive error that will show up in Slack alerts.
 */
export function validateParseResults(
  source: string,
  models: Array<{ externalId?: string; pricing?: { input: number } }>,
  minExpected: number,
): void {
  if (models.length < minExpected) {
    throw new Error(
      `HTML parse broken for ${source}: got ${models.length} models, expected at least ${minExpected}. ` +
      `The page structure may have changed — parser needs updating.`
    );
  }

  // Validate pricing sanity
  for (const m of models) {
    const price = m.pricing?.input ?? 0;
    if (price < 0 || price > 500) {
      throw new Error(
        `HTML parse broken for ${source}: model ${m.externalId} has invalid input price ${price}`
      );
    }
  }
}
