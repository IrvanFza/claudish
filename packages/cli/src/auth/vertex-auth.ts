/**
 * Vertex AI OAuth Authentication Manager
 *
 * Handles OAuth2 token generation for full Vertex AI access.
 * Supports:
 * - Application Default Credentials (ADC) via gcloud CLI
 * - Service Account JSON via GOOGLE_APPLICATION_CREDENTIALS
 *
 * Used for partner models (Anthropic Claude, Mistral, etc.) and
 * project-based Vertex AI access.
 *
 * OAuth over a project is the ONLY mode. The Express API-key path
 * (VERTEX_API_KEY) was removed on 2026-09-21: ADC is Google's documented way
 * into Vertex AI, and the second mode duplicated the Gemini direct API while
 * making every caller branch on which one was active.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execAsync = promisify(exec);

/**
 * The ADC file `gcloud auth application-default login` writes.
 *
 * One helper rather than the string in three places: the token path, the
 * credential-presence check and the project resolution all read the SAME file,
 * and a copy that drifted would make one of them disagree with the others.
 */
function adcCredentialsPath(): string {
  return join(homedir(), ".config/gcloud/application_default_credentials.json");
}

/** Vertex location used when VERTEX_LOCATION is unset — a DEFAULT, never a guess. */
const DEFAULT_VERTEX_LOCATION = "us-central1";

interface VertexAccessToken {
  token: string;
  expiresAt: number;
}

export interface VertexConfig {
  projectId: string;
  location: string;
}

/**
 * Manages OAuth2 tokens for Vertex AI
 */
export class VertexAuthManager {
  private cachedToken: VertexAccessToken | null = null;
  private refreshPromise: Promise<string> | null = null;
  private tokenRefreshMargin = 5 * 60 * 1000; // Refresh 5 minutes before expiry

  /**
   * Get a valid access token, refreshing if needed
   */
  async getAccessToken(): Promise<string> {
    // If refresh already in progress, wait for it
    if (this.refreshPromise) {
      log("[VertexAuth] Waiting for in-progress refresh");
      return this.refreshPromise;
    }

    // Check cache
    if (this.isTokenValid()) {
      return this.cachedToken!.token;
    }

    // Start refresh (lock to prevent duplicate refreshes)
    this.refreshPromise = this.doRefresh();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Force refresh the token
   */
  async refreshToken(): Promise<void> {
    this.cachedToken = null;
    await this.getAccessToken();
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken) return false;
    return Date.now() < this.cachedToken.expiresAt - this.tokenRefreshMargin;
  }

  /**
   * Perform the actual token refresh
   */
  private async doRefresh(): Promise<string> {
    log("[VertexAuth] Refreshing token");

    // Try ADC first (gcloud)
    const adcToken = await this.tryADC();
    if (adcToken) {
      this.cachedToken = adcToken;
      log(`[VertexAuth] ADC token valid until ${new Date(adcToken.expiresAt).toISOString()}`);
      return adcToken.token;
    }

    // Try service account
    const saToken = await this.tryServiceAccount();
    if (saToken) {
      this.cachedToken = saToken;
      log(
        `[VertexAuth] Service account token valid until ${new Date(saToken.expiresAt).toISOString()}`
      );
      return saToken.token;
    }

    throw new Error(
      "Failed to authenticate with Vertex AI.\n\n" +
        "Options:\n" +
        "1. Run: gcloud auth application-default login\n" +
        "2. Set: export GOOGLE_APPLICATION_CREDENTIALS='/path/to/service-account.json'\n"
    );
  }

