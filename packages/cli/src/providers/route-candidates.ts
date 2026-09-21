/**
 * Every way claudish could call one model, gathered from the catalog and ordered.
 *
 * This is the replacement for the FIRST step of `routeBare` — the 24-entry
 * hand-written table in `default-routing-rules.ts`, which names providers per
 * model family and must be edited whenever a vendor, a plan or a gateway
 * changes. Nothing here is wired into routing yet, by design: gathering and
 * wiring are separate steps so the wiring can be measured against what the table
 * does today.
 *
 * WHAT THIS MODULE IS NOT. It does not decide whether a candidate can be USED.
 * Two filters already own that question and neither is duplicated here:
 *
 *   - the CREDENTIAL filter (`hasCredentialsForProvider` → the credential
 *     authority) — no key, no candidate;
 *   - the AVAILABILITY filter (`providerServesModel`, `model-availability.ts`) —
 *     the account's own dynamic models catalog may DENY, and absence of evidence
 *     never denies.
 *
 * So a candidate returned from here is a claim about what the CATALOG publishes,
 * not a claim that this user can call it. Re-asking either question here would
 * create a second oracle, and the pair would disagree the first time one changed.
 *
 * ── Why the catalog can be the only source ─────────────────────────────────
 *
 * Measured on generation `g-20260921062451697-f490edba` (1,123 entries):
 *
 *   - `aggregators[]` carries SUBSCRIPTION routes alongside gateways and native
 *     APIs — `moonshotai/kimi-code-subscription`, `openai/codex-subscription`,
 *     `z-ai/glm-coding-subscription`, `qwen/qwencloud-token-plan`,
 *     `opencode/go-subscription`. One source therefore covers every tier, and the
 *     tier is the only thing that has to come from claudish's own table.
 *   - The VENDOR needs no local table either: a connection whose
 *     `route.routeId` equals the entry's `provider` IS the vendor's own route.
 *     412 of 1,123 models have one; the remaining 709 are served only by
 *     gateways, which is a fact about those models rather than a gap. 100 entries
 *     carry vendor `unknown` and simply get no vendor preference.
 *   - 25 of the 28 published route pairs map to a claudish provider. The three
 *     that do not are `qwen/realtime-websocket` (a WebSocket API with no chat
 *     transport here), `openrouter/decisions` (output modality `["decisions"]`,
 *     not chat) and `opencode/systemone` (a profile claudish has never seen).
 *     Each is SKIPPED and counted in {@link CandidateGathering.unmappedRoutes} —
 *     never guessed at, because a guessed route binding sends a request to the
 *     wrong transport and reads as the model's failure.
 *   - Of 1,734 mapped connections, 923 carry a usable price and 811 do not.
 *     Unknown is a large minority, so the comparator must order it rather than
 *     treat it as an edge case: it sorts LAST among its tier.
 *
 * ── The order ──────────────────────────────────────────────────────────────
 *
 * Decided by the project owner; {@link compareRouteCandidates} implements exactly
 * this and nothing else:
 *
 *     user rules (elsewhere, verbatim, never merged with any of this)
 *       then tier:  subscription → dynamic-subscription → native → gateway → fallback
 *       within a tier:  the model's own vendor first
 *                  then cheapest by catalog price (unknown last)
 *                  then larger context window
 *                  then provider name, ascending, for determinism
 *
 * No local preference list, and NO LOCAL STATE. A spent subscription limit is
 * never remembered: the request moves to the next hop, which is the existing
 * chain's job. A module that remembered would answer differently on two
 * identical inputs, and the reason would live nowhere a user could see.
 */

import { type SlimModelEntry, readAllModelsCache } from "./all-models-cache.js";
import { externalIdFor, getCatalogEntries } from "./catalog-client.js";
import {
  type CatalogRouteBinding,
  catalogRouteForProvider,
  providerForCatalogRoute,
} from "./catalog-route-bindings.js";
import {
  type ConnectionPrice,
  compareByConnectionPrice,
  connectionPrice,
} from "./connection-price.js";
import { type RouteTier, getAllProviders, getProviderByName } from "./provider-definitions.js";

export type { RouteTier };

/** One way to call one model, with everything the order needs to place it. */
export interface RouteCandidate {
  /** claudish provider name. */
  provider: string;
  /** The exact id to send that provider. */
  wireId: string;
  tier: RouteTier;
  /** route.routeId === the catalog entry's `provider`: this vendor makes the model. */
  isVendorOwn: boolean;
  price: ConnectionPrice;
  /** Per-connection context window, when the catalog publishes one. */
  contextWindow?: number;
  source: "catalog-connection" | "namespace-claim";
}

export interface CandidateGathering {
  candidates: RouteCandidate[];
  /** Mapped connections skipped because their route resolves to no claudish provider. */
  unmappedRoutes: string[];
  /** True when no catalog entry matched the name at all. */
  catalogMiss: boolean;
}

/**
 * Tier precedence, as a total map rather than a list.
 *
 * `Record<RouteTier, number>` is exhaustive by construction: adding a sixth tier
 * to the union stops this file compiling, which is the only way to be sure a new
 * tier gets a deliberate position instead of silently sorting as `undefined`.
 */
