import { resolveSubscriptionRouting } from "../adapters/model-catalog.js";
import { credentials } from "../auth/credentials/authority.js";
import type { ReadinessResult } from "../auth/credentials/types.js";
import { resolveDefaultProvider } from "../default-provider.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import { log, logStderr } from "../logger.js";
import type { RecommendedModelsDoc } from "../model-loader.js";
import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingEntry, RoutingRules } from "../profile-config.js";
import { DISPLAY_NAMES, PROVIDER_TO_PREFIX } from "./auto-route.js";
import { resolveExternalId } from "./catalog-client.js";
import { ensureEndpointsRegistered } from "./endpoint-registration.js";
import { providerServesModel } from "./model-availability.js";
import { AUTO_ROUTE_PROVIDER, PROVIDER_SHORTCUTS } from "./model-parser.js";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";
import { catalogDeniesProvider, gatherRouteCandidates } from "./route-candidates.js";
import { buildCredentialHint } from "./routing-hints.js";

export interface RoutingRuleSources {
  globalRules: RoutingRules;
  localRules: RoutingRules;
  recommendedModels?: RecommendedModelsDoc;
}

/**
 * Load the user's effective routing rules. Two layers, both the user's own:
 *   1. Global config (~/.claudish/config.json)
 *   2. Local config (./.claudish.json)
 *
 * Local overwrites global by exact key match — no glob-vs-glob interleaving.
 *
 * THERE ARE NO BUILT-IN RULES. The 24-entry `DEFAULT_ROUTING_RULES` table this
 * used to merge under the user's rules is gone: the providers that can serve a
 * bare name are now GATHERED from the cloud models catalog
 * (`route-candidates.ts`), which publishes every tier — subscriptions, native
 * APIs and gateways — for every model, and which the table could only
 * approximate by hand. So the result here is frequently `{}`, and `routeBare`
 * treats "no rule matched" as "ask the catalog" rather than as an error.
 *
 * What a user rule now MEANS is therefore stronger than it was: a match is used
 * VERBATIM and is never merged with, reordered by or appended to by anything —
 * including the fallback hop. `routing["*"] = []` is consequently still the
 * strict no-route switch it always was, and `routing["*"] = [...]` replaces the
 * fallback outright.
 *
 * `sources` keeps rule composition testable without reading machine config.
 * The recommended-model projection is not a routing-rule override.
 */
export function loadRoutingRules(sources?: RoutingRuleSources): RoutingRules {
  const local = sources ? sources.localRules : (loadLocalConfig()?.routing ?? {});
  const global_ = sources ? sources.globalRules : (loadConfig().routing ?? {});

  validateRoutingRules(local);
  validateRoutingRules(global_);

  return { ...global_, ...local };
}

/**
 * Validate that every provider name a routing rules table references exists in
 * `provider-definitions.ts`. Walks each entry, strips the optional `@model`
 * suffix, resolves shortcuts (e.g. `or` → `openrouter`), and looks each
 * canonical provider up.
 *
 * Throws, so it is for a caller that wants a typo to be loud — a config
 * validator or a test — never the request path. `loadRoutingRules` deliberately
 * does not call it: a user whose hand-written rule names a provider claudish
 * dropped should get a degraded chain and a warning, not a crash on every
 * request.
 *
 * Its subject used to be the shipped table, which is gone. What remains to
 * check is the USER's rules, which is the only table left.
 */
export function validateRoutingRulesAgainstProviders(rules: RoutingRules): void {
  const unknown: Array<{ rule: string; entry: string; provider: string }> = [];

  for (const ruleKey of Object.keys(rules)) {
    const entries = rules[ruleKey] ?? [];
    for (const entry of entries) {
      const atIdx = entry.indexOf("@");
      const providerRaw = atIdx === -1 ? entry : entry.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      if (!getProviderByName(canonical)) {
        unknown.push({ rule: ruleKey, entry, provider: canonical });
      }
    }
  }

  if (unknown.length > 0) {
    const lines = unknown.map(
      (u) => `  rule "${u.rule}" → entry "${u.entry}" → unknown provider "${u.provider}"`
    );
    throw new Error(`[claudish] routing rules reference unknown providers:\n${lines.join("\n")}`);
  }
}

