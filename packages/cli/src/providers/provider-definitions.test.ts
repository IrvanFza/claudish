/**
 * Tests for provider-definitions.ts — single source of truth for provider identity.
 *
 * Run: bun test packages/cli/src/providers/provider-definitions.test.ts
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride } from "../config-override.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import { setConfigFileOverride } from "../profile-config.js";
import { API_KEY_MAP } from "./api-key-map.js";
import {
  BUILTIN_PROVIDERS,
  getApiKeyEnvVars,
  getApiKeyInfo,
  getDisplayName,
  getEffectiveBaseUrl,
  getLegacyPrefixPatterns,
  getNativeModelPatterns,
  getProviderByName,
  getShortcuts,
  getShortestPrefix,
  toRemoteProvider,
} from "./provider-definitions.js";
import { getProviderApiKeyEnv } from "./routing-hints.js";

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe("BUILTIN_PROVIDERS structural integrity", () => {
  // REGRESSION: the Sakana SUBSCRIPTION plan (sc@ / sakana-subscription) bills
  // against a SEPARATE key from the pay-as-you-go API (sakana / SAKANA_API_KEY).
  // Its primary env var is SAKANA_SUBSCRIPTION_API_KEY (named after Sakana's own
  // "subscription" term, not "coding" — the plan is general-purpose). It must
  // NOT alias back to SAKANA_API_KEY — doing so made sc@ silently use the PAYG
  // key and bill prepaid credits ("Prepaid credit balance is exhausted") despite
  // an active subscription.
  test("sakana-subscription uses its own key, not the pay-as-you-go SAKANA_API_KEY", () => {
    const sub = BUILTIN_PROVIDERS.find((d) => d.name === "sakana-subscription");
    expect(sub).toBeDefined();
    expect(sub!.apiKeyEnvVar).toBe("SAKANA_SUBSCRIPTION_API_KEY");
    // Old name kept only as a back-compat alias.
    expect(sub!.apiKeyAliases ?? []).toContain("SAKANA_CODING_API_KEY");
    // The dangerous PAYG alias must NOT be present.
    expect(sub!.apiKeyAliases ?? []).not.toContain("SAKANA_API_KEY");
    // The old provider name is fully gone.
    expect(BUILTIN_PROVIDERS.find((d) => d.name === "sakana-coding")).toBeUndefined();
    // Sibling subscription plans also keep their key isolated from PAYG.
    const kimiCoding = BUILTIN_PROVIDERS.find((d) => d.name === "kimi-coding");
    expect(kimiCoding!.apiKeyAliases ?? []).not.toContain("MOONSHOT_API_KEY");
  });

  test("qwen-cloud keeps Qwen Plan credentials isolated and uses Anthropic transport", () => {
    const plan = BUILTIN_PROVIDERS.find((d) => d.name === "qwen-cloud");
    expect(plan).toBeDefined();
    expect(plan!.apiKeyEnvVar).toBe("QWEN_CLOUD_PLAN_API_KEY");
    expect(plan!.apiKeyAliases).toBeUndefined();
    expect(plan!.transport).toBe("anthropic");
    expect(plan!.authScheme).toBe("bearer");
  });

  test("qwen-cloud composes message and discovery URLs on the same origin", () => {
    const plan = BUILTIN_PROVIDERS.find((d) => d.name === "qwen-cloud")!;
    const messagesUrl = plan.baseUrl + plan.apiPath;
    const modelsUrl = plan.baseUrl + plan.modelDiscovery!.path;

    expect(messagesUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(modelsUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models"
    );
    expect(new URL(messagesUrl).origin).toBe(new URL(modelsUrl).origin);
  });

  test("qwen-payg keeps metered credentials isolated and uses Anthropic transport", () => {
    const payg = BUILTIN_PROVIDERS.find((d) => d.name === "qwen-payg");
    expect(payg).toBeDefined();
    expect(payg!.apiKeyEnvVar).toBe("DASHSCOPE_API_KEY");
    expect(payg!.apiKeyAliases).toEqual(["QWEN_API_KEY"]);
    expect(payg!.apiKeyAliases).not.toContain("QWEN_CLOUD_PLAN_API_KEY");
    expect(payg!.transport).toBe("anthropic");
    expect(payg!.authScheme).toBe("bearer");
    expect(payg!.nativeModelPatterns).toBeUndefined();
  });

  test("qwen-payg composes message and discovery URLs on the PAYG origin", () => {
    const payg = BUILTIN_PROVIDERS.find((d) => d.name === "qwen-payg")!;
    const messagesUrl = payg.baseUrl + payg.apiPath;
    const modelsUrl = payg.baseUrl + payg.modelDiscovery!.path;

    expect(messagesUrl).toBe("https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages");
    expect(modelsUrl).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");
    expect(new URL(messagesUrl).origin).toBe(new URL(modelsUrl).origin);
  });

  test("qwen-payg API key maps agree with its provider definition", () => {
    const payg = BUILTIN_PROVIDERS.find((d) => d.name === "qwen-payg")!;

    expect(API_KEY_MAP[payg.name]).toEqual({
      envVar: payg.apiKeyEnvVar,
      aliases: payg.apiKeyAliases,
    });
    expect(getProviderApiKeyEnv(payg.name)).toBe(payg.apiKeyEnvVar);
  });

  test("grok-subscription keeps refreshable auth out of generic API-key caching", () => {
    const subscription = getProviderByName("grok-subscription")!;

    // A generic env-var credential would be extracted and cached past the OIDC token's lifetime.
    expect(subscription.apiKeyEnvVar).toBe("");
  });

  test("OpenCode Zen requires a real key instead of the retired public bearer", () => {
    const zen = getProviderByName("opencode-zen")!;

    expect(zen.publicKeyFallback).toBeUndefined();
    expect(zen.apiKeyEnvVar).toBe("OPENCODE_API_KEY");
  });

  test("Qwen's metered row follows the API naming convention", () => {
    expect(getProviderByName("qwen-payg")?.displayName).toBe("Qwen API");
  });

  test("grok-subscription does not compete with x-ai for native Grok patterns", () => {
    const subscription = getProviderByName("grok-subscription")!;
    const grokPatternOwner = getNativeModelPatterns().find((entry) =>
      entry.pattern.test("grok-4.6")
    );

    // Native patterns are first-wins; the metered x-ai definition remains their sole owner.
    expect(subscription.nativeModelPatterns).toBeUndefined();
    expect(grokPatternOwner?.provider).toBe("x-ai");
  });

  test("Grok subscription billing stays distinct from metered x-ai billing", () => {
    // Flat-rate Grok access must render SUB, while XAI_API_KEY usage remains per-token metered.
    expect(isSubscriptionProvider("grok-subscription")).toBe(true);
    expect(isSubscriptionProvider("x-ai")).toBe(false);
  });

  test("every builtin explicitly defines how its handler is created", () => {
    for (const provider of BUILTIN_PROVIDERS) {
      const handler = provider.createHandler;

      // This is the merged-table invariant: an omitted handler used to route silently to OpenRouter.
      expect(handler).toBeDefined();
      expect(
        typeof handler === "function" ||
          (typeof handler === "object" && handler !== null && handler.kind === "none")
      ).toBe(true);
    }
  });

  test("every handler-less builtin documents a supported reason", () => {
    const supportedReasons = new Set([
      "renamed-at-runtime",
      "dedicated-handler",
      "local",
      "virtual",
      "unimplemented",
    ]);

    for (const provider of BUILTIN_PROVIDERS) {
      const handler = provider.createHandler;
      if (typeof handler === "function") continue;

      // A reason and note distinguish an intentional alternate path from a forgotten handler.
      expect(supportedReasons.has(handler.reason)).toBe(true);
      expect(handler.note.trim()).not.toBe("");
    }
  });

  test("only the expected builtins use the no-handler sentinel", () => {
    const handlerlessProviders = BUILTIN_PROVIDERS.filter(
      (provider) => typeof provider.createHandler !== "function"
    )
      .map((provider) => provider.name)
      .sort();

    // Google is renamed to gemini at runtime but owns geminiHandler; a naive merge loses it here.
    expect(handlerlessProviders).not.toContain("google");
    expect(handlerlessProviders).toEqual([
      "lmstudio",
      "mlx",
      "native-anthropic",
      "ollama",
      "openrouter",
      "poe",
      "vllm",
    ]);
  });

  test("recent subscription providers have real handler factories", () => {
    for (const providerName of ["grok-subscription", "antigravity"]) {
      const provider = getProviderByName(providerName);

      // These recent additions are regression guards for the table-drift failure this merge removes.
      expect(provider).toBeDefined();
      expect(typeof provider?.createHandler).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// getShortcuts
// ---------------------------------------------------------------------------

describe("getShortcuts", () => {
  const shortcuts = getShortcuts();

  test("maps 'g' to 'google'", () => {
    expect(shortcuts.g).toBe("google");
  });

  test("maps 'gemini' to 'google'", () => {
    expect(shortcuts.gemini).toBe("google");
  });

  test("maps 'oai' to 'openai'", () => {
    expect(shortcuts.oai).toBe("openai");
  });

  test("maps 'or' to 'openrouter'", () => {
    expect(shortcuts.or).toBe("openrouter");
  });

  test("maps 'mm' to 'minimax'", () => {
    expect(shortcuts.mm).toBe("minimax");
  });

  test("maps 'kimi' to 'kimi'", () => {
    expect(shortcuts.kimi).toBe("kimi");
  });

  test("maps 'glm' to 'glm'", () => {
    expect(shortcuts.glm).toBe("glm");
  });

  test("maps local provider shortcuts", () => {
    expect(shortcuts.ollama).toBe("ollama");
    expect(shortcuts.lms).toBe("lmstudio");
    expect(shortcuts.vllm).toBe("vllm");
    expect(shortcuts.mlx).toBe("mlx");
  });

  test("maps 'poe' to 'poe'", () => {
    expect(shortcuts.poe).toBe("poe");
  });

  test("maps 'litellm' to 'litellm'", () => {
    expect(shortcuts.litellm).toBe("litellm");
    expect(shortcuts.ll).toBe("litellm");
  });
});

// ---------------------------------------------------------------------------
// getLegacyPrefixPatterns
// ---------------------------------------------------------------------------

describe("getLegacyPrefixPatterns", () => {
  const patterns = getLegacyPrefixPatterns();

  test("includes 'g/' for google", () => {
    const gPattern = patterns.find((p) => p.prefix === "g/");
    expect(gPattern).toBeDefined();
    expect(gPattern!.provider).toBe("google");
    expect(gPattern!.stripPrefix).toBe(true);
  });

  test("includes local provider prefixes", () => {
    const ollamaSlash = patterns.find((p) => p.prefix === "ollama/");
    expect(ollamaSlash).toBeDefined();
    expect(ollamaSlash!.provider).toBe("ollama");

    const ollamaColon = patterns.find((p) => p.prefix === "ollama:");
    expect(ollamaColon).toBeDefined();
    expect(ollamaColon!.provider).toBe("ollama");
  });
});

// ---------------------------------------------------------------------------
// getNativeModelPatterns
// ---------------------------------------------------------------------------

describe("getNativeModelPatterns", () => {
  const patterns = getNativeModelPatterns();

  test("gemini-* matches google", () => {
    const match = patterns.find((p) => p.pattern.test("gemini-2.0-flash"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("google");
  });

  test("gpt-* matches openai", () => {
    const match = patterns.find((p) => p.pattern.test("gpt-4o"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("openai");
  });

  test("kimi-for-coding matches kimi-coding (before general kimi-*)", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-for-coding"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi-coding");
  });

  test("kimi-k2 matches kimi", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-k2"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi");
  });

  test("claude-3-opus matches native-anthropic", () => {
    const match = patterns.find((p) => p.pattern.test("claude-3-opus-20240229"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("native-anthropic");
  });

  test("qwen matches qwen", () => {
    const match = patterns.find((p) => p.pattern.test("qwen3-coder-next"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("qwen");
  });
});

// ---------------------------------------------------------------------------
// getProviderByName
// ---------------------------------------------------------------------------

describe("getProviderByName", () => {
  test("finds google", () => {
    const def = getProviderByName("google");
    expect(def).toBeDefined();
    expect(def!.displayName).toBe("Gemini");
  });

  test("returns undefined for unknown provider", () => {
    expect(getProviderByName("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getApiKeyInfo
// ---------------------------------------------------------------------------

describe("getApiKeyInfo", () => {
  test("returns correct info for google", () => {
    const info = getApiKeyInfo("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
    expect(info!.url).toContain("aistudio.google.com");
  });

  test("returns aliases for kimi", () => {
    const info = getApiKeyInfo("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns oauthFallback for kimi-coding", () => {
    const info = getApiKeyInfo("kimi-coding");
    expect(info).toBeDefined();
    expect(info!.oauthFallback).toBe("kimi-oauth.json");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyInfo("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDisplayName
// ---------------------------------------------------------------------------

describe("getDisplayName", () => {
  test("capitalizes unknown provider names", () => {
    expect(getDisplayName("unknown")).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// getEffectiveBaseUrl
// ---------------------------------------------------------------------------

describe("getEffectiveBaseUrl", () => {
  test("returns base URL for provider without env overrides", () => {
    const def = getProviderByName("openrouter")!;
    expect(getEffectiveBaseUrl(def)).toBe("https://openrouter.ai");
  });

  test("QWEN_CLOUD_PLAN_BASE_URL overrides the qwen-cloud default host", () => {
    const envVar = "QWEN_CLOUD_PLAN_BASE_URL";
    const previousEnv = process.env[envVar];
    const previousConfigOverride = getConfigFileOverride();
    const missingConfig = join(
      tmpdir(),
      `claudish-qwen-cloud-provider-definitions-${process.pid}-missing.json`
    );

    setConfigFileOverride(missingConfig);
    process.env[envVar] = "https://qwen-cloud.test.invalid";
    try {
      const def = getProviderByName("qwen-cloud")!;
      expect(def.baseUrlEnvVars).toEqual([envVar]);
      expect(getEffectiveBaseUrl(def)).toBe("https://qwen-cloud.test.invalid");
    } finally {
      setConfigFileOverride(previousConfigOverride);
      if (previousEnv === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previousEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// isLocalTransport / isDirectApiProvider
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// toRemoteProvider
// ---------------------------------------------------------------------------

describe("toRemoteProvider", () => {
  test("google maps to 'gemini' for RemoteProvider.name (backwards compat)", () => {
    const def = getProviderByName("google")!;
    const rp = toRemoteProvider(def);
    expect(rp.name).toBe("gemini");
  });

  test("preserves custom headers", () => {
    const def = getProviderByName("openrouter")!;
    const rp = toRemoteProvider(def);
    expect(rp.headers).toBeDefined();
    expect(rp.headers!["HTTP-Referer"]).toBe("https://claudish.com");
  });

  test("preserves authScheme", () => {
    const def = getProviderByName("minimax")!;
    const rp = toRemoteProvider(def);
    expect(rp.authScheme).toBe("bearer");
  });
});

// ---------------------------------------------------------------------------
// getShortestPrefix / getApiKeyEnvVars
// ---------------------------------------------------------------------------

describe("getShortestPrefix", () => {
  test("falls back to provider name for unknown", () => {
    expect(getShortestPrefix("unknown")).toBe("unknown");
  });
});

describe("getApiKeyEnvVars", () => {
  test("returns env var info for known providers", () => {
    const info = getApiKeyEnvVars("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
  });

  test("returns aliases when available", () => {
    const info = getApiKeyEnvVars("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyEnvVars("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isProviderAvailable / isProviderAvailableByName were DELETED in the
// async-credential-layer refactor — provider readiness now lives in the
// credential authority (auth/credentials/authority.ts → isAvailable). The
// readiness cases formerly tested here (local always-available, publicKeyFallback,
// primary key, alias key, no-key → unavailable) are covered by the authority's
// equivalence matrix in auth/credentials/equivalence.test.ts.

describe("MiniMax credential silo endpoints", () => {
  test("keeps PAYG and coding providers on their matching hosts", () => {
    const payg = getProviderByName("minimax")!;
    const coding = getProviderByName("minimax-coding")!;

    expect(payg.baseUrl).toBe("https://api.minimaxi.com");
    expect(coding.baseUrl).toBe("https://api.minimax.io");
    // This is the actual regression guard: identical URLs sent PAYG keys to the coding host.
    expect(payg.baseUrl).not.toBe(coding.baseUrl);
    expect(payg.apiKeyUrl).toContain("minimaxi.com");
    expect(payg.baseUrl).toContain("minimaxi.com");
  });
});
