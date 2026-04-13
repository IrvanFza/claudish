import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";

export interface FetchRenderedOptions {
  /** Ms to wait after networkidle2 fires (lets deferred JS run). */
  waitMs?: number;
  /** Page navigation timeout. */
  timeoutMs?: number;
  /**
   * Optional hook called AFTER initial navigation + waitMs. Use this to click
   * a specific tab / expand an accordion / scroll, then wait for the dynamic
   * content to appear. Return value ignored. Thrown errors are logged and
   * swallowed (we fall back to whatever HTML is rendered at that point).
   */
  afterLoad?: (page: Page) => Promise<void>;
}

/**
 * Fetch rendered HTML from a URL using Browserbase (headless browser as a service).
 * Use this for pages that require JavaScript rendering (dynamic tabs, SPAs).
 * Falls back gracefully if Browserbase credentials are not configured.
 *
 * Overload: legacy positional form (url, waitMs, timeoutMs) still works.
 */
export async function fetchRenderedHTML(
  url: string,
  waitMs?: number,
  timeoutMs?: number,
): Promise<string | null>;
export async function fetchRenderedHTML(
  url: string,
  options: FetchRenderedOptions,
): Promise<string | null>;
export async function fetchRenderedHTML(
  url: string,
  waitMsOrOpts: number | FetchRenderedOptions = 12000,
  timeoutMsLegacy = 60000,
): Promise<string | null> {
  const opts: FetchRenderedOptions =
    typeof waitMsOrOpts === "number"
      ? { waitMs: waitMsOrOpts, timeoutMs: timeoutMsLegacy }
      : waitMsOrOpts;
  const waitMs = opts.waitMs ?? 12000;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const afterLoad = opts.afterLoad;

  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    console.log("[browserbase] no API key or project ID — skipping rendered fetch");
    return null;
  }

  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;

  try {
    // Create a Browserbase session
    const sessionResp = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "x-bb-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(10000),
    });

    if (!sessionResp.ok) {
      const body = await sessionResp.text();
      console.warn(`[browserbase] session creation failed: ${sessionResp.status} ${body.slice(0, 100)}`);
      return null;
    }

    const session = await sessionResp.json() as { id: string };

    // Connect via CDP
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${session.id}`,
    });

    const [page] = await browser.pages();
    if (!page) {
      console.warn("[browserbase] no page available");
      return null;
    }

    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    await new Promise(r => setTimeout(r, waitMs));

    // Optional post-load hook (e.g. click a tab, expand an accordion).
    if (afterLoad) {
      try {
        await afterLoad(page);
      } catch (err) {
        console.warn(`[browserbase] afterLoad hook failed for ${url}:`, err);
      }
    }

    const html = await page.content();
    console.log(`[browserbase] rendered ${url}: ${html.length} bytes`);

    return html;
  } catch (err) {
    console.warn(`[browserbase] error rendering ${url}:`, err);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}
