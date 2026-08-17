/**
 * The one place endpoints get registered, and the one place that decides when.
 *
 * Six call sites need the provider roster to already contain the bundled
 * catalog — the interactive picker, `--probe`, the proxy, the parent-side
 * spawn pre-hydration, the config TUI and `serve` — and each of them reaches it
 * by a different path. A latch here means the answer does not depend on which
 * one ran first, and the config is read exactly once per process.
 *
 * ── Why this function is SYNCHRONOUS, and why that is the design ────────────
 *
 * Because nothing on this path can `await`, nothing on it can reach the
 * 1Password SDK — the SDK sits behind `await` inside the authority's async
 * `resolveKey`. THAT is the guarantee, and it is worth being exact about:
 * `op-source.ts` and `@1password/sdk` ARE in this module's static import
 * closure (via `predefined-endpoints` → `custom-endpoints-loader` →
 * `authority` → `api-key-credential`), so the protection is sync-ness, not
 * import-graph isolation, and a future edit could reach the SDK without
 * changing a single signature. It matters on a machine where concurrent
 * 1Password handshakes are arbitrated globally and a burst of denials trips a
 * 15-second machine-wide suppression. Registration reads `process.env`, the
 * config file and an array embedded in the binary. It opens no socket and
 * builds no handler: `buildProviderProfile` returns a closure, so nothing is
 * constructed until a request actually routes to one of these providers.
 *
 * Keep it sync. An `async` here would compile fine and quietly re-open that
 * door.
 *
 * ── Why there is an explicit re-evaluation entry point ─────────────────────
 *
 * The latch on its own breaks the config TUI's hydrate-on-add: importing a
 * 1Password key there hydrates `process.env`, drops handler caches and calls
 * `refreshConfig()` so providers light up WITHOUT a restart. A latched
 * registration would never re-ask, so a just-imported `GROQ_API_KEY` would
 * leave its vendor invisible until relaunch — reintroducing exactly the
 * before/after-hydration window that path exists to close. Hence
 * `{ force: true }` / `invalidateEndpointRegistration()`.
 *
 * Re-evaluation only ADDS: the runtime registry has no removal, so a row that
 * has since been disabled stays registered for the life of the process. That is
 * the right trade — the alternative is a de-registration path whose only
 * consumer is a config edit made mid-session, and a PARTIAL removal (definition
 * gone, credential registration and any cached handler still live) is worse
 * than a stale provider because it half-exists. The cost is paid in a warning
 * instead: `loadPredefinedEndpoints` names any row that was registered earlier
 * in this process and is no longer eligible, and says a restart is required.
 * Silence there was the actual defect — "I turned it off and it kept
 * answering" reads as a bug, not as a documented limit.
 *
 * SCOPE: this registers the BUNDLED catalog only. Folding user-authored
 * `customEndpoints` into the same seam — which would also fix their
 * long-standing absence from the picker and `--probe` — is a separate,
 * separately revertable change, kept apart so a picker regression has one
 * obvious cause.
 */

import { type ClaudishProfileConfig, loadConfig } from "../profile-config.js";
import { loadPredefinedEndpoints } from "./predefined-endpoints.js";

let registered = false;

export interface EnsureEndpointsOptions {
  /** Re-evaluate even though registration already ran. */
  force?: boolean;
  /**
   * The GLOBAL config (`loadConfig()`) to decide against.
   *
   * Pass it at any site that also calls `loadCustomEndpoints`, so both halves
   * demonstrably read ONE object: the catalog's suppression set is built from
   * `customEndpoints`, and the two halves disagreeing about which config —
   * or which SCOPE — they read is what deletes a provider outright (a
   * project-scoped `customEndpoints.groq` suppressing the bundled row while its
   * replacement, read from global config, never registers). Must never be a
   * project `.claudish.json`: `customEndpoints` is global-only today, so a
   * wider scope here is precisely the mismatch to avoid.
   */
  config?: ClaudishProfileConfig;
}

/**
 * Register the bundled endpoint catalog. Idempotent; a no-op after the first
 * call unless `force` is set.
 *
 * NEVER throws. A config that cannot be read leaves the user with the builtin
 * provider set — the same degradation every other config consumer applies —
 * rather than taking down whichever startup path happened to call first.
 */
export function ensureEndpointsRegistered(opts: EnsureEndpointsOptions = {}): void {
  if (registered && !opts.force) return;
  registered = true;
  try {
    loadPredefinedEndpoints(opts.config ?? loadConfig());
  } catch {
    // Deliberately silent: `loadPredefinedEndpoints` already warns per row for
    // anything it can attribute, and a failure to read config at all is
    // reported by every other consumer of the same file.
  }
}

/**
 * Forget the latch so the next `ensureEndpointsRegistered()` re-evaluates.
 * Call after anything that can change the answer within a live process —
 * a credential imported in the config TUI, a config save.
 */
export function invalidateEndpointRegistration(): void {
  registered = false;
}
