/**
 * Unified TTL for ALL local caches of Firebase-derived data.
 *
 * Caching policy (decided in the routing/catalog redesign):
 *   - We cache only Firebase responses on disk. Direct-provider catalog
 *     calls (Zen, LiteLLM /model_group/info) are removed in commit 5.
 *   - Every Firebase cache uses the same 24-hour TTL. One knob.
 *   - Sites that read/write these caches must comment that they hold
 *     Firebase-derived data — NOT direct-provider data.
 */
export const FIREBASE_CACHE_TTL_HOURS = 24;
export const FIREBASE_CACHE_TTL_MS = FIREBASE_CACHE_TTL_HOURS * 60 * 60 * 1000;
