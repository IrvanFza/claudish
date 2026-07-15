/**
 * Preserve the runtime's native `fetch` against @hono/node-server's clobber.
 *
 * `@hono/node-server` (imported by proxy-server.ts for `serve`) runs, at IMPORT
 * time, an UNCONDITIONAL `global.fetch = (info, init) => webFetch(info, {
 * compress: false, ...init })` (dist/globals.js) — a polyfill for Node builds
 * that lack a global fetch. On Bun (and modern Node) it OVERWRITES the fast,
 * spec-complete native fetch with a wrapper whose streaming/abort behavior
 * differs, which broke `probeLink` (streaming POST + AbortSignal → hung) and
 * routes every proxy outbound request through the polyfill in production.
 *
 * @hono's OTHER global mutation — swapping `global.Response`/`Request` at
 * `serve()` time — is suppressed separately, by passing
 * `overrideGlobalObjects: false` to `serve()` (see proxy-server.ts). That flag
 * does NOT guard this import-time fetch clobber, so we still handle fetch here.
 *
 * This module has NO @hono import, so when it loads it still sees the native
 * fetch. It captures that reference; `restoreNativeFetch()` re-installs it after
 * @hono has loaded. Because ES imports are hoisted and evaluated in source
 * order, importing THIS module BEFORE "@hono/node-server" and calling
 * `restoreNativeFetch()` in the module body (after all imports run) yields:
 * capture-native → @hono clobbers → restore-native.
 */

const nativeFetch: typeof globalThis.fetch | undefined = globalThis.fetch;

/**
 * Re-install the native fetch captured at this module's load if @hono/node-server
 * has since replaced `globalThis.fetch`. Idempotent; a no-op when fetch is
 * already the native reference.
 */
export function restoreNativeFetch(): void {
  if (nativeFetch && globalThis.fetch !== nativeFetch) {
    globalThis.fetch = nativeFetch;
  }
}