  /**
   * Try to get token via Application Default Credentials (gcloud)
   */
  private async tryADC(): Promise<VertexAccessToken | null> {
    try {
      // Check if ADC credentials file exists
      const adcPath = adcCredentialsPath();

      if (!existsSync(adcPath)) {
        log("[VertexAuth] ADC credentials file not found");
        return null;
      }

      // Get token via gcloud CLI
      const { stdout } = await execAsync("gcloud auth application-default print-access-token", {
        timeout: 10000,
      });

      const token = stdout.trim();
      if (!token) {
        log("[VertexAuth] ADC returned empty token");
        return null;
      }

      // Tokens typically last 1 hour, use 55 minutes to be safe
      const expiresAt = Date.now() + 55 * 60 * 1000;

      return { token, expiresAt };
    } catch (e: any) {
      log(`[VertexAuth] ADC failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Try to get token via service account JSON
   */
  private async tryServiceAccount(): Promise<VertexAccessToken | null> {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      return null;
    }

    if (!existsSync(credPath)) {
      throw new Error(
        `Service account file not found: ${credPath}\n\nCheck GOOGLE_APPLICATION_CREDENTIALS path.`
      );
    }

    try {
      // Use gcloud with service account
      const { stdout } = await execAsync(
        `gcloud auth print-access-token --credential-file-override="${credPath}"`,
        { timeout: 10000 }
      );

      const token = stdout.trim();
      if (!token) {
        log("[VertexAuth] Service account returned empty token");
        return null;
      }

      // Tokens typically last 1 hour, use 55 minutes to be safe
      const expiresAt = Date.now() + 55 * 60 * 1000;

      return { token, expiresAt };
    } catch (e: any) {
      log(`[VertexAuth] Service account auth failed: ${e.message}`);
      return null;
    }
  }
}

/**
 * Per-process memo of the DISCOVERED project — the ADC file's `quota_project_id`
 * and `gcloud config`, i.e. the two tiers that cost I/O.
 *
 * The env tier is deliberately NOT memoized: `resolveVertexConfig` reads
 * `VERTEX_PROJECT` fresh on every call, so a caller that sets it still wins
 * immediately and no earlier discovery result can shadow it.
 *
 * Nothing here is written to disk. A resolved project is a fact about this
 * machine's CURRENT gcloud state; a cached copy would outlive
 * `gcloud config set project` and silently bill the previous project.
 */
let discoveredProjectPromise: Promise<string | null> | null = null;

/**
 * Reset the discovery memo. Test seam — production resolves once per process.
 */
export function resetVertexProjectDiscovery(): void {
  discoveredProjectPromise = null;
}

/** `quota_project_id` from the ADC file — the same file the token path reads. */
async function readAdcQuotaProject(): Promise<string | null> {
  try {
    const raw = await readFile(adcCredentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as { quota_project_id?: unknown };
    const project =
      typeof parsed.quota_project_id === "string" ? parsed.quota_project_id.trim() : "";
    return project || null;
  } catch (e: any) {
    log(`[VertexAuth] No project in ADC file: ${e.message}`);
    return null;
  }
}

/**
 * The project from `gcloud config`.
 *
 * `gcloud config get project` is the modern form; `gcloud config get-value
 * project` is the older one and still the only one some installed CLIs accept,
 * so the modern form is tried first and the older one ONLY after it errors — an
 * old CLI rejects `get` outright, which is what distinguishes the two.
 * Both print `(unset)` when nothing is configured — that is an ANSWER ("no
 * project"), not a value, so it ends the search rather than being returned.
 *
 * Same 10s timeout as the token calls above: a hung gcloud must not hang a
 * request.
 */
async function readGcloudConfigProject(): Promise<string | null> {
  for (const command of ["gcloud config get project", "gcloud config get-value project"]) {
    try {
      const { stdout } = await execAsync(command, { timeout: 10000 });
      // gcloud prints the value on stdout and its notices on stderr, but older
      // versions also echo "Your active configuration is: [default]" — take the
      // last non-empty line rather than the whole buffer.
      const value =
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .pop() ?? "";
      // A command that RAN and said "(unset)" has answered: there is no
      // configured project. Trying the other spelling would ask a working CLI
      // the same question twice, on the exact path (ADC but no project) where
      // the user is waiting for an error message.
      if (!value || value === "(unset)" || /\s/.test(value)) return null;
      log(`[VertexAuth] Project from \`${command}\``);
      return value;
    } catch (e: any) {
      log(`[VertexAuth] \`${command}\` failed: ${e.message}`);
    }
  }
  return null;
}

/**
 * Discovery, at most ONCE per process.
 *
 * Both outcomes are memoized, the null included: a machine with no gcloud
 * project would otherwise pay two `gcloud` invocations (up to their 10s timeout)
 * on every single request.
 */
function discoverOnce(): Promise<string | null> {
  if (!discoveredProjectPromise) {
    discoveredProjectPromise = discoverVertexProject();
  }
  return discoveredProjectPromise;
}

/** Discovery tiers only — the env tier lives in resolveVertexConfig. */
async function discoverVertexProject(): Promise<string | null> {
  const fromAdc = await readAdcQuotaProject();
  if (fromAdc) {
    log("[VertexAuth] Project from ADC quota_project_id");
    return fromAdc;
  }
  return readGcloudConfigProject();
}

/**
 * Resolve the Vertex project and location.
 *
 * Precedence, highest first:
 *   1. VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT (VERTEX_LOCATION for the location)
 *   2. `quota_project_id` in ~/.config/gcloud/application_default_credentials.json
 *   3. `gcloud config get project`
 *
 * Tiers 2 and 3 exist because ADC users have ALREADY told gcloud which project
 * they are on; making them repeat it in a claudish-specific variable is how
 * `vertex@` ended up unreachable for anyone who had set up Google's own way in.
 *
 * Returns null when no project can be resolved — never a placeholder, never an
 * invented id. `validateVertexOAuthConfig` turns that null into the remedy.
 */
export async function resolveVertexConfig(): Promise<VertexConfig | null> {
  const projectId =
    process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || (await discoverOnce());
  if (!projectId) {
    return null;
  }

  return {
    projectId,
    location: process.env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION,
  };
}

/**
 * Vertex has exactly ONE way in: a Google Cloud project plus OAuth from ADC or a
 * service account. The Express API-key path was DELETED (2026-09-21) — Google's
 * documented route into Vertex AI is ADC, and a second mode meant every caller
 * carried a branch for a path this project does not support.
 *
 * Pure and synchronous on purpose: the caller resolves the project with
 * `resolveVertexConfig` (async — it may read the ADC file or run gcloud) and
 * hands the answer in, so there is no hidden env read here that could disagree
 * with the resolution the rest of the request uses.
 */