/** Warn about config issues that would silently misbehave. */
function validateRoutingRules(rules: RoutingRules): void {
  // Track lower-cased keys to catch case-insensitive collisions. Matching is
  // case-insensitive, so two keys that differ only in case will silently
  // collapse to whichever the iteration order favors. Warn the user.
  const seenLower = new Map<string, string>();
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      console.error(
        `[claudish] Warning: routing pattern "${key}" has multiple wildcards — only single * is supported. This pattern may not match as expected.`
      );
    }
    const lower = key.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined && prior !== key) {
      console.error(
        `[claudish] Warning: routing patterns "${prior}" and "${key}" collide case-insensitively. Matching is case-insensitive, so one will silently shadow the other. Pick one casing and remove the duplicate.`
      );
    } else {
      seenLower.set(lower, key);
    }
    // Empty chain is valid — explicit no-fallback mode (route() returns
    // no-route). No warning needed; user opted in.
  }
}

/**
 * Match a model name against routing rules. Case-INSENSITIVE — provider
 * docs and catalogs use mixed casing (`MiniMax-M2.5`, `GPT-4o`) but the
 * underlying APIs accept any case, so users get bitten when copy-paste
 * casing doesn't exactly match a lowercase rule key.
 *
 * Priority: exact → longest glob → "*" catch-all → null (use default chain).
 *
 * NOTE: only the rule LOOKUP is lowered. The original `modelName` casing is
 * preserved when the route is built and sent to provider APIs (some are
 * case-sensitive on their own model IDs).
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  const lowered = modelName.toLowerCase();

  // 1. Exact match (case-insensitive over rule keys)
  for (const [key, entries] of Object.entries(rules)) {
    if (!key.includes("*") && key.toLowerCase() === lowered) return entries;
  }

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return rules[pattern];
  }

  // 3. Catch-all (may be an empty array — caller treats that as "no route")
  if (rules["*"] !== undefined) return rules["*"];

  return null;
}

/**
 * Convert routing entries to Route objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 */
export function buildRoutingChain(
  entries: RoutingEntry[],
  originalModelName: string,
  cachePath?: string
): Route[] {
  const routes: Route[] = [];

  for (const entry of entries) {
    const atIdx = entry.indexOf("@");
    let providerRaw: string;
    let modelName: string;

    if (atIdx !== -1) {
      providerRaw = entry.slice(0, atIdx);
      modelName = entry.slice(atIdx + 1);
    } else {
      providerRaw = entry;
      modelName = originalModelName;
    }

    // Resolve shortcut
    const provider = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();

    // Subscription endpoints speak their own wire ids (Kimi Code serves `k3`,
    // not the catalog's `kimi-k3`). When the entry didn't pin a model
    // explicitly, translate via the catalog — and drop the candidate outright
    // when the plan doesn't include this model, so the chain falls through to a
    // provider that can actually serve it instead of erroring or silently
    // handing back a different model.
    let wireIdResolved = false;
    if (atIdx === -1) {
      const routing = resolveSubscriptionRouting(modelName, provider, cachePath);
      if (routing.kind === "not-served") continue;
      if (routing.kind === "serves") {
        modelName = routing.externalId;
        // Already the plan's wire id — do NOT resolve again below, or the
        // generic lookup would translate an external id a second time.
        wireIdResolved = true;
      }
    }

    // Every provider's wire id comes from the SAME catalog lookup
    // (`aggregators[]`), not a per-provider resolver. This is what makes
    // `ag@gemini-3.6-flash` reach `gemini-3.6-flash-high` and
    // `together-ai@glm-5` reach `zai-org/GLM-5` without either provider
    // needing bespoke code. No match → the name passes through unchanged.
    if (!wireIdResolved) {
      modelName = resolveExternalId(modelName, provider, cachePath) ?? modelName;
    }

    routes.push(routeFor(provider, modelName));
  }

  return routes;
}

/**
 * One provider plus the id it will actually be SENT → a `Route`.
 *
 * The ONE copy of the modelSpec rule, which has exactly one exception:
 * OpenRouter's ids are already vendor-qualified (`moonshotai/kimi-k3`), so they
 * are their own spec, while everyone else takes a provider prefix. Both callers
 * go through here — `buildRoutingChain`, which resolves a wire id from a user
 * rule, and the catalog-candidate adapter, which is HANDED one — so the rule
 * cannot drift between the two paths. `wireIdOf` is its inverse and would
 * silently disagree if a second copy appeared.
 */
