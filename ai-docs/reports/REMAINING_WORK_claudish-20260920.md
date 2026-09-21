# Remaining work on the claudish side

**Revision 2, 2026-09-21.** Branch `fix/v3-reader-gaps`, 47 commits on top of PR #266. Nothing pushed,
CI has never run on them, nothing released. Full suite green (3,608 pass, 0 fail, 28 live tests
skipped). Test All: 24 providers ready.

What changed since revision 1: models-index delivered modalities, the membership rename, route prices
and the Vertex reason on generation `g-20260920154425586-418ad3dd`, all validated live. That unblocks
Phase 1. Two items are still theirs: Poe's verified probe pick, and renaming the pricing
discriminator `shape` to `type`.

Every decision below is Jack's unless marked **DISCUSS** (needs a decision) or **RESEARCH** (needs a
measurement). Sizes are agent-hours including live verification.

---

## Phase 1 — consume the catalog data the backend just shipped

The data exists; claudish still guesses. This phase is small, independent, and removes guesses.

### 1.1 Modalities replace the name-shaped guess (M, ~3h)

**Today.** `classifyChatCapability()` in `providers/transport/probe-discovery.ts` decides "is this a
chat model" from the catalog's `videoOutput` flag, and then from a list of name patterns
(`\bimage\b`, `-tts`, `t2v`, …). The name rule is the last guess left in that path.

**Change.** Persist `inputModalities` and `outputModalities` through the reader and decide from them.

- `providers/all-models-cache.ts`: add both fields to `SlimModelEntry`, optional.
- `providers/catalog-client.ts`: carry them through the slim projection into the cache.
- `providers/transport/probe-discovery.ts`: a row whose `outputModalities` exists and lacks `"text"`
  is not a chat model; a row that has them and includes `"text"` is; only a row with none of them
  (absent, `null` or `[]`, all meaning unknown) falls through to `videoOutput` and then the name rule.
- Keep the name rule for models the catalog does not know at all (local servers, custom endpoints).

**Acceptance.** Against the live cache: the 211 rows with a non-text output are excluded by catalog
evidence, not by name; no row with `outputModalities: ["text"]` is excluded; the count of models the
picker offers changes only in the direction of removing non-chat models. Tests by Codex, including a
row whose name looks like an image model but whose catalog output is text.

### 1.2 Prices feed the routing order (M, ~3h; needed by Phase 2)

**Today.** Nothing reads `pricing`. Ordering inside a tier is arbitrary.

**Change.**
- `providers/all-models-cache.ts` and `catalog-client.ts`: persist the connection's `pricing` object
  verbatim, including `shape`/`type`, `tiers`, `input`, `output`, `cachedRead`.
- New helper (`providers/connection-price.ts`): return one comparable number per connection, and a
  label. Rules, from the agreement with the backend: `flat` uses `input`+`output`; `tiered` uses the
  FIRST tier, which the catalog guarantees equals the top-level numbers; `free` is zero; `unavailable`
  and a missing object are unknown and sort after every priced connection. Never average tiers, never
  guess a tier from request size.

**Acceptance.** A unit test over the real fixture rows: 28 tiered connections rank by their first
tier; an `unavailable` connection never outranks a priced one. No behaviour change until Phase 2 uses
it.

### 1.3 Switch `shape` to `type` when the backend names the generation (S, ~30m)

One rename in the reader plus the fixture; no alias, same day as their cutover. Blocked on them.

### 1.4 Prefer Poe's verified pick when it appears (S, ~30m)

No code change is expected: the catalog pick already wins over discovery when present. Verify on the
generation that publishes it, and keep our account-list discovery as the fallback. Blocked on them.

---

## Phase 2 — the routing redesign (the large one)

