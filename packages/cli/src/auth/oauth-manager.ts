/**
 * OAuthManager — shared base class for all OAuth providers.
 *
 * Handles:
 * - Credential file I/O with 0600 permissions
 * - Token refresh with promise-based deduplication
 * - Token validity checking with configurable margin
 * - PKCE code verifier/challenge generation
 * - Cross-platform browser opening
 * - ~/.claudish directory management
 */

import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execAsync = promisify(exec);

/** Minimum credential shape every provider must store. */
export interface BaseCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp (ms)
}

/**
 * Abstract base class for OAuth providers.
 *
 * Subclasses must implement:
 * - `credentialFile` — filename inside ~/.claudish/
 * - `providerName` — human-readable name for log/error messages
 * - `doRefreshToken()` — provider-specific token refresh logic
 * - `validateCredentials(data)` — check that loaded JSON has required fields
 */
export abstract class OAuthManager<T extends BaseCredentials = BaseCredentials> {
  protected credentials: T | null = null;
  private refreshPromise: Promise<string> | null = null;
  protected tokenRefreshMargin = 5 * 60 * 1000; // 5 minutes

  /** Filename inside ~/.claudish/ (e.g. "gemini-oauth.json") */
  protected abstract readonly credentialFile: string;
  /** Human-readable provider name for logs/errors (e.g. "GeminiOAuth") */
  protected abstract readonly providerName: string;
  /** CLI login command hint (e.g. "claudish login gemini") */
  protected abstract readonly loginHint: string;

  /** Provider-specific token refresh. Must return the new access_token. */
  protected abstract doRefreshToken(): Promise<string>;

  /** Validate that parsed JSON has all required fields for this provider's credential type. */
  protected abstract validateCredentials(data: unknown): data is T;

  // ── Directory & Paths ──────────────────────────────────────────────────

  protected static ensureClaudishDir(): string {
    const dir = join(homedir(), ".claudish");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  protected getCredentialsPath(): string {
    return join(homedir(), ".claudish", this.credentialFile);
  }

  // ── Credential File I/O ────────────────────────────────────────────────

  protected loadCredentials(): T | null {
    const credPath = this.getCredentialsPath();
    if (!existsSync(credPath)) return null;

    try {
      const data = JSON.parse(readFileSync(credPath, "utf-8"));
      if (!this.validateCredentials(data)) {
        log(`[${this.providerName}] Invalid credentials file structure`);
        return null;
      }
      log(`[${this.providerName}] Loaded credentials from file`);
      return data;
    } catch (e: any) {
      log(`[${this.providerName}] Failed to load credentials: ${e.message}`);
      return null;
    }
  }

  protected saveCredentials(credentials: T): void {
    OAuthManager.ensureClaudishDir();
    const credPath = this.getCredentialsPath();
    const fd = openSync(credPath, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(credentials, null, 2), 0, "utf-8");
    } finally {
      closeSync(fd);
    }
    log(`[${this.providerName}] Credentials saved to ${credPath}`);
  }

  protected deleteCredentials(): void {
    const credPath = this.getCredentialsPath();
    if (existsSync(credPath)) {
      unlinkSync(credPath);
      log(`[${this.providerName}] Credentials deleted`);
    }
  }

  // ── Token Lifecycle ────────────────────────────────────────────────────

  hasCredentials(): boolean {
    return this.credentials !== null && !!this.credentials.refresh_token;
  }

  async getAccessToken(): Promise<string> {
    if (this.refreshPromise) {
      log(`[${this.providerName}] Waiting for in-progress refresh`);
      return this.refreshPromise;
    }

    if (!this.credentials) {
      throw new Error(
        `No ${this.providerName} credentials found. Please run \`${this.loginHint}\` first.`
      );
    }

    if (this.isTokenValid()) {
      return this.credentials.access_token;
    }

    this.refreshPromise = this.doRefreshToken().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async refreshToken(): Promise<void> {
    if (!this.credentials) {
      throw new Error(
        `No ${this.providerName} credentials found. Please run \`${this.loginHint}\` first.`
      );
    }
    await this.doRefreshToken();
  }

  protected isTokenValid(): boolean {
    if (!this.credentials) return false;
    return Date.now() < this.credentials.expires_at - this.tokenRefreshMargin;
  }

  // ── PKCE Helpers ───────────────────────────────────────────────────────

  protected generateCodeVerifier(): string {
    return randomBytes(64).toString("base64url");
  }

  protected generateCodeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
  }

  // ── Browser ────────────────────────────────────────────────────────────

  protected async openBrowser(url: string, message?: string): Promise<void> {
    try {
      if (process.platform === "darwin") {
        await execAsync(`open "${url}"`);
      } else if (process.platform === "win32") {
        await execAsync(`start "${url}"`);
      } else {
        await execAsync(`xdg-open "${url}"`);
      }

      if (message !== undefined) {
        console.log(message);
      } else {
        console.log("\nOpening browser for authentication...");
        console.log(`If the browser doesn't open, visit this URL:\n${url}\n`);
      }
    } catch {
      console.log("\nPlease open this URL in your browser to authenticate:");
      console.log(url);
      console.log("");
    }
  }

  // ── Logout ─────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    this.deleteCredentials();
    this.credentials = null;
  }
}
