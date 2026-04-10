import puppeteer from "puppeteer-core";

/**
 * Fetch rendered HTML from a URL using Browserbase (headless browser as a service).
 * Use this for pages that require JavaScript rendering (dynamic tabs, SPAs).
 * Falls back gracefully if Browserbase credentials are not configured.
 */
export async function fetchRenderedHTML(
  url: string,
  waitMs = 5000,
  timeoutMs = 30000,
): Promise<string | null> {
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
