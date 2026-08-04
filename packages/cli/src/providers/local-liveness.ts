/**
 * Local-provider liveness — a fast, cheap "is this local server actually
 * running right now?" check for the config TUI.
 *
 * Built-in local providers (ollama, lmstudio, vllm, mlx) are "enabled" purely
 * by a config-list flag (isLocalProviderEnabled) — that flag says nothing about
 * whether the server is up. This module pings each provider's model-listing
 * endpoint with a SHORT timeout so the UI can show "● running" vs "○ down", and
 * so Test All can fast-fail an enabled-but-unreachable local instead of eating
 * the full 15s probe timeout.
 *
 * Health endpoints (all list models on a GET, so a 200 means "up and ready"):
 *   - ollama   → {base}/api/tags
 *   - lmstudio → {base}/v1/models
 *   - vllm     → {base}/v1/models
 *   - mlx      → {base}/v1/models
 *
 * The base URL honors the same env-var overrides the transports use, falling
 * back to the catalog default (e.g. http://localhost:11434 for Ollama).
 */

import { getProviderByName } from "./provider-definitions.js";

/** Short timeout — a local server either answers near-instantly or it's down. */
const PING_TIMEOUT_MS = 2000;

/** Liveness states for a local provider. */
export type LocalLiveness = "running" | "down" | "unknown";

/** Health-check path per local provider (relative to its base URL). */
const HEALTH_PATH: Record<string, string> = {
  ollama: "/api/tags",
  lmstudio: "/v1/models",
  vllm: "/v1/models",
  mlx: "/v1/models",
};

/**
 * Resolve a local provider's base URL: first env override (in catalog order),
 * else the catalog default. Trailing slash trimmed.
 */
export function localBaseUrl(catalogName: string): string | null {
  const def = getProviderByName(catalogName);
  if (!def || !def.isLocal) return null;
  for (const envVar of def.baseUrlEnvVars ?? []) {
    const v = process.env[envVar];
    if (v) return v.replace(/\/+$/, "");
  }
  return (def.baseUrl || "").replace(/\/+$/, "") || null;
}

/**
 * True when a response body is a web page rather than an API payload.
 *
 * The one signal that reliably separates "this provider is up" from "some
 * OTHER product owns this port": no model-listing endpoint — not Ollama, not
 * LM Studio, not vLLM, not MLX — ever answers with HTML. A dev server does.
 */
export function isHtmlResponse(res: Response): boolean {
  const contentType = res.headers.get("content-type") ?? "";
  return /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(contentType);
}

/**
 * Ping a single local provider. Returns "running" on a reachable model-listing
 * endpoint (any HTTP response, even 4xx — the server is UP), "down" on a
 * connection error / timeout, "unknown" if the provider isn't a known local one.
 *
 * NOTE: we treat ANY HTTP status as "running" — a 401/404 still proves the
 * server answered. Only a transport-level failure (refused/timeout/DNS) is
 * "down". This mirrors how the probe treats a reachable-but-erroring endpoint.
 *
 * The ONE exception is a 2xx that serves HTML. MLX defaults to :8080, the most
 * contested port on a dev machine, so a stray Vite/Next dev server there passed
 * this check and made MLX look "running" — discovery then fetched the SPA's
 * index.html and reported the baffling "invalid /v1/models response (not JSON)"
 * against a provider the user was not even running. A 4xx is still "running"
 * because a real provider behind auth is up, just gated; only a successful
 * HTML page proves we are talking to somebody else's server.
 */
export async function pingLocalProvider(
  catalogName: string,
  timeoutMs: number = PING_TIMEOUT_MS
): Promise<LocalLiveness> {
  const base = localBaseUrl(catalogName);
  const path = HEALTH_PATH[catalogName];
  if (!base || !path) return "unknown";
  try {
    const res = await fetch(`${base}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok && isHtmlResponse(res)) return "down";
    // Any other response (incl. non-2xx) means the server is reachable.
    return "running";
  } catch {
    return "down";
  }
}

/**
 * Ping several local providers in parallel. Returns a map of catalogName →
 * liveness. Convenience for the TUI's periodic liveness sweep.
 */
export async function pingLocalProviders(
  catalogNames: string[],
  timeoutMs: number = PING_TIMEOUT_MS
): Promise<Record<string, LocalLiveness>> {
  const results = await Promise.all(
    catalogNames.map(async (name) => [name, await pingLocalProvider(name, timeoutMs)] as const)
  );
  return Object.fromEntries(results);
}
