import { describe, expect, test } from "bun:test";
import { redactSecrets, sanitizeForReport } from "./redact.js";

const MASK = "***REDACTED***";

describe("redactSecrets", () => {
  describe("known credential shapes", () => {
    const credentials = [
      ["OpenAI/OpenRouter", "sk-or-v1-abcdef0123456789abcdef0123456789abcdef01"],
      ["Anthropic", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      ["Google", "AIzaSyD-1234567890abcdefghijklmnopqrs"],
      ["xAI", "xai-abcdefghijklmnopqrstuvwxyz012345"],
      ["GitHub personal access token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["GitHub OAuth token", "gho_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["GitHub server token", "ghs_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["GitHub user token", "ghu_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["GitHub refresh token", "ghr_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["AWS access key ID", "AKIAIOSFODNN7EXAMPLE"],
      ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmU"],
      ["Zhipu/GLM", "0123456789abcdef0123456789abcdef.AbCdEf0123456789"],
    ] as const;

    for (const [name, secret] of credentials) {
      test(`masks a ${name} credential`, () => {
        const output = redactSecrets(`credential=${secret}`);

        expect(output).toContain(MASK);
        expect(output).not.toContain(secret);
      });
    }
  });

  describe("named credential assignments", () => {
    const assignments = [
      [
        "NAME=value",
        "ANTHROPIC_AUTH_TOKEN=fake-anthropic-auth-token-value",
        "ANTHROPIC_AUTH_TOKEN",
        "fake-anthropic-auth-token-value",
      ],
      [
        "NAME: value",
        "GEMINI_CLIENT_SECRET: fake-gemini-client-secret-value",
        "GEMINI_CLIENT_SECRET",
        "fake-gemini-client-secret-value",
      ],
      [
        "JSON assignment",
        '"CUSTOM_OPVLLM_KEY": "fake-opvllm-key-value"',
        "CUSTOM_OPVLLM_KEY",
        "fake-opvllm-key-value",
      ],
      [
        "export NAME='value'",
        "export OP_SERVICE_ACCOUNT_TOKEN='fake-service-account-token-value'",
        "OP_SERVICE_ACCOUNT_TOKEN",
        "fake-service-account-token-value",
      ],
      [
        "_PASSWORD assignment",
        "DATABASE_PASSWORD=fake-database-password-value",
        "DATABASE_PASSWORD",
        "fake-database-password-value",
      ],
    ] as const;

    for (const [syntax, input, variableName, secret] of assignments) {
      test(`masks ${syntax} while preserving the variable name`, () => {
        const output = redactSecrets(input);

        expect(output).toContain(variableName);
        expect(output).toContain(MASK);
        expect(output).not.toContain(secret);
      });
    }
  });

  describe("authorization schemes", () => {
    const headers = [
      ["Bearer", "fake-bearer-token-0123456789"],
      ["Basic", "ZmFrZXVzZXI6ZmFrZXBhc3M="],
      ["Token", "fake-token-scheme-0123456789"],
    ] as const;

    for (const [scheme, token] of headers) {
      test(`preserves ${scheme} and masks its token`, () => {
        const output = redactSecrets(`Authorization: ${scheme} ${token}`);

        expect(output).toContain(`${scheme} ${MASK}`);
        expect(output).not.toContain(token);
      });
    }
  });

  describe("instructional placeholders", () => {
    const placeholders = [
      "your-key-here",
      "your-api-key",
      "<your-key>",
      "...",
      "xxx",
      "${SOME_VAR}",
    ] as const;

    for (const placeholder of placeholders) {
      test(`keeps ${placeholder} unchanged`, () => {
        const input = `EXAMPLE_API_KEY=${placeholder}`;

        expect(redactSecrets(input)).toBe(input);
      });
    }

    test("keeps the captured GLM/Zhipu credential help actionable", () => {
      const helpText = `Error: GLM/Zhipu API Key is required for model "glm-5-turbo"
Set it with:
  export ZHIPU_API_KEY='your-key-here'`;

      const output = redactSecrets(helpText);

      expect(output).toContain("your-key-here");
      expect(output).toBe(helpText);
    });
  });

  test("does not redact legitimate high-entropy or pointer-like content", () => {
    const inputs = [
      "9f2c1a4b8e7d6c5a4b3f2e1d0c9b8a7f6e5d4c3b",
      "anthropic/claude-sonnet-4-5-20250929",
      "This is a plain sentence with ordinary diagnostic information.",
      '{"model":"claude-sonnet","stream":true,"max_tokens":1024}',
      "op://Vault/Item/field",
    ];

    for (const input of inputs) {
      expect(redactSecrets(input)).toBe(input);
    }
  });

  test("returns an empty string for nullish and empty input", () => {
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets(null)).toBe("");
    expect(redactSecrets("")).toBe("");
  });

  test("is idempotent", () => {
    const input = "ANTHROPIC_AUTH_TOKEN=fake-auth-token-value Bearer fake-bearer-token-0123456789";
    const redactedOnce = redactSecrets(input);

    expect(redactSecrets(redactedOnce)).toBe(redactedOnce);
  });
});

describe("redaction levels", () => {
  const personalData = "Log: /Users/jack/project belongs to jack@example.com";

  test("redactSecrets keeps local paths and email addresses", () => {
    expect(redactSecrets(personalData)).toBe(personalData);
  });

  test("sanitizeForReport removes paths and email addresses", () => {
    const output = sanitizeForReport(personalData);

    expect(output).not.toContain("/Users/jack");
    expect(output).not.toContain("jack@example.com");
  });

  test("sanitizeForReport also masks credentials", () => {
    const secret = "sk-or-v1-abcdef0123456789abcdef0123456789abcdef01";
    const output = sanitizeForReport(`/Users/jack/project jack@example.com credential=${secret}`);

    expect(output).toContain(MASK);
    expect(output).not.toContain(secret);
  });

  test("sanitizeForReport returns an empty string for nullish and empty input", () => {
    expect(sanitizeForReport(undefined)).toBe("");
    expect(sanitizeForReport(null)).toBe("");
    expect(sanitizeForReport("")).toBe("");
  });
});