function routeFor(provider: string, wireId: string): Route {
  const modelSpec =
    provider === "openrouter" ? wireId : `${PROVIDER_TO_PREFIX[provider] ?? provider}@${wireId}`;
  return { provider, modelSpec, displayName: DISPLAY_NAMES[provider] ?? provider };
}

/**
 * Single-wildcard glob: "kimi-*" matches "kimi-k2.5". Case-INSENSITIVE so
 * `MiniMax-M2.5` matches `minimax-*` and `GPT-4o` matches `gpt-*`. Provider
 * docs use mixed casing, model IDs in catalogs are usually lowercase, but
 * users routinely paste from docs and would otherwise hit the catch-all.
 */
function globMatch(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (star === -1) return p === v;
  const prefix = p.slice(0, star);
  const suffix = p.slice(star + 1);
  return v.startsWith(prefix) && v.endsWith(suffix) && v.length >= prefix.length + suffix.length;
}

// ---------------------------------------------------------------------------
// route() — single routing entry point (plan §B.3)
// ---------------------------------------------------------------------------

/** A single resolved route candidate. */
export interface Route {
  /** Canonical provider name (e.g. "openai", "openrouter"). */
  provider: string;
  /** Ready-to-handle "provider@model" string for downstream handler creation. */
  modelSpec: string;
  /** Human-readable provider label. */
  displayName: string;
}

/**
 * Result of resolving a model spec.
 *
 *   - `kind: "ok"`        — at least one credentialed provider was found.
 *                           `primary` is the first; `fallbacks` follow in order.
 *   - `kind: "no-route"`  — either the explicit prefix had no credentials
 *                           configured, or the chain was empty after credential
 *                           filtering. `hint` is a multi-line message with
 *                           actionable suggestions.
 */
export type RoutePlan =
  | { kind: "ok"; primary: Route; fallbacks: Route[] }
  | { kind: "no-route"; reason: string; hint?: string };

/**
 * Check whether the user has credentials for a given canonical provider.
 *
 * Delegates to the credential authority's sync readiness oracle. The authority's
 * per-provider impls replicate every special case this function used to inline:
 *   - `native-anthropic` requires an explicit ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *     (NativeAnthropicCredentialProvider).
 *   - `openai-codex` requires its codex-specific key or OAuth — the OPENAI_API_KEY
 *     alias is excluded (the Codex composite's API-key half has no aliases).
 *   - Local transports (ollama, lmstudio, vllm, mlx) require explicit enablement
 *     (LocalCredentialProvider → isLocalProviderEnabled).
 *   - OAuth-backed providers (kimi, antigravity) accept an OAuth file or env
 *     key; the oauthFallback affordance is honored by ApiKeyCredentialProvider.
 *     (A `publicKeyFallback` affordance also used to be honored here; it was
 *     removed — a keyless provider now declares `authScheme: "none"`.)
 *
 * Equivalence with the previous inline logic is pinned by
 * auth/credentials/equivalence.test.ts.
 */
export async function hasCredentialsForProvider(provider: string): Promise<boolean> {
  return credentials.isAvailable(provider);
}

/**
 * Path 1: an explicit "provider@model" spec. Probe ONLY that provider's
 * credentials; never fall back silently.
 *
 */
async function routeExplicit(
  modelSpec: string,
  model: string,
  provider: string,
  cachePath?: string
): Promise<RoutePlan> {
  if (!(await hasCredentialsForProvider(provider))) {
    return {
      kind: "no-route",
      reason: `No credentials configured for "${provider}".`,
      hint: buildCredentialHint(model, [provider]) ?? undefined,
    };
  }

  const built = buildRoutingChain([modelSpec], model, cachePath)[0];
  if (!built) {
    return {
      kind: "no-route",
      reason: `Could not build a route for "${modelSpec}".`,
    };
  }

  // An explicit address is NEVER silently dropped — the user named this vendor,
  // so a "does not serve it" verdict is something to TELL them, not something to
  // route around. That is the difference from the bare path, where claudish
  // assembled the chain itself and may quietly pick another link.
  //
  // Without this the request still fails, just later and less clearly: OpenCode
  // Zen Go answers for a model it does not carry with HTTP 401, which reads as a
  // credential problem and sends the user to check a key that works.
  if ((await providerServesModel(built.provider, wireIdOf(built))) === "not-served") {
    return {
      kind: "no-route",
      reason: `${built.displayName} does not serve "${model}".`,
      hint:
        `Check the model id, or use a bare \`${model}\` to let claudish pick a provider ` +
        "that carries it.",
    };
  }

  return { kind: "ok", primary: built, fallbacks: [] };
}

