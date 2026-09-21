export interface CatalogRouteBinding {
  routeId: string;
  routeProfileId: string;
}

/**
 * Transport bindings between Claudish providers and catalog v3 routes.
 * Model membership and wire IDs remain catalog data; this table only identifies
 * the transport adapter that can execute each canonical route.
 */
export const CATALOG_ROUTE_BINDINGS: Readonly<Record<string, CatalogRouteBinding>> = {
  "native-anthropic": { routeId: "anthropic", routeProfileId: "claude-code-subscription" },
  anthropic: { routeId: "anthropic", routeProfileId: "direct-api" },
  "openai-codex": { routeId: "openai", routeProfileId: "codex-subscription" },
  openai: { routeId: "openai", routeProfileId: "direct-api" },
  "kimi-coding": { routeId: "moonshotai", routeProfileId: "kimi-code-subscription" },
  kimi: { routeId: "moonshotai", routeProfileId: "direct-api" },
  moonshotai: { routeId: "moonshotai", routeProfileId: "direct-api" },
  "glm-coding": { routeId: "z-ai", routeProfileId: "glm-coding-subscription" },
  "z-ai": { routeId: "z-ai", routeProfileId: "direct-api" },
  // The SAME endpoint as `z-ai` (both are https://api.z.ai) under a second
  // claudish name, because the two carry different key silos: ZHIPU_API_KEY and
  // ZAI_API_KEY. Both must bind, or a user whose key sits in the other variable
  // loses Z.ai by bare name with nothing printed — measured on 11 models when
  // only `z-ai` was bound. Which one serves is then the credential filter's
  // decision, which is where it belongs.
  glm: { routeId: "z-ai", routeProfileId: "direct-api" },
  "grok-subscription": { routeId: "x-ai", routeProfileId: "supergrok-subscription" },
  "x-ai": { routeId: "x-ai", routeProfileId: "direct-api" },
  "minimax-coding": { routeId: "minimax", routeProfileId: "coding-plan-subscription" },
  minimax: { routeId: "minimax", routeProfileId: "direct-api" },
  "sakana-subscription": { routeId: "sakana", routeProfileId: "fugu-subscription" },
  sakana: { routeId: "sakana", routeProfileId: "direct-api" },
  devin: { routeId: "cognition", routeProfileId: "devin-subscription" },
  antigravity: { routeId: "google", routeProfileId: "antigravity-subscription" },
  google: { routeId: "google", routeProfileId: "direct-api" },
  "qwen-coding": { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
  "qwen-token-plan": { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
  "qwen-payg": { routeId: "qwen", routeProfileId: "dashscope-direct" },
  qwen: { routeId: "qwen", routeProfileId: "dashscope-direct" },
  "opencode-zen-go": { routeId: "opencode", routeProfileId: "go-subscription" },
  "opencode-zen": { routeId: "opencode", routeProfileId: "zen" },
  zen: { routeId: "opencode", routeProfileId: "zen" },
  ollamacloud: { routeId: "ollama", routeProfileId: "cloud" },
  openrouter: { routeId: "openrouter", routeProfileId: "gateway" },
  together: { routeId: "together-ai", routeProfileId: "gateway" },
  fireworks: { routeId: "fireworks", routeProfileId: "gateway" },
  poe: { routeId: "poe", routeProfileId: "gateway" },
  vertex: { routeId: "vertex", routeProfileId: "google-cloud" },
  deepseek: { routeId: "deepseek", routeProfileId: "direct-api" },
  mistralai: { routeId: "mistralai", routeProfileId: "direct-api" },
};

export function catalogRouteForProvider(provider: string): CatalogRouteBinding | undefined {
  return CATALOG_ROUTE_BINDINGS[provider];
}

export function providerForCatalogRoute(
  route: CatalogRouteBinding | undefined
): string | undefined {
  return providersForCatalogRoute(route)[0];
}

/**
 * EVERY claudish provider bound to one catalog route, in declaration order.
 *
 * The binding table is many-to-one on purpose: one endpoint can wear several
 * claudish names because each name owns a different key silo (`glm` and `z-ai`
 * are both https://api.z.ai, under ZHIPU_API_KEY and ZAI_API_KEY), and some
 * names are legacy spellings kept so an old `provider@model` spec still parses.
 *
 * Routing must consider all of them, and {@link providerForCatalogRoute} — which
 * answers with the first — silently hid the rest: a user whose key sat in the
 * second silo lost the model by bare name, with no error, because the candidate
 * carrying their credential was never gathered. Deciding WHICH of them serves is
 * the credential filter's job; a name with no provider definition drops out on
 * its own, one layer down, since it has no tier.
 */
export function providersForCatalogRoute(route: CatalogRouteBinding | undefined): string[] {
  if (!route) return [];
  return Object.entries(CATALOG_ROUTE_BINDINGS)
    .filter(
      ([, binding]) =>
        binding.routeId === route.routeId && binding.routeProfileId === route.routeProfileId
    )
    .map(([provider]) => provider);
}

export function catalogRouteMatchesProvider(
  route: CatalogRouteBinding | undefined,
  provider: string
): boolean {
  const binding = catalogRouteForProvider(provider);
  return (
    route !== undefined &&
    binding !== undefined &&
    route.routeId === binding.routeId &&
    route.routeProfileId === binding.routeProfileId
  );
}
