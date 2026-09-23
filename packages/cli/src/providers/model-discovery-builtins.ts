/**
 * The three builtin dynamic models catalog fetchers that are not an HTTP GET.
 *
 * They live HERE, behind `registerModelDiscoveryFetcher`, rather than as
 * `if (descriptor.format === …)` branches inside `model-discovery.ts`. The
 * devin branch predicted this file: "If a third such provider ever appears,
 * replace this branch with a `registerModelDiscoveryFetcher(name, fn)` seam —
 * not worth it for one." Antigravity was the third.
 *
 * What the move buys is dependency DIRECTION. Previously the generic discovery
 * module had to know about Devin's protobuf rpcs, Antigravity's OAuth POST and
 * Ollama's daemon shape, so adding provider #4 meant editing a file that has
 * nothing to do with provider #4. Now it knows none of them: it loads this
 * bundle once, on the first format it cannot serve itself.
 *
 * This module is only ever imported dynamically, which is what keeps the
 * protobuf codec and the Antigravity OAuth path off the cold-start path — the
 * property the original dynamic `import()` calls existed to protect.
 */

import type { DiscoveredModel } from "./model-discovery.js";
import { registerModelDiscoveryFetcher } from "./model-discovery.js";

/**
 * Devin's dynamic models catalog is capability ∩ entitlement over two protobuf rpcs.
 *
 * Carries the full variant metadata, not just id/name/window: the picker folds
 * ~170 uids into ~42 rows and needs the group label, the cost multiplier, the
 * promo and the vendor's own default flag to do it.
 */
async function fetchDevinModelsCatalog(): Promise<DiscoveredModel[]> {
  const { getServedDevinModels } = await import("./devin/devin-models.js");
  const served = await getServedDevinModels();
  if (served.length === 0) return [];

  const { devinModelsCatalogEntry } = await import("./model-resolvers/devin.js");
  return served.map((model) => {
    const { wireId, ...rest } = devinModelsCatalogEntry(model);
    // `chat` is Devin's statement, not ours. This list is the set of models
    // Devin's own agent can drive — capability ∩ entitlement, already filtered
    // to configs with a context window — so every uid in it answers chat turns.
    // Its uids are knob-encoded (`swe-1-7-medium`) and the cloud catalog never
    // lists them verbatim, so judged by id alone 244 of 247 read as unknown.
    return { id: wireId, ...rest, reported: "chat" as const };
  });
}

/**
 * Ids the backend does not declare, but which are still not chat models.
 *
 * `fetchAvailableModels` states unselectability three ways — `isInternal`, the
 * per-feature role lists, and `deprecatedModelIds` — and those cover everything
 * except the `tab_*` pair, which appears in no list and carries no flag. They
 * are the editor's as-you-type completion models: 4096 max output, no thinking,
 * no images, `recommended: false`. They answer HTTP 200, which is precisely what
 * made a wrong-host problem look like a rate limit for an entire session.
 *
 * Prefix-matched, because the ids carry build numbers that rot on each roll of
 * the dynamic models catalog. This is the ONLY guess left in the filter; everything
 * else is declared.
 */
function isUndeclaredEditorInternal(id: string): boolean {
  return id.startsWith("tab_");
}

/**
 * Antigravity lists over an OAuth POST to a Google internal endpoint, not a GET.
 *
 * The reason it is worth a fetcher at all is `maxTokens`: the response reports
 * the window THIS subscription is served, and it disagrees with the shared
 * catalog — `claude-sonnet-4-6` is 250,000 from the backend against 1,000,000
 * in the catalog. `resolveDiscoveredContextLength` already prefers a discovered
 * window over the catalog; this is what gives it one to prefer.
 */
async function fetchAntigravityModelsCatalog(): Promise<DiscoveredModel[]> {
  const { getValidAntigravityAccessToken } = await import("../auth/antigravity-token.js");
  const { setupAntigravityUser, getServedAntigravityModels } = await import(
    "../auth/antigravity-user.js"
  );
  const token = await getValidAntigravityAccessToken();
  if (!token) return [];

  const { projectId } = await setupAntigravityUser(token);
  const { servedIds, meta, excludedIds } = await getServedAntigravityModels(token, projectId);
  // Declared first, guess second. `excludedIds` is the backend's own verdict —
  // internal flags, per-feature role bindings, and retired ids (which look
  // entirely normal but answer 400).
  const declaredExcluded = excludedIds ?? new Set<string>();
  const selectable = servedIds.filter(
    (id) => !declaredExcluded.has(id) && !isUndeclaredEditorInternal(id)
  );
  return selectable.map((id) => {
    const m = meta[id];
    // contextWindow is left UNSET when the backend reported none
    // (gemini-3.1-flash-image does), so the catalog still gets its turn rather
    // than the row rendering a fabricated 0 as "N/A".
    // Every id here is a tuned variant (`-high`, `-tiered`) the catalog does not
    // carry; see `ignoreCatalogReleaseDate` for the ordering this protects.
    // `chat` is the backend's statement: everything it declares non-selectable —
    // internal flags, per-feature role bindings, retired ids — was removed above,
    // and so were the undeclared editor-completion models. What remains is the
    // set it offers for chat. Judged by id alone, 14 of 21 read as unknown,
    // because these tuned variants are ids the cloud catalog does not carry.
    return m?.contextWindow
      ? {
          id,
          contextWindow: m.contextWindow,
          ignoreCatalogReleaseDate: true,
          reported: "chat" as const,
        }
      : { id, ignoreCatalogReleaseDate: true, reported: "chat" as const };
  });
}

/** Ollama's daemon speaks its own listing shape and carries capability data no OpenAI list has. */
async function fetchOllamaModelsCatalog(): Promise<DiscoveredModel[]> {
  const { fetchOllamaModels } = await import("./ollama-discovery.js");
  const { ollamaReported } = await import("./transport/probe-discovery.js");
  const installed = await fetchOllamaModels({ enrichCapabilities: false });
  return installed.map((model) => ({
    id: model.name,
    displayName: model.name,
    supportsTools: model.supportsTools,
    // The daemon's own `capabilities`, read from `/api/tags`: `completion` means
    // chat, `embedding` means not. This row used to carry only name, display name
    // and a tools flag, so the capability data was fetched and then dropped here,
    // and 18 of 19 local builds — none of which the cloud catalog lists — read as
    // unknown. A daemon too old to report the field leaves it unset.
    reported: ollamaReported(model),
  }));
}

registerModelDiscoveryFetcher("devin-connect", fetchDevinModelsCatalog);
registerModelDiscoveryFetcher("antigravity", fetchAntigravityModelsCatalog);
registerModelDiscoveryFetcher("ollama-tags", fetchOllamaModelsCatalog);
