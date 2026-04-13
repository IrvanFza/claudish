import type { CollectorResult } from "./schema.js";

// Major providers whose new models are worth announcing
const MAJOR_PROVIDERS = new Set([
  "anthropic", "openai", "google", "mistral", "deepseek", "xai", "meta",
]);

/**
 * Send a Slack alert summarizing model catalog collection results.
 * Only sends when there are failures. Silently swallows errors
 * so a Slack outage never blocks the catalog pipeline.
 */
export async function alertCatalogResults(
  webhookUrl: string,
  results: CollectorResult[],
  mergedCount: number,
  durationMs: number,
): Promise<void> {
  if (!webhookUrl) return;

  const failures = results.filter(r => r.error);
  const successes = results.filter(r => !r.error);

  // Don't alert if everything succeeded
  if (failures.length === 0) return;

  const failureLines = failures
    .map(r => `• \`${r.collectorId}\`: ${truncate(r.error ?? "unknown", 120)}`)
    .join("\n");

  const text =
    `:warning: *Model Catalog Collection — ${failures.length} failure${failures.length > 1 ? "s" : ""}*\n` +
    `OK: ${successes.length} | Failed: ${failures.length} | Models merged: ${mergedCount} | Duration: ${Math.round(durationMs / 1000)}s\n\n` +
    `${failureLines}`;

  await sendSlack(webhookUrl, text);
}

/**
 * Send a Slack notification for newly discovered models from major providers.
 */
export async function alertNewModels(
  webhookUrl: string,
  newModelIds: string[],
  providerMap: Record<string, string>,
): Promise<void> {
  if (!webhookUrl) return;

  // Filter to major providers only
  const majorNew = newModelIds.filter(id => {
    const provider = providerMap[id] ?? "";
    return MAJOR_PROVIDERS.has(provider.toLowerCase());
  });

  if (majorNew.length === 0) return;

  const lines = majorNew
    .map(id => `• \`${id}\` (${providerMap[id] ?? "unknown"})`)
    .join("\n");

  const text =
    `:sparkles: *${majorNew.length} new model${majorNew.length > 1 ? "s" : ""} discovered*\n\n` +
    `${lines}`;

  await sendSlack(webhookUrl, text);
}

/**
 * Send a Slack alert when the pre-publish diff gate rejects a new
 * recommended-models doc. Violations are emitted in the order the gate
 * produced them. The doc will have been written to
 * `config/recommended-models-pending` by the caller.
 */
export async function alertRecommendationDiff(
  webhookUrl: string,
  violations: string[],
): Promise<void> {
  if (!webhookUrl) return;
  if (violations.length === 0) return;

  const lines = violations
    .map((v) => `• ${truncate(v, 200)}`)
    .join("\n");

  const text =
    `:rotating_light: *Recommended models — diff gate rejected ${violations.length} violation${violations.length > 1 ? "s" : ""}*\n` +
    `New doc written to \`config/recommended-models-pending\` (live doc unchanged)\n\n` +
    `${lines}`;

  await sendSlack(webhookUrl, text);
}

/**
 * Send a Slack alert when a provider's model count drops drastically
 * between runs. Fired from the scheduled collector cron.
 */
export async function alertProviderDrop(
  webhookUrl: string,
  drops: Array<{ provider: string; before: number; after: number }>,
): Promise<void> {
  if (!webhookUrl) return;
  if (drops.length === 0) return;

  const lines = drops
    .map((d) => `• \`${d.provider}\`: ${d.before} → ${d.after} models`)
    .join("\n");

  const text =
    `:warning: *Provider model-count drop detected (${drops.length} provider${drops.length > 1 ? "s" : ""})*\n\n` +
    `${lines}`;

  await sendSlack(webhookUrl, text);
}

async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      console.warn(`[catalog] Slack alert failed: ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[catalog] Slack alert error: ${err}`);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
