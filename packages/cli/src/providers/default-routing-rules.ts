/**
 * Default routing rules shipped with claudish.
 *
 * Same shape users edit via `claudish config route` (see `RoutingRules` in
 * `profile-config.ts`). Users can override any pattern (including the catch-all
 * `"*"`) by writing their own routing rules in `~/.claudish/config.json` or a
 * project-local `.claudish.json` — user rules merge ON TOP of these defaults at
 * load time (see `loadRoutingRules` in `routing-rules.ts`).
 *
 * Rule design notes:
 *   - Subscription endpoints come FIRST (people who paid for them want them
 *     used; the chain falls through automatically when subscription credentials
 *     are missing because route() filters by credential availability).
 *   - Direct-API providers come second.
 *   - OpenRouter is last by convention — it's a universal aggregator. Users
 *     who don't want OpenRouter as the catch-all override "*" with their own
 *     chain or [].
 *   - The `provider@model` rewrite syntax (see kimi-* below) is used when a
 *     subscription endpoint expects a different model name than the direct API.
 *
 * Migration plan §B.1 — Commit 4 of the model-catalog and routing redesign.
 */
import type { RoutingRules } from "../profile-config.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";

export const DEFAULT_ROUTING_RULES: RoutingRules = {
  // Anthropic Claude — native first, then OpenRouter.
  "claude-*": ["native-anthropic", "openrouter"],

  // OpenAI families: Codex subscription first, then direct API, then OpenRouter.
  "gpt-*": ["openai-codex", "openai", "openrouter"],
  "o1-*": ["openai-codex", "openai", "openrouter"],
  "o3-*": ["openai-codex", "openai", "openrouter"],

  // Google Gemini: Antigravity subscription, direct API, OpenRouter.
  //
  // `antigravity` holds the subscription slot that `gemini-codeassist` used to.
  // Google retired Code Assist for individuals (UNSUPPORTED_CLIENT for
  // gemini-cli's OAuth client), so leaving the retired provider at the head of
  // this chain cost a guaranteed-failing round-trip and then silently billed the
  // metered `google` API for a model the user's subscription already covers.
  //
  // Antigravity's served ids carry a reasoning-tier suffix
  // (`gemini-3.6-flash-high`); the transport resolves a bare family name against
  // the account's LIVE served set, so a bare `gemini-3.6-flash` routes correctly
  // here. No token → route() filters the candidate out and `google` takes over.
  "gemini-*": ["antigravity", "google", "openrouter"],

  // xAI Grok: direct API, then OpenRouter (no subscription tier).
  "grok-*": ["x-ai", "openrouter"],

  // Kimi: the subscription endpoint speaks its own wire ids (kimi-for-coding,
  // kimi-for-coding-highspeed, k3, k3-256k) — NOT catalog names like
  // "kimi-k2.7-code". No model is pinned here: buildRoutingChain translates the
  // catalog name to the plan's wire id via `subscriptionPlans[]` +
  // `aggregators[].externalId`, and drops the kimi-coding candidate when the
  // plan doesn't include the model (e.g. kimi-k2.5) so it falls through to the
  // metered Moonshot API rather than being silently answered by a different
  // model. `k3*` needs its own rule: it doesn't match `kimi-*`, and the catalog
  // alias would otherwise send bare `k3` to the paid OpenRouter listing.
  "kimi-*": ["kimi-coding", "kimi", "openrouter"],
  "k3*": ["kimi-coding", "kimi", "openrouter"],

  // MiniMax (matchRoutingRule is case-insensitive, so a single rule covers
  // both `MiniMax-M2.5` and `minimax-m2.5`).
  "minimax-*": ["minimax-coding", "minimax", "openrouter"],

  // GLM: coding plan, direct, OpenRouter.
  "glm-*": ["glm-coding", "glm", "openrouter"],

  // Qwen Plan (Alibaba Model Studio subscription), then OpenRouter.
  // `globMatch` is a literal prefix/suffix split, so the "." is matched
  // literally: this claims the DOTTED Model Studio names (qwen3.7-plus) and
  // deliberately NOT the hyphenated aggregator names (qwen3-coder-next).
  //
  // The plan ALSO serves glm-5.2 and deepseek-v4-*, but their chains are left
  // untouched on purpose. Routing filters by CREDENTIAL availability, not by
  // model availability — putting qwen-cloud in front of "glm-*" would send
  // glm-4.6 to Alibaba on the strength of the plan key alone, earn a
  // `400 Model not exist`, and stop there, because 400 is deliberately
  // non-retryable in fallback-handler.ts. Cross-vendor access to the plan
  // stays explicit: `qc@glm-5.2`.
  "qwen3.*": ["qwen-cloud", "openrouter"],

  // Z.AI native models.
  "z-ai-*": ["z-ai", "openrouter"],

  // DeepSeek: direct API, OpenRouter.
  "deepseek-*": ["deepseek", "openrouter"],

  // Sakana Fugu: subscription first, then token API. NO hardcoded openrouter —
  // we don't claim OpenRouter carries the model; it's reachable explicitly via
  // or@sakana/fugu (catalog-resolved). The bare "fugu" id needs its own exact
  // rule because "fugu-*" only matches hyphenated names.
  fugu: ["sakana-subscription", "sakana"],
  "fugu-*": ["sakana-subscription", "sakana"],

  // OpenCode Zen owns/serves a few model lines exclusively.
  // Pragmatic shim until Firebase aggregators[] coverage closes the gap.
  "*-zen": ["opencode-zen"],

  // Catch-all: try OpenRouter (it covers most things). Users disable with
  // routing["*"] = [] for strict no-fallback mode, or replace with their own
  // chain.
  "*": ["openrouter"],
};

/**
 * Validate that every provider name referenced by a routing rules table exists
 * in `provider-definitions.ts`. Walks each entry, strips the optional
 * `@model` suffix, resolves shortcuts (e.g. `or` → `openrouter`), and looks
 * each canonical provider up.
 *
 * Throws if any rule references a typo provider — dev-time only; the cost is
 * a single sweep at module load and prevents silent no-op rules from shipping
 * to users.
 *
 * Exposed (not just internal) so tests can pass intentionally-broken rule
 * tables to verify the validator's contract.
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
    throw new Error(
      `[claudish] DEFAULT_ROUTING_RULES references unknown providers:\n${lines.join("\n")}`
    );
  }
}

/**
 * Validate the shipped DEFAULT_ROUTING_RULES at module load. Throws on a typo
 * so the bug surfaces in `bun run build` / test runs instead of as a silent
 * no-route at runtime.
 */
export function validateDefaultRoutingRules(): void {
  validateRoutingRulesAgainstProviders(DEFAULT_ROUTING_RULES);
}

// Eager validation at import time.
validateDefaultRoutingRules();