/**
 * The provider that occupies the LAST hop, or null when the user disabled it.
 *
 * The fallback is a POSITION, not a property of any provider (see `RouteTier`).
 * Two ways to empty that position, and BOTH are preserved from the design this
 * replaced:
 *
 *   - `defaultProvider: ""` — an explicitly empty string. `undefined` is not the
 *     same thing: unset means "no preference", which takes `openrouter`, and
 *     that is what the deleted `"*": ["openrouter"]` catch-all used to supply
 *     for 1,109 models. Only a deliberate empty string disables.
 *   - a user rule that matches — `routing["*"] = []` most explicitly. That
 *     never reaches here at all: a matched rule is used verbatim and this
 *     function is only consulted on the gathered path.
 */
function fallbackProviderFor(defaultProvider: string | undefined): string | null {
  if (defaultProvider !== undefined && defaultProvider.length === 0) return null;
  const named = defaultProvider ?? DEFAULT_FALLBACK_PROVIDER;
  return PROVIDER_SHORTCUTS[named.toLowerCase()] ?? named.toLowerCase();
}

/**
 * The provider the last hop takes when the user expressed no preference.
 *
 * A rule, not a pinned model id: it names the one gateway that resells nearly
 * every vendor, which is why the deleted table used it as its catch-all. It is
 * overridden by `defaultProvider` and emptied by `defaultProvider: ""`.
 */
export const DEFAULT_FALLBACK_PROVIDER = "openrouter";

/**
 * The `defaultProvider` this process routes with when no caller named one:
 * `CLAUDISH_DEFAULT_PROVIDER`, then `defaultProvider` in the config file, then
 * `openrouter` (`resolveDefaultProvider`). May be `""`, which disables the
 * fallback hop.
 *
 * Read per call, like the rules. `route()` without overrides and `--probe`'s
 * chain both read it here, so the two cannot name different fallback hops. The
 * `--default-provider` flag arrives through the env variable (index.ts exports it).
 */
export function effectiveDefaultProvider(): string {
  return resolveDefaultProvider({ config: loadConfig(), env: process.env }).provider;
}

/** A chain assembled from the catalog, plus whether a catalog could be read. */
export interface CatalogChain {
  routes: Route[];
  /**
   * False means NO catalog was readable — not merely that it lacked this name.
   * A caller must treat that as "claudish cannot answer", never as "no provider
   * serves it": the two look identical in `routes` and only this tells them
   * apart.
   */
  catalogReadable: boolean;
}

/**
 * Steps 2 and 3 of the bare-name path: gather from the catalog, then append the
 * fallback hop. No credential or availability filtering — those belong to
 * `routeBare`, which owns them, and duplicating either here would create the
 * second oracle `route-candidates.ts` exists to avoid.
 *
 * Exported because `--probe` reconstructs the chain it is about to test rather
 * than calling `route()` (it needs per-hop credential provenance that a
 * `RoutePlan` does not carry). Before this existed, the probe read the same
 * hand-written table `route()` did; with that table gone, a probe that only
 * consulted user rules would have shown an EMPTY chain for every model the user
 * had not written a rule for — a display that says "nothing routes this" about
 * models that route fine.
 */
