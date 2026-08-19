/**
 * Every token a BUILTIN provider already answers to.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * It started inside `predefined-endpoints.ts`, guarding the BUNDLED catalog
 * only. That left user-authored `customEndpoints` unguarded, and #191 is what
 * that cost: `credentials.registerApiKeyProvider` is a plain `Map.set`, so an
 * entry keyed `openrouter` landed in a split state — `getProviderByName` still
 * answered with the builtin (so `baseUrl` stayed `https://openrouter.ai`), the
 * profile still resolved to the builtin, and only the CREDENTIAL flipped. Real
 * requests to openrouter.ai were signed with `CUSTOM_OPENROUTER_KEY`.
 *
 * The failure is quiet in both directions. The user does not get their endpoint
 * (the definition is shadowed) AND loses the builtin's credential, while the
 * config, the definition and `--probe` all show a consistent "builtin" picture.
 *
 * `custom-endpoints-loader` cannot import from `predefined-endpoints` (that
 * dependency runs the other way), so the guard lives here and both halves
 * import it. One definition means the two can never disagree about what is
 * reserved.
 *
 * ── What the collision actually breaks, measured ────────────────────────────
 *
 * Not what it looks like. `parseModelSpec` resolves `@` prefixes against
 * `PROVIDER_SHORTCUTS`, a MODULE-LOAD-TIME snapshot (`model-parser.ts`), so a
 * runtime registration never reaches routing at all and the "custom endpoint
 * hijacks `mistral@`" story is wrong. The real defect is snapshot-vs-live
 * desync, and it runs the OTHER way: the builtin keeps the prefix while
 * `getShortcuts()` — rebuilt live, runtime-last — reports the runtime row owns
 * it. The user loses the prefix they typed and the two tables disagree about
 * who answers.
 *
 * The guard is correct under either story, and the reasoning is written down
 * accurately because a wrong justification is how a correct guard gets deleted.
 */

import { PROVIDER_FILTER_ALIAS_EXTRA } from "./picker-alias-extra.js";
import { BUILTIN_PROVIDERS } from "./provider-definitions.js";

/**
 * Map of reserved token (lowercased) → the builtin provider that owns it.
 *
 * Built from `BUILTIN_PROVIDERS` at CALL TIME. Never a cached constant and
 * never a hand-written list: builtins get added, and a list that has to be kept
 * in sync is a list that will be out of sync exactly when it matters.
 *
 * `PROVIDER_FILTER_ALIAS_EXTRA` is included because it is part of the same
 * user-facing namespace — `@zen` and `@gem` resolve to builtins in the picker
 * even though no definition declares them — and it is a plain const the check
 * can import. Leaving it to a CI assertion would mean a row named `zen`
 * degrades correctly in CI and incorrectly in the field.
 */
export function reservedNamespace(): Map<string, string> {
  const reserved = new Map<string, string>();
  for (const def of BUILTIN_PROVIDERS) {
    reserved.set(def.name.toLowerCase(), def.name);
    for (const shortcut of def.shortcuts) {
      reserved.set(shortcut.toLowerCase(), def.name);
    }
    for (const legacy of def.legacyPrefixes) {
      reserved.set(legacy.prefix.replace(/[/:]+$/, "").toLowerCase(), def.name);
    }
  }
  for (const [alias, owner] of Object.entries(PROVIDER_FILTER_ALIAS_EXTRA)) {
    reserved.set(alias.toLowerCase(), owner);
  }
  return reserved;
}

/**
 * The builtin that owns `name`, or `undefined` if the name is free.
 *
 * Rebuilds the map per call, which is the same cost `reservedNamespace()`
 * already paid at each of its call sites. Registration runs once per process
 * behind a latch, so this is not on any hot path, and a cached map is exactly
 * the staleness the doc above argues against.
 */
export function reservedNamespaceOwner(name: string): string | undefined {
  return reservedNamespace().get(name.toLowerCase());
}
