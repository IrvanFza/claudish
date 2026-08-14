/**
 * Containment — a bundled catalog row must never become bare-name reachable.
 *
 * This is the ONE invariant the feature's whole safety argument rests on.
 * Activation infers intent from an ambient env var (`PERPLEXITY_API_KEY`
 * exported for an unrelated script adds a picker row), and that is only
 * acceptable because the cost of the wrong inference is a picker row rather
 * than a request billed to a vendor the user never chose. The moment a catalog
 * name can be reached by typing a BARE model id, the inference can move money.
 *
 * Three doors, all pinned here:
 *
 *  1. `nativeModelPatterns` — the schema has no such field, so a row cannot
 *     declare one; asserted anyway against the live derived table, because the
 *     schema could gain one and the assertion is what would notice.
 *  2. `legacyPrefixes` — same shape.
 *  3. `DEFAULT_ROUTING_RULES` — the door neither of the first two covers, and
 *     the only one a future contributor can open with a one-line, entirely
 *     well-meaning edit ("`llama-*` should try Groq first, it's faster"). That
 *     edit re-opens silent bare-name billing for every user who happens to have
 *     a `GROQ_API_KEY` exported. It is data in a different file from the
 *     catalog, so nothing else connects the two.
 *
 * Door 3 is NOT wide open today, and the reason is worth recording because it
 * decides how much this assertion is worth. `default-routing-rules.ts` runs
 * `validateDefaultRoutingRules()` at module load and THROWS on a provider name
 * it cannot resolve, so adding `"llama-*": ["groq", …]` today crashes at import
 * (verified). But `getProviderByName` is runtime-aware, so that validator stops
 * refusing the name the moment the catalog row is registered — i.e. exactly
 * when the user has the vendor's key, which is exactly the user who would be
 * silently billed. The load-order accident is the protection, and load order is
 * not a guarantee anybody is maintaining. Hence an explicit assertion.
 *
 * Note what is deliberately NOT asserted: that a catalog name never appears in
 * a chain at all. `defaultProvider` is appended to EVERY bare chain
 * (`routing-rules.ts`), so a user who sets `"defaultProvider": "groq"` really
 * does put a catalog row in bare chains — explicit user action, not a silent
 * path. The invariant is about what claudish SHIPS.
 */

import { describe, expect, test } from "bun:test";
import type { RoutingRules } from "../profile-config.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { getLegacyPrefixPatterns, getNativeModelPatterns } from "./provider-definitions.js";

const catalogNames = PREDEFINED_ENDPOINTS.map((e) => e.name.toLowerCase());

/**
 * Every (pattern, entry) in a rules table whose provider half names a catalog
 * row. Applied to the shipped table AND to a synthetic leaking one, so the
 * assertion's discriminating power is proved here rather than assumed — a
 * containment check that cannot fail is worse than none, and this one cannot be
 * mutation-tested against the real file (the load-time validator throws first).
 */
function routingRuleLeaks(rules: RoutingRules): Array<{ pattern: string; candidate: string }> {
  const leaked: Array<{ pattern: string; candidate: string }> = [];
  for (const [pattern, chain] of Object.entries(rules)) {
    for (const candidate of chain ?? []) {
      // Entries are `provider` or `provider@model`; compare the provider half.
      const provider = String(candidate).split("@")[0].trim().toLowerCase();
      if (catalogNames.includes(provider)) leaked.push({ pattern, candidate });
    }
  }
  return leaked;
}

describe("catalog containment", () => {
  test("the catalog is non-empty (or every assertion below is vacuous)", () => {
    expect(catalogNames.length).toBeGreaterThan(0);
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
  });

  test("no catalog row declares nativeModelPatterns", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      expect(row).not.toHaveProperty("nativeModelPatterns");
    }
  });

  test("no catalog name owns a native model pattern", () => {
    const owners = new Set(getNativeModelPatterns().map((p) => p.provider.toLowerCase()));
    const leaked = catalogNames.filter((n) => owners.has(n));
    expect(leaked).toEqual([]);
  });

  test("no catalog name owns a legacy prefix", () => {
    const owners = new Set(getLegacyPrefixPatterns().map((p) => p.provider.toLowerCase()));
    const leaked = catalogNames.filter((n) => owners.has(n));
    expect(leaked).toEqual([]);
  });

  test("no catalog name appears anywhere in DEFAULT_ROUTING_RULES", () => {
    expect(routingRuleLeaks(DEFAULT_ROUTING_RULES)).toEqual([]);
  });

  test("the leak checker actually catches a leak (bare and provider@model)", () => {
    const vendor = catalogNames[0];
    expect(routingRuleLeaks({ "llama-*": [vendor, "openrouter"] })).toEqual([
      { pattern: "llama-*", candidate: vendor },
    ]);
    expect(routingRuleLeaks({ "llama-*": [`${vendor}@llama-3.3-70b`] })).toEqual([
      { pattern: "llama-*", candidate: `${vendor}@llama-3.3-70b` },
    ]);
    expect(routingRuleLeaks({ "llama-*": ["openrouter"] })).toEqual([]);
  });

  test("no catalog name is a routing-rule PATTERN either", () => {
    // A rule keyed on a vendor name (`"groq-*": [...]`) would not make the
    // vendor a destination, but it is the same class of edit and reads as
    // sanctioned precedent for the one that would.
    const keys = Object.keys(DEFAULT_ROUTING_RULES).map((k) => k.toLowerCase());
    const leaked = catalogNames.filter((n) => keys.some((k) => k === n || k === `${n}-*`));
    expect(leaked).toEqual([]);
  });
});
