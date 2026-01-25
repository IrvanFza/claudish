/**
 * Tests for Provider Resolver - Centralized API Key Validation
 *
 * These tests verify the provider resolution logic including:
 * - Local provider detection (ollama, lmstudio, etc.)
 * - Direct API provider routing (g/, oai/, etc.)
 * - OpenRouter routing (google/, openai/, or/ and default)
 * - Native Anthropic detection
 * - Fallback chain (provider → OpenRouter → Vertex)
 * - API key availability detection
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveModelProvider,
  validateApiKeysForModels,
  getMissingKeyResolutions,
  getMissingKeyError,
  getMissingKeysError,
  requiresOpenRouterKey,
  isLocalModel,
} from "./provider-resolver.js";

// Helper to save and restore env vars
function withEnv(envVars: Record<string, string | undefined>, fn: () => void) {
  const originalEnv: Record<string, string | undefined> = {};

  // Save original values
  for (const key of Object.keys(envVars)) {
    originalEnv[key] = process.env[key];
  }

  // Set new values
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    // Restore original values
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("resolveModelProvider", () => {
  // Clear relevant env vars before each test
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VERTEX_API_KEY;
    delete process.env.VERTEX_PROJECT;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
  });

  describe("local providers", () => {
    test("ollama/ prefix is detected as local", () => {
      const result = resolveModelProvider("ollama/llama3.2");
      expect(result.category).toBe("local");
      expect(result.requiredApiKeyEnvVar).toBeNull();
      expect(result.apiKeyAvailable).toBe(true);
    });

    test("lmstudio/ prefix is detected as local", () => {
      const result = resolveModelProvider("lmstudio/qwen2.5");
      expect(result.category).toBe("local");
      expect(result.requiredApiKeyEnvVar).toBeNull();
    });

    test("http:// URL is detected as local", () => {
      const result = resolveModelProvider("http://localhost:11434/llama3");
      expect(result.category).toBe("local");
      expect(result.providerName).toBe("Custom URL");
    });

    test("vllm/ prefix is detected as local", () => {
      const result = resolveModelProvider("vllm/mistral-7b");
      expect(result.category).toBe("local");
    });

    test("mlx/ prefix is detected as local", () => {
      const result = resolveModelProvider("mlx/phi-3");
      expect(result.category).toBe("local");
    });
  });

  describe("direct API providers", () => {
    test("g/ prefix routes to Gemini with GEMINI_API_KEY", () => {
      withEnv({ GEMINI_API_KEY: "test-key" }, () => {
        const result = resolveModelProvider("g/gemini-2.0-flash");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("Gemini");
        expect(result.modelName).toBe("gemini-2.0-flash");
        expect(result.requiredApiKeyEnvVar).toBe("GEMINI_API_KEY");
        expect(result.apiKeyAvailable).toBe(true);
      });
    });

    test("gemini/ prefix routes to Gemini", () => {
      withEnv({ GEMINI_API_KEY: "test-key" }, () => {
        const result = resolveModelProvider("gemini/gemini-2.5-pro");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("Gemini");
      });
    });

    test("oai/ prefix routes to OpenAI with OPENAI_API_KEY", () => {
      withEnv({ OPENAI_API_KEY: "sk-test" }, () => {
        const result = resolveModelProvider("oai/gpt-4o");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("OpenAI");
        expect(result.modelName).toBe("gpt-4o");
        expect(result.requiredApiKeyEnvVar).toBe("OPENAI_API_KEY");
        expect(result.apiKeyAvailable).toBe(true);
      });
    });

    test("zen/ prefix routes to OpenCode Zen (no key required)", () => {
      const result = resolveModelProvider("zen/grok-code");
      expect(result.category).toBe("direct-api");
      expect(result.providerName).toBe("OpenCode Zen");
      expect(result.apiKeyAvailable).toBe(true); // Free tier
    });

    test("or/ prefix explicitly routes to OpenRouter", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider("or/google/gemini-2.0-flash");
        expect(result.category).toBe("openrouter");
        expect(result.providerName).toBe("OpenRouter");
      });
    });
  });

  describe("OpenRouter routing - google/ and openai/ prefixes", () => {
    test("google/ prefix routes to OpenRouter (not direct Gemini)", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider("google/gemini-2.5-pro");
        expect(result.category).toBe("openrouter");
        expect(result.providerName).toBe("OpenRouter");
        expect(result.requiredApiKeyEnvVar).toBe("OPENROUTER_API_KEY");
      });
    });

    test("openai/ prefix routes to OpenRouter (not direct OpenAI)", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider("openai/gpt-4o");
        expect(result.category).toBe("openrouter");
        expect(result.providerName).toBe("OpenRouter");
      });
    });

    test("anthropic/ prefix routes to OpenRouter", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider("anthropic/claude-3.5-sonnet");
        expect(result.category).toBe("openrouter");
      });
    });
  });

  describe("native Anthropic", () => {
    test("model without / is detected as native Anthropic", () => {
      const result = resolveModelProvider("claude-3-opus-20240229");
      expect(result.category).toBe("native-anthropic");
      expect(result.providerName).toBe("Anthropic (Native)");
      expect(result.requiredApiKeyEnvVar).toBeNull();
      expect(result.apiKeyAvailable).toBe(true);
    });

    test("claude-sonnet-4-20250514 is native Anthropic", () => {
      const result = resolveModelProvider("claude-sonnet-4-20250514");
      expect(result.category).toBe("native-anthropic");
    });
  });

  describe("fallback chain", () => {
    test("g/ without GEMINI_API_KEY falls back to OpenRouter if available", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider("g/gemini-2.0-flash");
        expect(result.category).toBe("openrouter");
        expect(result.providerName).toBe("OpenRouter (fallback)");
        expect(result.apiKeyAvailable).toBe(true);
      });
    });

    test("g/ without any keys reports missing GEMINI_API_KEY", () => {
      const result = resolveModelProvider("g/gemini-2.0-flash");
      expect(result.category).toBe("direct-api");
      expect(result.apiKeyAvailable).toBe(false);
      expect(result.requiredApiKeyEnvVar).toBe("GEMINI_API_KEY");
    });

    test("g/ falls back to Vertex if VERTEX_API_KEY available", () => {
      withEnv({ VERTEX_API_KEY: "vertex-key" }, () => {
        const result = resolveModelProvider("g/gemini-2.0-flash");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("Vertex AI (fallback)");
        expect(result.apiKeyAvailable).toBe(true);
      });
    });

    test("g/ falls back to Vertex if VERTEX_PROJECT available (OAuth mode)", () => {
      withEnv({ VERTEX_PROJECT: "my-project" }, () => {
        const result = resolveModelProvider("g/gemini-2.0-flash");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("Vertex AI (fallback)");
      });
    });

    test("prefers provider key over OpenRouter when both available", () => {
      withEnv({ GEMINI_API_KEY: "gem-key", OPENROUTER_API_KEY: "or-key" }, () => {
        const result = resolveModelProvider("g/gemini-2.0-flash");
        expect(result.category).toBe("direct-api");
        expect(result.providerName).toBe("Gemini");
      });
    });
  });

  describe("API key aliases", () => {
    test("KIMI_API_KEY works as alias for MOONSHOT_API_KEY", () => {
      withEnv({ KIMI_API_KEY: "kimi-key" }, () => {
        const result = resolveModelProvider("kimi/moonshot-v1-32k");
        expect(result.category).toBe("direct-api");
        expect(result.apiKeyAvailable).toBe(true);
      });
    });
  });

  describe("undefined model", () => {
    test("undefined model defaults to OpenRouter", () => {
      withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
        const result = resolveModelProvider(undefined);
        expect(result.category).toBe("openrouter");
        expect(result.fullModelId).toBe("");
      });
    });
  });
});

describe("isLocalModel", () => {
  test("returns true for ollama model", () => {
    expect(isLocalModel("ollama/llama3")).toBe(true);
  });

  test("returns true for lmstudio model", () => {
    expect(isLocalModel("lmstudio/qwen")).toBe(true);
  });

  test("returns true for http URL", () => {
    expect(isLocalModel("http://localhost:8080/model")).toBe(true);
  });

  test("returns false for OpenRouter model", () => {
    expect(isLocalModel("google/gemini-2.0")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isLocalModel(undefined)).toBe(false);
  });
});

describe("requiresOpenRouterKey", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  test("returns true for google/ prefix", () => {
    expect(requiresOpenRouterKey("google/gemini-2.0")).toBe(true);
  });

  test("returns false for local model", () => {
    expect(requiresOpenRouterKey("ollama/llama3")).toBe(false);
  });

  test("returns false for native Anthropic", () => {
    expect(requiresOpenRouterKey("claude-3-opus")).toBe(false);
  });
});

describe("validateApiKeysForModels", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  test("filters out undefined models", () => {
    const results = validateApiKeysForModels([undefined, "ollama/llama3", undefined]);
    expect(results.length).toBe(1);
    expect(results[0].category).toBe("local");
  });

  test("validates multiple models", () => {
    withEnv({ GEMINI_API_KEY: "key" }, () => {
      const results = validateApiKeysForModels(["g/gemini-2.0", "ollama/llama3"]);
      expect(results.length).toBe(2);
      expect(results[0].category).toBe("direct-api");
      expect(results[1].category).toBe("local");
    });
  });
});

describe("getMissingKeyResolutions", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  test("returns only resolutions with missing keys", () => {
    const resolutions = validateApiKeysForModels(["google/gemini", "ollama/llama3"]);
    const missing = getMissingKeyResolutions(resolutions);
    expect(missing.length).toBe(1);
    expect(missing[0].requiredApiKeyEnvVar).toBe("OPENROUTER_API_KEY");
  });

  test("returns empty array when all keys available", () => {
    withEnv({ OPENROUTER_API_KEY: "key" }, () => {
      const resolutions = validateApiKeysForModels(["google/gemini", "ollama/llama3"]);
      const missing = getMissingKeyResolutions(resolutions);
      expect(missing.length).toBe(0);
    });
  });
});

describe("getMissingKeyError", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("generates error message for missing OpenRouter key", () => {
    const resolution = resolveModelProvider("google/gemini-2.0-flash");
    const error = getMissingKeyError(resolution);
    expect(error).toContain("OPENROUTER_API_KEY");
    expect(error).toContain("google/gemini-2.0-flash");
    expect(error).toContain("https://openrouter.ai/keys");
  });

  test("includes tip for google/ prefix", () => {
    const resolution = resolveModelProvider("google/gemini-2.0-flash");
    const error = getMissingKeyError(resolution);
    expect(error).toContain("g/");
    expect(error).toContain("gemini/");
  });

  test("includes tip for openai/ prefix", () => {
    const resolution = resolveModelProvider("openai/gpt-4o");
    const error = getMissingKeyError(resolution);
    expect(error).toContain("oai/");
  });

  test("returns empty string when key is available", () => {
    withEnv({ OPENROUTER_API_KEY: "key" }, () => {
      const resolution = resolveModelProvider("google/gemini-2.0-flash");
      const error = getMissingKeyError(resolution);
      expect(error).toBe("");
    });
  });
});

describe("getMissingKeysError", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  test("handles single missing key", () => {
    const resolutions = validateApiKeysForModels(["google/gemini"]);
    const error = getMissingKeysError(resolutions);
    expect(error).toContain("OPENROUTER_API_KEY");
  });

  test("groups duplicate env vars", () => {
    const resolutions = validateApiKeysForModels(["google/gemini", "openai/gpt-4o"]);
    const error = getMissingKeysError(resolutions);
    // Both require OPENROUTER_API_KEY - should be grouped (single error message)
    expect(error).toContain("OPENROUTER_API_KEY");
    // Single key message format (not "Multiple API keys" since same key)
    expect(error).toContain("export OPENROUTER_API_KEY");
  });

  test("returns empty string when no missing keys", () => {
    withEnv({ OPENROUTER_API_KEY: "key" }, () => {
      const resolutions = validateApiKeysForModels(["google/gemini"]);
      const error = getMissingKeysError(resolutions);
      expect(error).toBe("");
    });
  });
});