export function buildCatalogChain(
  model: string,
  defaultProvider?: string,
  cachePath?: string
): CatalogChain {
  // Bundled endpoints (`together`, `fireworks`) have no provider DEFINITION
  // until this has run, and `gatherFromConnections` drops a connection whose
  // provider it cannot resolve — silently, because that is also what a provider
  // the user holds no key for looks like. An earlier preview ran without it and
  // blamed this redesign for 241 unroutable `together-ai` connections it had
  // not caused.
  //
  // Called HERE rather than trusted from a caller: six startup paths register
  // endpoints and this is reachable from all of them plus the MCP server, the
  // launcher's context-window probe and the TUI. Sync, config-only and latched,
  // so every call after the first is free.
  ensureEndpointsRegistered();

  const gathering = gatherRouteCandidates(model, cachePath);
  const routes = gathering.candidates.map((candidate) =>
    routeFor(candidate.provider, candidate.wireId)
  );

  const fallback = fallbackProviderFor(defaultProvider);
  if (
    fallback &&
    // NEVER invent a hop with no catalog: `openrouter@<name>` for a name nobody
    // published is a metered request billed for its own 404, and a name the
    // backend has since RENAMED looks identical.
    gathering.catalogReadable &&
    !routes.some((route) => route.provider === fallback) &&
    !catalogDeniesProvider(fallback, model, cachePath)
  ) {
    // Through `buildRoutingChain`, not `routeFor`: the fallback is named by
    // PROVIDER only, so its wire id still has to be resolved, and that
    // resolution (subscription plan ids, then the catalog's `aggregators[]`)
    // lives there. It legitimately yields nothing when a subscription's plan
    // does not include the model.
    routes.push(...buildRoutingChain([fallback], model, cachePath));
  }

  return { routes, catalogReadable: gathering.catalogReadable };
}

/** Why a bare name's chain is empty before any credential is read. */
type EmptyChainCause = "rule-empty" | "catalog-empty";

/**
 * The no-route plan for a bare name whose chain is empty before any credential
 * is read. Two very different causes, and a user reading the message needs to
 * know which: their OWN rule named nothing (they asked for this), or the catalog
 * publishes no way to call the model (nobody serves it).
 */
function emptyChainNoRoute(
  model: string,
  nativeProvider: string,
  cause: EmptyChainCause,
  cachePath?: string
): RoutePlan {
  return {
    kind: "no-route",
    reason:
      cause === "rule-empty"
        ? `A routing rule matched "${model}" and named no provider.`
        : `No provider in the catalog serves "${model}".`,
    hint: emptyChainHint(model, nativeProvider, cause, cachePath),
  };
}

/**
 * The hint for a bare name whose chain is empty before any credential is read:
 * a user rule that named no provider, or a catalog that gathered none.
 *
 * `nativeProvider` is the provider the parser attributed the name to, and its
 * credential line is offered when it IS one. `AUTO_ROUTE_PROVIDER` says the
 * parser attributed the name to nobody, so there is no credential to name. Before
 * it existed those names parsed as `native-anthropic`, and the hint told the user
 * to set ANTHROPIC_API_KEY for a model Anthropic does not serve.
 *
 * When the CATALOG gathered nothing for such a name, the `or@<model>` line is
 * also dropped if the catalog denies OpenRouter the model (`catalogDeniesProvider`,
 * the test that withholds the fallback append): it would send the user to a hop
 * nobody published. Not for a matched user rule, whose empty chain is the user's
 * own statement, and not for a name the parser attributes to a provider: that
 * one keeps the line whatever the catalog says, the same flaw, left to a
 * separate fix.
 */
function emptyChainHint(
  model: string,
  nativeProvider: string,
  cause: EmptyChainCause,
  cachePath?: string
): string | undefined {
  if (nativeProvider !== AUTO_ROUTE_PROVIDER) {
    return buildCredentialHint(model, [nativeProvider]) ?? undefined;
  }
  const suggestOpenRouter =
    cause === "rule-empty" || !catalogDeniesProvider("openrouter", model, cachePath);
  return buildCredentialHint(model, [], { suggestOpenRouter }) ?? undefined;
}

/**
 * Path 2: a bare model name.
 *
 * ── STEP 1 IS THE ONLY THING THIS PHASE CHANGED ────────────────────────────
 *
 *   1. a user rule matches?  → that chain, VERBATIM. Never merged, reordered or
 *                              appended to, including by the fallback. A match
 *                              of `[]` is a match: the user said "no route".
 *   2. otherwise             → `gatherRouteCandidates`, which reads every
 *                              connection the catalog publishes for this model
 *                              and orders them by tier, vendor, price, window.
 *   3. append the fallback   → last, deduped, disableable, and NOT appended when
 *                              the catalog positively denies it.
 *   4. credential filter     → unchanged, below.
 *   5. availability filter   → unchanged, below.
 *   6. primary + fallbacks.
 *
 * Steps 4 and 5 are deliberately NOT duplicated by step 2 — see the header of
 * `route-candidates.ts`. A gathered candidate is a claim about what the catalog
 * publishes, never a claim that this user can call it.
 */