**Decided.** One order: user rules → subscriptions (catalog membership) → dynamic subscriptions (the
account's own list) → native API → gateways → fallback. Inside a tier: the model's own vendor first,
then cheapest by catalog price, then the rest. No local preference list, no local state. Vendor-first
orders only WITHIN a tier. A spent limit is not remembered; the request moves to the next hop.

### 2.1 Candidate gathering (M, ~4h)

New module, for example `providers/route-candidates.ts`, returning candidates with their tier,
provider, wire id and price. Sources, all already in the cache: plan membership
(`subscriptionPlanIds` plus plan `inclusions`), connections (`aggregators[]` with
`routeStatus: "mapped"`), and each dynamic subscription's own model list. No hand-written table.

### 2.2 Tier assignment and ordering (M, ~3h)

A `tier` on each provider definition: `subscription`, `dynamic-subscription`, `native`, `gateway`,
`fallback`. Sort by tier, then vendor-first (the catalog's `provider` field equals the candidate's
vendor), then by the price from 1.2, then by provider name for determinism.

### 2.3 Credential filter and exact wire ids (done)

Already true on this branch: hops without a credential are dropped, and ids come from the connection.

### 2.4 The fallback rule (S, ~1h)

`defaultProvider` already accepts any provider and is skipped when empty, so "any aggregator, or none"
works today. What is missing: do not append the fallback when the catalog positively says that
aggregator does not serve the model. Then `qwen3.8-max` either reaches Fireworks or returns a clear
error instead of a hop that cannot succeed.

### 2.5 Delete the hand-written table (M, ~2h)

Remove `providers/default-routing-rules.ts`, `buildCatalogRoutingRules`,
`retainKnownCatalogRoutingRules` and the four-way `mergeRoutingRules`. Only the user's own rules
remain, used verbatim. This is where the "exact-key beats glob" hazard disappears.

### 2.6 No catalog means local only (S, ~1h)

Without a readable catalog claudish serves local providers and explicit `provider@model` specs, and
never guesses a renamed id. A bare name returns an error naming the refresh command.

### 2.7 The gate (M, ~3h)

A before-and-after route table over every model in the catalog, produced by a script and read by
hand. Every difference must be a deliberate addition, or a removal this design names. No route may
disappear silently. Then Test All and a real session on two subscriptions.

**DISCUSS before 2.2 lands:** what claudish should do when two candidates in one tier tie on price
and neither is the vendor (today: provider name, alphabetical).

---

## Phase 3 — Vertex: refactor to Application Default Credentials

**Decided.** ADC is Google's way in. The Express API-key path is deleted, not kept.

| # | Work | Files | Size |
|---|---|---|---|
| 3.1 | A provider declares that its transport builds its own endpoint, and stays in the registry; the excluded-provider error stops reading as a missing credential | `provider-definitions.ts`, `providers/remote-provider-registry.ts`, `proxy-server.ts` | S, ~1h |
| 3.2 | Resolve project and location from ADC `quota_project_id`, then `gcloud config get project`; `VERTEX_PROJECT`/`VERTEX_LOCATION` still win | `auth/vertex-auth.ts` | S, ~1h |
| 3.3 | Delete the Express path: `VERTEX_API_KEY`, the alias on `apiKeyEnvVar`, the `express` arm of `selectVertexAuthMode`, the express branch of `vertexProfile`, and the docs that describe it | `provider-definitions.ts`, `provider-profiles.ts`, `auth/vertex-auth.ts`, `docs/` | S, ~1h |
| 3.4 | Readiness and the Providers tab report an ADC credential, "needs a project", or "run `gcloud auth application-default login`" | `auth/credentials/*vertex*`, `tui/` | M, ~3h |
| 3.5 | Probe pick from the project's publisher models, ranked newest first | `transport/vertex-oauth.ts`, `providers/model-discovery.ts` | M, ~3h |
| 3.6 | Live validation and tests: a Gemini publisher model, an Anthropic publisher model, streaming, the 401 refresh | tests, `docs/` | M, ~3h |

3.1 and 3.2 together turn Vertex from unreachable into working on ADC.

**RESEARCH.** Service-account credentials are a shape we have never exercised here; per-location model
availability means a pick verified on this project may 404 on another; Anthropic-on-Vertex uses
`rawPredict` with its own payload shape.

---

## Phase 4 — tests and debt

### 4.1 Tests for the eleven fixes of 2026-09-19/20 (M, ~3h, Codex writes)

The Gemini probe effort, the parameter-versus-model hint, Mistral's model list, Poe's pick and
transport method, the discovery retries, the 403 "access denied" hint and its classification, the
DeepSeek effort-versus-thinking conflict, the local 401 message, the newest-first ranking, and the
Alibaba PAYG effort enum. One brief, one Codex run, each test verified to fail when its fix is
reverted.

### 4.2 An incomplete list must stay visible (S, ~1h)

**Decided:** return the incompleteness, do not only record it. Add a detailed call
(`{ models, incomplete?: { reason, droppedRows?, hasMore? } }`) with the array function kept as a thin
wrapper; `providerServesModel` refuses to deny while the marker is set; the picker keeps the rows and
can surface the state later.

### 4.3 Vocabulary (S, ~2h)

Retire "served set" in the code (33 uses) and "roster" in `ai-docs/architecture` (about 13 files) and
`docs/settings-reference.md:747`. Extend `scripts/no-retired-terms.test.ts` to both words afterwards.

### 4.4 Two small defects (S, ~1h)

Redact `readinessDetail` before anything displays it (nothing does today). Find where a probe error
rendered `[object Object]`, seen on the Mistral candidate walk.

---

## Phase 5 — release 9.8.0

1. Finish Phases 1 to 4, suite green, Test All re-run with all keys.
2. Push `fix/v3-reader-gaps` onto PR #266's branch as a fast-forward, let CI run for the first time.
3. Bump `package.json` and `packages/cli/package.json`, regenerate `version.ts`, merge, tag the merge
   commit with an explicit ref, watch the release workflow, verify the published version.
4. After the release: delete the `QWEN_CLOUD_PLAN_API_KEY` Keychain item, remove the 5 duplicate lines
   in `/Users/jack/mag/claudish/.env`, and remove the four `worktree-agent-*` worktrees.

---

## Deferred, with the reason

- **Alibaba PAYG** until after the v3 release. Nine of nine request shapes and models are denied on
  `dashscope-intl` while the same key lists 169 models; the account's model access is the cause, not
  claudish and not the catalog.
- **The public-list rule (old group D).** Catalog membership already gates the Coding Plan, and the
  public list's denial is what keeps an unlisted id away from a `400 Model not exist` that does not
  advance the chain.
- **Alibaba Coding Plan** while the stored key is the Token Plan key.

---

## Suggested order

Phase 1.1 and 1.2 first: they are small, they remove guesses, and 1.2 is a prerequisite for the
ordering in Phase 2. Then Phase 3.1 to 3.3, which is two or three hours and makes Vertex usable. Then
Phase 2, the largest piece, with its gate. Phase 4 can interleave whenever a Codex run is free. Phase
5 last. Total, excluding anything blocked on the backend: roughly 30 to 35 agent-hours.