const TIER_RANK: Record<RouteTier, number> = {
  subscription: 0,
  "dynamic-subscription": 1,
  native: 2,
  gateway: 3,
  fallback: 4,
};

/** `routeId/routeProfileId`, the spelling the backend contract and the reports use. */
function routeLabel(route: CatalogRouteBinding | undefined): string {
  return route ? `${route.routeId}/${route.routeProfileId}` : "(no route)";
}

/**
 * The catalog entry for a requested name, or `undefined`.
 *
 * Canonical model id first, then alias — the order `resolveExternalId` already
 * uses, so both paths agree about which entry a name denotes. The
 * case-insensitive passes come last and exist because users paste ids from vendor
 * docs (`MiniMax-M3`) while the catalog is lowercase; `matchRoutingRule` lowers
 * for the same reason. Exact always wins, so a case-folded collision can never
 * displace a real id.
 */
function findCatalogEntry(entries: SlimModelEntry[], model: string): SlimModelEntry | undefined {
  const exact = entries.find((entry) => entry.modelId === model);
  if (exact) return exact;
  const byAlias = entries.find((entry) => entry.aliases.includes(model));
  if (byAlias) return byAlias;

  const lowered = model.toLowerCase();
  const loweredId = entries.find((entry) => entry.modelId.toLowerCase() === lowered);
  if (loweredId) return loweredId;
  return entries.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === lowered));
}

/**
 * Candidates from the catalog's own connections — the primary source.
 *
 * Every skip below is deliberate and each has a different reason:
 *
 *   - a route that binds to no claudish provider is COUNTED (`unmappedRoutes`),
 *     because "the catalog grew a route we cannot execute" is a fact the next
 *     contract review needs, not noise;
 *   - a provider name with no DEFINITION in this process is counted the same way.
 *     That is how `together-ai/gateway` and `fireworks/gateway` read when the
 *     bundled endpoint catalog has not registered them — which happens exactly
 *     when the user holds no key for them, so the credential filter would have
 *     dropped the candidate anyway;
 *   - a connection whose own `externalModelId` is not the id
 *     {@link externalIdFor} chose for its provider is skipped SILENTLY: another
 *     connection of the same provider carries the chosen id, and this one is the
 *     moving pointer beside it. Reading price and context window from the row
 *     that actually carries the wire id is the whole point of the check;
 *   - `externalIdFor` returning null means every id this provider publishes for
 *     the model is a moving pointer. Its rule — never send a pointer the user did
 *     not ask for — is the one claudish already applies everywhere, so there is
 *     no honest id to send and no candidate.
 */
function gatherFromConnections(
  entry: SlimModelEntry,
  candidates: RouteCandidate[],
  unmappedRoutes: Set<string>
): void {
  for (const connection of entry.aggregators ?? []) {
    if (connection.routeStatus !== "mapped") continue;

    const provider = providerForCatalogRoute(connection.route);
    const tier = provider ? getProviderByName(provider)?.tier : undefined;
    if (!provider || !tier) {
      unmappedRoutes.add(routeLabel(connection.route));
      continue;
    }

    const wireId = externalIdFor(entry, provider);
    if (!wireId || wireId !== connection.externalModelId) continue;

    candidates.push({
      provider,
      wireId,
      tier,
      isVendorOwn: isVendorOwnRoute(connection.route, entry),
      price: connectionPrice(connection.pricing),
      // A connection that omits `contextWindow` serves the model's headline
      // window — that is what the field's absence MEANS in the contract, not
      // missing data. Carrying the entry's value is therefore reading the
      // catalog, not defaulting: without it, `openai-codex`'s measured 372K cap
      // on gpt-5.6-sol would sort AHEAD of the OpenAI API's full 1.05M, which
      // publishes no per-connection number because it is the headline one.
      contextWindow: connection.contextWindow ?? entry.contextWindow,
      source: "catalog-connection",
    });
  }
}

/**
 * The vendor that MAKES the model is the vendor whose own route this is.
 *
 * False with no entry and false for the 100 entries whose vendor is `unknown`:
 * both are an absence of evidence, and this flag's only job is to promote a
 * candidate, so an absence must never promote one.
 */
function isVendorOwnRoute(
  route: CatalogRouteBinding | undefined,
  entry: SlimModelEntry | undefined
): boolean {
  return route !== undefined && entry?.provider !== undefined && route.routeId === entry.provider;
}