async function routeBare(
  model: string,
  nativeProvider: string,
  rules: RoutingRules,
  defaultProvider?: string,
  cachePath?: string
): Promise<RoutePlan> {
  // `null` and `[]` are DIFFERENT answers and the old `?? []` conflated them.
  // `[]` is a user rule that matched and named no provider — strict no-route,
  // and the one thing that must not then collect a fallback.
  const matched = matchRoutingRule(model, rules);

  let candidates: Route[];
  if (matched !== null) {
    candidates = buildRoutingChain(matched, model, cachePath);
  } else {
    const gathered = buildCatalogChain(model, defaultProvider, cachePath);

    // NO CATALOG MEANS LOCAL ONLY. With nothing readable, claudish knows no
    // provider serves this name and must say so rather than guess. A namespace
    // claim still counts — that is claudish's own statement about a plan the
    // user holds, not an inference from a catalog it could not read — so the
    // check is on an EMPTY result, not on `catalogReadable` alone. Local
    // providers and explicit `provider@model` specs are unaffected: neither
    // comes through here.
    if (!gathered.catalogReadable && gathered.routes.length === 0) {
      return {
        kind: "no-route",
        reason: `No model catalog available, so "${model}" cannot be routed by name.`,
        hint:
          "Run `claudish --models-refresh` to fetch the catalog, or name the provider " +
          `explicitly (e.g. \`openrouter@${model}\`).`,
      };
    }
    candidates = gathered.routes;
  }

  if (candidates.length === 0) {
    return emptyChainNoRoute(
      model,
      nativeProvider,
      matched !== null ? "rule-empty" : "catalog-empty",
      cachePath
    );
  }

  const credentialed: Route[] = [];
  const skipped: string[] = [];
  const skippedFailed: string[] = [];

  // ── ONE CREDENTIAL READ PER CANDIDATE PER ROUTING DECISION ────────────────
  //
  // Resolve each candidate's credentials concurrently (each call funnels through
  // the SDK serialization queue internally), but keep the original chain ORDER
  // when partitioning into credentialed / skipped.
  //
  // A SUBSCRIPTION candidate is described ONCE, and both facts come from that
  // single answer: whether it joins the chain, and — when it does not — whether
  // its credential was ABSENT or FAILED to resolve. Reading twice (a boolean to
  // partition, then `describeReadiness` to ask why) is the trap: the authority
  // memoizes a resolved key but deliberately NOT a failure, so the two reads
  // can disagree, and a credential that recovered between them would fall out
  // of both partitions and erase the evidence of the failure that removed it.
  //
  // Non-subscription candidates keep the boolean, which is all they can
  // contribute: `skippedFailed` is subscription-only by construction. The
  // boolean is itself the `=== "present"` projection of one `describeReadiness`
  // (authority.ts), so the partition is byte-identical to what it was.
  const verdicts = await Promise.all(
    candidates.map(async (candidate): Promise<ReadinessResult> => {
      if (isSubscriptionProvider(candidate.provider)) {
        return credentials.describeReadiness(candidate.provider);
      }
      const present = await hasCredentialsForProvider(candidate.provider);
      return { readiness: present ? "present" : "absent" };
    })
  );
  candidates.forEach((candidate, i) => {
    const verdict = verdicts[i];
    if (verdict.readiness === "present") {
      credentialed.push(candidate);
      return;
    }
    skipped.push(candidate.provider);
    // Measured causes of a real, present subscription key reading as "no key":
    // a concurrent 1Password handshake denial and its 15-second suppression
    // window, a locked Mac, a disabled or denied Keychain backend, and a stale
    // `.env` shadowing the op:// chain. Each one used to route a paid
    // subscription onto a metered provider with NOTHING printed.
    if (verdict.readiness === "failed") skippedFailed.push(candidate.provider);
  });

  if (credentialed.length === 0) {
    return {
      kind: "no-route",
      reason:
        skipped.length > 0
          ? `No credentialed providers in chain for "${model}" (tried: ${skipped.join(", ")}).`
          : `No providers available for "${model}".`,
      hint: buildCredentialHint(model, skipped) ?? undefined,
    };
  }

  // AVAILABILITY filter — drop a candidate only when a source positively says
  // it does not carry this model.
  //
  // This runs AFTER the credential filter, not before, and the order is not
  // cosmetic: `providerServesModel` may hit the provider's own discovery endpoint,
  // which needs that provider's credential. Asking about a provider the user
  // cannot authenticate to would be a guaranteed-failing round-trip.
  //
  // Only "not-served" removes anything. "unknown" — no source covers this
  // provider, the catalog is cold, the discovery endpoint was briefly down — keeps
  // the candidate exactly where it was. That asymmetry is the whole safety
  // property: reading absence of evidence as denial would drop every provider
  // neither source covers, which is almost entirely the SUBSCRIPTION providers,
  // and would move users off plans they pay for onto metered hops.
  const availability = await Promise.all(
    credentialed.map((candidate) => providerServesModel(candidate.provider, wireIdOf(candidate)))
  );
  const serving: Route[] = [];
  const notServing: string[] = [];
  credentialed.forEach((candidate, i) => {
    if (availability[i] === "not-served") {
      notServing.push(candidate.provider);
    } else {
      serving.push(candidate);
    }
  });

  if (serving.length === 0) {
    // Every credentialed provider positively denied carrying this model. That is
    // strong evidence — "unknown" never lands here — so a clear no-route beats
    // sending a request that each of them would reject in turn.
    return {
      kind: "no-route",
      reason: `No provider serves "${model}" (checked: ${notServing.join(", ")}).`,
      hint: buildCredentialHint(model, notServing) ?? undefined,
    };
  }

  if (notServing.length > 0) {
    log(`[routing] ${model}: skipped ${notServing.join(", ")} — does not serve this model`);
    // Say it OUT LOUD only when the skip changes how the user is billed. A
    // subscription provider dropped in favour of a metered one is a cost change
    // they did not choose — claudish assembled this chain — which is the same
    // reason fallback-handler announces advancing past a spent plan. Every other
    // skip is routine and stays in the debug log.
    const droppedSubscription = notServing.filter((p) => isSubscriptionProvider(p));
    if (droppedSubscription.length > 0 && !isSubscriptionProvider(serving[0].provider)) {
      logStderr(
        // No "[claudish]" here: logStderr adds the prefix itself.
        `${droppedSubscription.join(", ")} does not serve ${model} — ` +
          `using ${serving[0].displayName}, which bills per token.`
      );
    }
  }

  // A subscription dropped because its credential FAILED gets its own notice,
  // never folded into "does not serve": the remedy differs (unlock the keychain
  // or 1Password, not "pick another model"), and "no key" would tell the user
  // to buy a subscription they already hold. Same billing condition as above —
  // said out loud only when the request lands on a metered provider.
  if (skippedFailed.length > 0 && !isSubscriptionProvider(serving[0].provider)) {
    logStderr(
      // No "[claudish]" here: logStderr adds the prefix itself.
      `${skippedFailed.join(", ")}: the credential could not be READ (not "no key") — ` +
        `using ${serving[0].displayName}, which bills per token.`
    );
  }

  const [primary, ...fallbacks] = serving;
  return { kind: "ok", primary, fallbacks };
}