export function selectVertexAuthMode(configured: { project?: string }): "project" | null {
  return configured.project ? "project" : null;
}

/**
 * Validate Vertex AI OAuth configuration.
 * Returns an error message if unusable, null if OK.
 */
export async function validateVertexOAuthConfig(): Promise<string | null> {
  const hasADC = existsSync(adcCredentialsPath());
  const hasServiceAccount = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const noCredentials =
    "No Vertex AI credentials found.\n\n" +
    "Options:\n" +
    "1. Run: gcloud auth application-default login\n" +
    "2. Set: export GOOGLE_APPLICATION_CREDENTIALS='/path/to/service-account.json'";

  const config = await resolveVertexConfig();
  if (!config) {
    // Credentials but no project is a DIFFERENT failure from no credentials, and
    // naming the wrong one sends the user to re-run a login that already worked.
    if (!hasADC && !hasServiceAccount) return noCredentials;
    const credentialKind = hasADC
      ? "Application Default Credentials are"
      : "A service account credential is";
    return (
      `${credentialKind} present, but no Google Cloud project is set.\n\n` +
      "Set one with either:\n" +
      "  export VERTEX_PROJECT='your-gcp-project-id'\n" +
      "  gcloud config set project your-gcp-project-id\n\n" +
      "Claudish also reads quota_project_id from the ADC file and `gcloud config get project`, " +
      "so either of the above is enough — no claudish-specific configuration is needed.\n" +
      `Location defaults to ${DEFAULT_VERTEX_LOCATION}; override it with VERTEX_LOCATION.`
    );
  }

  if (!hasADC && !hasServiceAccount) {
    return noCredentials;
  }

  return null;
}

/**
 * API host for a Vertex location.
 *
 * Most locations are regional and take the `<location>-aiplatform.googleapis.com`
 * template. Two do not, and both were previously built from that template and
 * 404'd, so the location was unreachable rather than merely degraded.
 *
 * Measured 2026-08-18, POSTing a real generateContent path to each host. A 401
 * means the route exists and wants credentials; a 404 means there is no such
 * route. DNS does not discriminate here — every name below resolves, because
 * `*.googleapis.com` has a catch-all frontend.
 *
 *   location     host built                              code
 *   us-central1  us-central1-aiplatform.googleapis.com   401   regional, unchanged
 *   us           us-aiplatform.googleapis.com            401   regional, unchanged
 *   eu           eu-aiplatform.googleapis.com            404   BROKEN
 *                aiplatform.eu.rep.googleapis.com        401   the real one
 *   global       global-aiplatform.googleapis.com        404   BROKEN
 *                aiplatform.googleapis.com               401   the real one
 *
 * `us` stays on the regional host on purpose, even though
 * `aiplatform.us.rep.googleapis.com` also answers 401. Both are real and they
 * are different endpoints — only the REP one carries a data-residency
 * guarantee. But nothing observable from outside says which a user setting
 * `VERTEX_LOCATION=us` intends, and the current construction already reaches a
 * live route. Rerouting it would be inference; this table is measurement.
 * A user who needs US data residency should be given a way to ask for it
 * explicitly rather than have it inferred from a location string.
 *
 * Reported by @nickoloss in #145, who found the eu case and verified the host.
 */
export function vertexApiHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "eu") return "aiplatform.eu.rep.googleapis.com";
  return `${location}-aiplatform.googleapis.com`;
}

/**
 * Build Vertex AI endpoint URL for OAuth mode
 */
export function buildVertexOAuthEndpoint(
  config: VertexConfig,
  publisher: string,
  model: string,
  streaming = true
): string {
  const method = streaming ? "streamGenerateContent" : "generateContent";

  // For Gemini models (publisher: google), use generateContent
  // For partner models (publisher: anthropic, mistral), use rawPredict
  if (publisher === "google") {
    // Add ?alt=sse for SSE streaming format
    const sseParam = streaming ? "?alt=sse" : "";
    return (
      `https://${vertexApiHost(config.location)}/v1/` +
      `projects/${config.projectId}/locations/${config.location}/` +
      `publishers/${publisher}/models/${model}:${method}${sseParam}`
    );
  }
  if (publisher === "mistralai") {
    // Mistral uses regional rawPredict/streamRawPredict endpoint
    const mistralMethod = streaming ? "streamRawPredict" : "rawPredict";
    return (
      `https://${vertexApiHost(config.location)}/v1/` +
      `projects/${config.projectId}/locations/${config.location}/` +
      `publishers/mistralai/models/${model}:${mistralMethod}`
    );
  }
  // Other partners (MiniMax, Meta, etc.) use global OpenAI-compatible endpoint
  return `https://aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/global/endpoints/openapi/chat/completions`;
}

// Singleton instance
let authManagerInstance: VertexAuthManager | null = null;

/**
 * Get the shared VertexAuthManager instance
 */
export function getVertexAuthManager(): VertexAuthManager {
  if (!authManagerInstance) {
    authManagerInstance = new VertexAuthManager();
  }
  return authManagerInstance;
}
