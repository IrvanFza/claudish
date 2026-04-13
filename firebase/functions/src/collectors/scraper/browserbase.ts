import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";

export interface FetchRenderedOptions {
  /**
   * Fallback ms to wait after the page loads, used only when no
   * waitForSelector / waitForFunction is provided. Prefer an explicit
   * readiness predicate over a blind timeout.
   */
  waitMs?: number;
  /** Page navigation timeout. */
  timeoutMs?: number;
  /**
   * Which navigation event to wait for. Defaults to "networkidle0" which
   * waits until there have been zero network requests for 500ms — the
   * strongest signal that client-side JS has finished making XHR/fetch
   * calls. "networkidle2" is looser (≤2 in-flight requests) and is only
   * appropriate for pages with long-poll connections.
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  /**
   * Wait for a CSS selector to appear in the DOM before capturing HTML.
   * This is the CORRECT way to wait for JS-rendered content on SPAs — the
   * selector appearing is a direct signal that the content we care about
   * has been rendered. Far better than a blind setTimeout.
   *
   * If both waitForSelector and waitForFunction are set, both must succeed.
   */
  waitForSelector?: string;
  /**
   * Wait for a JS predicate to return truthy before capturing HTML. Use
   * when a single CSS selector is not specific enough — e.g. "wait for a
   * <table> whose text contains 'Input price'".
   */
  waitForFunction?: () => boolean | Promise<boolean>;
  /**
   * Timeout for waitForSelector / waitForFunction. Default: 20s.
   */
  waitForTimeoutMs?: number;
  /**
   * Optional hook called AFTER initial navigation but BEFORE waitForSelector
   * / waitForFunction. Use this to click a tab, expand an accordion, scroll,
   * etc. — actions that trigger the JS rendering we're then waiting for.
   * Thrown errors are logged and swallowed.
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
  const waitMs = opts.waitMs ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const waitUntil = opts.waitUntil ?? "networkidle0";
  const waitForSelector = opts.waitForSelector;
  const waitForFunction = opts.waitForFunction;
  const waitForTimeoutMs = opts.waitForTimeoutMs ?? 20000;
  const afterLoad = opts.afterLoad;
  const hasExplicitWait = Boolean(waitForSelector || waitForFunction);

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

    await page.goto(url, { waitUntil, timeout: timeoutMs });

    // Optional post-load hook (click a tab, expand an accordion, scroll, etc.)
    // Runs BEFORE the explicit wait — the hook is what triggers the JS work
    // we're then waiting for.
    if (afterLoad) {
      try {
        await afterLoad(page);
      } catch (err) {
        console.warn(`[browserbase] afterLoad hook failed for ${url}:`, err);
      }
    }

    // Wait for a specific DOM signal instead of a blind setTimeout. This is
    // the correct way to handle JS-rendered pages: block until the content
    // we care about exists, not until some arbitrary timer fires.
    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: waitForTimeoutMs });
      } catch (err) {
        console.warn(
          `[browserbase] waitForSelector "${waitForSelector}" timed out for ${url}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (waitForFunction) {
      try {
        await page.waitForFunction(waitForFunction, { timeout: waitForTimeoutMs });
      } catch (err) {
        console.warn(
          `[browserbase] waitForFunction timed out for ${url}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fallback: if no explicit wait was provided, honor the legacy waitMs.
    // Prefer an explicit predicate over this blind wait whenever possible.
    if (!hasExplicitWait) {
      await new Promise(r => setTimeout(r, waitMs));
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