/**
 * The id a route would actually SEND, extracted from its `modelSpec`.
 *
 * `buildRoutingChain` emits `provider@model` for everyone except OpenRouter,
 * whose ids are already vendor-qualified and are their own spec. Availability
 * must be asked about the wire id, never the name the user typed — comparing the
 * typed name would test the wrong side of an `externalId` mapping, and that
 * mapping is exactly what a dynamic models catalog settles (OpenCode Zen Go serves
 * `deepseek-v4-pro`, while the catalog id carries a date suffix).
 */
function wireIdOf(route: Route): string {
  const at = route.modelSpec.indexOf("@");
  return at === -1 ? route.modelSpec : route.modelSpec.slice(at + 1);
}

/**
 * Resolve a model name to a provider chain.
 *
 * Two paths:
 *   1. Explicit prefix (`provider@model`): the caller named the vendor. We
 *      probe ONLY that vendor's credentials; missing credentials → no-route
 *      with a credential hint. **No silent fallback** — `defaultProvider` is
 *      not consulted because the user named a specific vendor.
 *   2. Bare name: a matching USER rule wins verbatim; otherwise the chain is
 *      gathered from the cloud models catalog and the fallback hop is appended
 *      last. Then the credential and availability filters. Empty filtered chain
 *      → no-route with hints. See `routeBare`.
 *
 * Rules and the default provider are loaded fresh each call (via `loadRoutingRules()`
 * and `effectiveDefaultProvider()`, which reads CLAUDISH_DEFAULT_PROVIDER and then
 * the config) unless overrides are supplied. Tests should pass overrides to avoid
 * disk and environment lookups.
 */