/**
 * Candidates from a provider's NAMESPACE CLAIM — dynamic subscriptions only.
 *
 * A dynamic subscription publishes no connection at all, because the ACCOUNT
 * selects what it serves: `antigravity`, `grok-subscription`, `devin` and
 * `sakana-subscription` sit in the probe map as
 * `client_model_selection_required`. The catalog cannot say what a seat was
 * given, so without this source a user's flat-rate plan would be invisible to
 * every gathered chain and the request would land on a metered hop — the one
 * ordering error that costs money rather than a better option.
 *
 * A claim is NOT evidence of service, and that asymmetry is the whole design:
 * the candidate exists so the AVAILABILITY filter can ask the account's own
 * dynamic models catalog, which is the only thing that can answer. Extending
 * this to any other tier would invent routes — a gateway's `nativeModelPatterns`
 * would claim every model in a namespace it may not carry, and nothing
 * downstream would contradict it, because a gateway answers a model it does not
 * have with a 4xx that reads as a credential problem.
 *
 * Today exactly one provider can produce a claim: `devin` (`/^swe-/i`). The
 * other three declare no `nativeModelPatterns` — deliberately, since `x-ai`
 * already owns `/^grok-/i` and Devin's re-served ids collide with four other
 * vendors' namespaces — so their bare-name reachability still comes from the
 * hand-written table. Whoever wires this module in has to close that gap; see
 * the implementation notes for this phase.
 */
function gatherFromNamespaceClaims(
  model: string,
  entry: SlimModelEntry | undefined,
  candidates: RouteCandidate[]
): void {
  for (const def of getAllProviders()) {
    if (def.tier !== "dynamic-subscription") continue;
    if (!def.nativeModelPatterns?.some(({ pattern }) => pattern.test(model))) continue;

    candidates.push({
      provider: def.name,
      // The requested name verbatim. There is no catalog connection to read a
      // wire id from, and the transport resolves the account's own id itself.
      wireId: model,
      tier: def.tier,
      // Same rule as a connection's, asked of the provider's own binding: the
      // claim has no route of its own to compare.
      isVendorOwn: isVendorOwnRoute(catalogRouteForProvider(def.name), entry),
      // Unknown, and unknowable here: a flat-rate plan publishes no per-token
      // rate, and `connectionPrice` is the only thing allowed to say what a
      // missing price is.
      price: connectionPrice(undefined),
      // No context window either: a plan's window varies by tier and comes from
      // the account's own discovery (see `modelDiscovery`).
      source: "namespace-claim",
    });
  }
}

/**
 * Ascending: the candidate a request should be sent to comes first.
 *
 * Exported separately from {@link gatherRouteCandidates} so the order can be
 * tested on constructed candidates, without a catalog — the two halves fail for
 * different reasons and a test that could only reach the sort through a cache
 * file would attribute a gathering bug to the order.
 *
 * Total, not merely consistent: `(provider, wireId)` is unique after deduping, so
 * the last two keys guarantee one fixed answer for any input permutation. A
 * routing order that depended on the catalog's row order would change under a
 * backend re-publish with nothing in claudish having changed.
 */
export function compareRouteCandidates(a: RouteCandidate, b: RouteCandidate): number {
  const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (byTier !== 0) return byTier;

  // The vendor's own route, before anyone reselling it.
  if (a.isVendorOwn !== b.isVendorOwn) return a.isVendorOwn ? -1 : 1;

  const byPrice = compareByConnectionPrice(a.price, b.price);
  if (byPrice !== 0) return byPrice;

  // Larger window first; an unpublished window sorts last, for the same reason an
  // unknown price does — a missing number is not a small number.
  const byContext = (b.contextWindow ?? -1) - (a.contextWindow ?? -1);
  if (byContext !== 0) return byContext;

  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.wireId !== b.wireId) return a.wireId < b.wireId ? -1 : 1;
  return 0;
}

/**
 * Every candidate for one model name, ordered.
 *
 * `cachePath` reads one specific catalog file instead of the process's own
 * snapshot — the seam every routing function already offers so a test can pin a
 * generation rather than depend on whatever the machine last refreshed.
 *
 * With no readable catalog and no namespace claim the answer is an EMPTY list and
 * `catalogMiss: true`. Not a guessed id, and not an invented gateway: the project
 * owner's rule is that with no catalog claudish serves local providers and
 * explicit `provider@model` specs only. Inventing `openrouter@<name>` here would
 * send a name nobody published to a metered gateway and bill for the 404.
 */
export function gatherRouteCandidates(model: string, cachePath?: string): CandidateGathering {
  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();
  const entry = entries ? findCatalogEntry(entries, model) : undefined;

  const gathered: RouteCandidate[] = [];
  const unmappedRoutes = new Set<string>();

  // Source order is the dedupe rule: a real catalog connection beats a namespace
  // claim for the same (provider, wireId), because it carries a price and a
  // window the claim cannot know.
  if (entry) gatherFromConnections(entry, gathered, unmappedRoutes);
  gatherFromNamespaceClaims(model, entry, gathered);

  const seen = new Set<string>();
  const candidates = gathered.filter((candidate) => {
    // JSON, not a delimiter: an injective key is the whole requirement, and any
    // literal separator is a guess about what a wire id cannot contain. This line
    // briefly held a raw NUL byte, which made `file(1)` report the module as
    // binary and grep stop matching it — the trap `devin.ts` hit once before.
    const key = JSON.stringify([candidate.provider, candidate.wireId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  candidates.sort(compareRouteCandidates);

  return {
    candidates,
    unmappedRoutes: [...unmappedRoutes],
    catalogMiss: entry === undefined,
  };
}
