/**
 * Unified login/logout subcommands for OAuth providers.
 *
 * Usage:
 *   claudish login [provider]   - Interactive selection or direct login
 *   claudish logout [provider]  - Interactive selection or direct logout
 *
 * Replaces the old per-provider flags (--gemini-login, --kimi-login, etc.)
 */

import { select } from "@inquirer/prompts";
import { CodexOAuth } from "./codex-oauth.js";
import { GeminiOAuth } from "./gemini-oauth.js";
import { KimiOAuth } from "./kimi-oauth.js";
import { hasOAuthCredentials } from "./oauth-registry.js";

interface OAuthInstance {
  login(): Promise<void>;
  logout(): Promise<void>;
}

interface OAuthProvider {
  name: string;
  displayName: string;
  prefix: string;
  getInstance: () => OAuthInstance;
  registryKeys: string[];
}

const AUTH_PROVIDERS: OAuthProvider[] = [
  {
    name: "gemini",
    displayName: "Gemini Code Assist",
    prefix: "go@",
    getInstance: () => GeminiOAuth.getInstance(),
    registryKeys: ["google", "gemini-codeassist"],
  },
  {
    name: "kimi",
    displayName: "Kimi / Moonshot AI",
    prefix: "kc@, kimi@",
    getInstance: () => KimiOAuth.getInstance(),
    registryKeys: ["kimi", "kimi-coding"],
  },
  {
    name: "codex",
    displayName: "OpenAI Codex (ChatGPT Plus/Pro)",
    prefix: "cx@",
    getInstance: () => CodexOAuth.getInstance(),
    registryKeys: ["openai-codex"],
  },
];

function getAuthStatus(provider: OAuthProvider): string {
  const hasCredentials = provider.registryKeys.some((k) => hasOAuthCredentials(k));
  return hasCredentials ? "logged in" : "not logged in";
}

async function selectProvider(action: string): Promise<OAuthProvider> {
  const choices = AUTH_PROVIDERS.map((p) => ({
    name: `${p.displayName} (${p.prefix}) - ${getAuthStatus(p)}`,
    value: p,
  }));

  return select({
    message: `Select provider to ${action}:`,
    choices,
  });
}

function findProvider(name: string): OAuthProvider | null {
  const lower = name.toLowerCase();
  return (
    AUTH_PROVIDERS.find(
      (p) =>
        p.name === lower ||
        p.registryKeys.includes(lower) ||
        p.displayName.toLowerCase().includes(lower)
    ) ?? null
  );
}

export async function loginCommand(providerArg?: string): Promise<void> {
  const provider = providerArg ? findProvider(providerArg) : await selectProvider("login");

  if (!provider) {
    console.error(`Unknown OAuth provider: ${providerArg}`);
    console.error(`Available: ${AUTH_PROVIDERS.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  try {
    const oauth = provider.getInstance();
    await oauth.login();
    console.log(`\n✅ ${provider.displayName} OAuth login successful!`);
    console.log(`You can now use: claudish --model ${provider.prefix.split(",")[0].trim()}<model>`);
    process.exit(0);
  } catch (error) {
    console.error(
      `\n❌ ${provider.displayName} OAuth login failed:`,
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

export async function logoutCommand(providerArg?: string): Promise<void> {
  const provider = providerArg ? findProvider(providerArg) : await selectProvider("logout");

  if (!provider) {
    console.error(`Unknown OAuth provider: ${providerArg}`);
    console.error(`Available: ${AUTH_PROVIDERS.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  try {
    const oauth = provider.getInstance();
    await oauth.logout();
    console.log(`✅ ${provider.displayName} OAuth credentials cleared.`);
    process.exit(0);
  } catch (error) {
    console.error(
      `❌ ${provider.displayName} OAuth logout failed:`,
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}