/**
 * Rewrite a dash-slugified GLM version to its canonical dotted form
 * (`glm-5-2` → `glm-5.2`), so a client that slugifies dots still finds the
 * catalog entry instead of missing it and falling through to the fallback hop.
 *
 * Anchored and deliberately narrow. The second group must be ALL digits to the
 * end (or to a `-suffix`), which is what keeps dash-native open-model ids
 * intact: `glm-4-9b` and `glm-4-flash` are untouched because "9b" and "flash"
 * are not pure digits.
 *
 * Applied ONLY on the bare-name path, to keep the rewrite's blast radius as
 * small as the problem it solves.
 *
 * To be precise about why that is a choice and not a load-bearing guard:
 * routeExplicit forwards the ORIGINAL `modelSpec` to buildRoutingChain, which
 * re-parses it and takes the model from the entry itself, ignoring the `model`
 * argument for any entry containing "@". So normalizing the explicit path would
 * currently be a no-op rather than a bug. Restricting it here means that stays
 * true even if buildRoutingChain's precedence ever changes.
 *
 * That matters because Devin re-serves other vendors' models under uids that
 * legitimately contain dashes, `glm-5-2` and `glm-5-2-1m` among them (see
 * providers/devin/model-id-resolver.ts). Those are matched against Devin's LIVE
 * dynamic models catalog, so a `dv@glm-5-2` that ever became `dv@glm-5.2` would
 * request a uid that does not exist.
 *
 * No bare name can reach Devin through a COLLIDING family, which is what makes
 * the bare path safe to rewrite. Devin is a dynamic subscription, so it
 * publishes no catalog connection and can only be gathered from its namespace
 * claim — and that claim is exactly `/^swe-/i`, Cognition's own line. A bare
 * `glm-5-2` therefore never produces a Devin candidate, by either route.
 */
export function normalizeGlmSlug(model: string): string {
  return model.replace(
    /^glm-(\d+)-(\d+)(-.*)?$/i,
    (_m, major, minor, suffix) => `glm-${major}.${minor}${suffix ?? ""}`
  );
}

export async function route(
  modelSpec: string,
  rulesOverride?: RoutingRules,
  defaultProviderOverride?: string,
  cachePath?: string
): Promise<RoutePlan> {
  const parsed = parseModelSpec(modelSpec);

  if (parsed.isExplicitProvider) {
    // Not normalized here — see normalizeGlmSlug's note on explicit specs.
    return routeExplicit(modelSpec, parsed.model, parsed.provider, cachePath);
  }

  const rules = rulesOverride ?? loadRoutingRules();
  // When tests pass an explicit `rulesOverride`, treat the rule set as the
  // authoritative source of truth and read the default provider from neither the
  // environment nor the config file — either would leak this machine's setting
  // into unit tests. A caller that passes rules and wants a fallback
  // passes it as the third argument. Callers with no overrides
  // get `effectiveDefaultProvider()`: the env variable, then the config.
  const defaultProvider =
    defaultProviderOverride !== undefined
      ? defaultProviderOverride
      : rulesOverride !== undefined
        ? undefined
        : effectiveDefaultProvider();
  return routeBare(
    normalizeGlmSlug(parsed.model),
    parsed.provider,
    rules,
    defaultProvider,
    cachePath
  );
}

// route() is now async; routeBare returns a Promise which is awaited by the caller.
