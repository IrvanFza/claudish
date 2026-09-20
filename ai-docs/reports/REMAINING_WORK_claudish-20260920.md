# Remaining work on the claudish side (2026-09-20)

Branch `fix/v3-reader-gaps`, 45 commits on top of PR #266, nothing pushed, nothing released. The full
suite is green (3,608 pass, 0 fail, 28 live tests skipped) and Test All reaches 24 providers ready.

Decisions already taken are stated with each item so the reason survives the session. Anything that
still needs a decision or a measurement is marked **DISCUSS** or **RESEARCH**.

---

## 1. Vertex: refactor from API key to Application Default Credentials

**Decision (Jack, 2026-09-20).** Google's current way in is ADC. The API-key path ("Vertex AI
Express") is the old way and is no longer the shape we build for. Nothing is broken; this is a
refactor.

**What already works.** `auth/vertex-auth.ts` reads ADC and service accounts; `gcloud auth
application-default print-access-token` works on this machine; with `VERTEX_PROJECT` set, the
credential authority mints a valid Bearer; the transport, endpoint builder and the per-publisher
adapters exist.

**What blocks it.** `resolveRemoteProvider("vertex@…")` returns null, so no handler is built and the
proxy answers "its provider has no credential" — the wrong reason. The remote registry drops any
provider whose effective base URL is empty (`providers/remote-provider-registry.ts:41-50`), and
Vertex's is empty by design, because its transport builds the URL from project, location and
publisher.

| # | Work | Touches | Size |
|---|---|---|---|
| 1.1 | A provider declares that its transport builds the endpoint, and stays in the registry. The excluded-provider error stops reading as a missing credential. | `provider-definitions.ts`, `remote-provider-registry.ts`, `proxy-server.ts` | S |
| 1.2 | Resolve project and location without an env var: ADC `quota_project_id`, then `gcloud config get project`; `VERTEX_PROJECT` and `VERTEX_LOCATION` still win. | `auth/vertex-auth.ts` | S |
| 1.3 | Readiness and the Providers tab report an ADC credential, "needs a project", or "needs `gcloud auth application-default login`" — not a key column that expects `VERTEX_PROJECT`. | `auth/credentials/*vertex*`, `tui/` | M |
| 1.4 | Probe pick from the project's publisher models, ranked newest first, since models-index marks Vertex client-selected. | `transport/vertex-oauth.ts`, `model-discovery.ts` | M |
| 1.5 | Live validation (a Gemini publisher model, an Anthropic publisher model, streaming, the 401 refresh), tests by Codex, settings docs. | tests, `docs/` | M |

1.1 and 1.2 together are about two hours and turn Vertex from unreachable into working on ADC. All
five are one focused session, roughly 8 to 12 hours with live checks.

- **DISCUSS.** What happens to the Express API-key path: delete it, or keep it only when
  `VERTEX_API_KEY` is set explicitly? Deleting is simpler and matches "one way in"; keeping it costs
  a branch we cannot test without an Express key.
- **RESEARCH.** Service-account credentials are a second shape we have never exercised here.
  Per-location model availability means a pick verified on this project may 404 on another.
  Anthropic-on-Vertex uses `rawPredict` with its own payload shape and needs its own live check.

---

## 2. Routing redesign (the approved design, not yet built)

**Decision (Jack, 2026-09-20).** One order: user rules → subscriptions (catalog membership) →
dynamic subscriptions (the account's own list) → native API → gateways → fallback. Inside a tier: the
model's own vendor first, then cheapest by the catalog's price, then the rest. No local preference
list and no local state; a spent limit is not remembered, the request moves to the next hop.

| # | Work | Notes |
|---|---|---|
| 2.1 | Gather candidates from the catalog: plan membership, `aggregators[]` connections, and each dynamic subscription's own list | the data is all published today |
| 2.2 | Sort by tier, then vendor-first, then price, then the rest | unpriced connections sort last, by agreement with the backend |
| 2.3 | Drop hops without a credential, send exact wire ids | already true on this branch |
| 2.4 | Fallback: optional, configurable to any aggregator, appended only when that aggregator serves the model; otherwise an error | removes the dead `qwen3.8-max` → OpenRouter hop |
| 2.5 | Delete `default-routing-rules.ts`, `buildCatalogRoutingRules`, `retainKnownCatalogRoutingRules` and the four-way merge | only the user's own rules remain, used verbatim |
| 2.6 | No catalog: local providers only, and never a guessed id | Kimi Coding's `k3` is simply not offered until the catalog is readable |
| 2.7 | Gate: a before-and-after route table over every model in the catalog, read by hand | no route may disappear silently |

- **DISCUSS.** "The model's own vendor first" needs one clarification for vendors that sell both a
  plan and a direct API (Moonshot sells Kimi Coding and the Kimi API). The tiers already separate
  them, so vendor-first only orders within a tier; confirm that reading.
- **DISCUSS.** The fallback's configuration: the config key's name, whether it defaults to OpenRouter
  as today, and how a user turns it off.
- **Partly waiting on the backend.** Price ordering needs T3; until then most metered connections are
  unpriced and sort last, which is correct but not yet useful.

---

## 3. Tests for the fixes made today (Codex writes them)

Ten fixes landed with live evidence but without unit tests: the Gemini probe effort, the
parameter-versus-model hint, Mistral's model list, Poe's probe pick and transport method, the
discovery retries, the 403 "access denied" hint and its classification, the DeepSeek effort-versus-
thinking conflict, the local 401 message, the newest-first ranking, and the MiniMax host (this one
has tests). One brief, one Codex run, each test verified to fail when its fix is reverted.

---

## 4. Waiting on the backend (no work until they ship)

| Item | What we do when it lands |
|---|---|
| T1 modalities | consume `inputModalities`/`outputModalities`; treat `null` as unknown; drop the name-shaped guess |
| T2 naming | switch the reader on the generation they name, with no alias; we read no `roster*` field today, so only the reason mapping matters |
| T3 prices | activate price ordering inside a tier; `unavailable` sorts after priced |
| T6 Poe | prefer their verified pick; keep our account-list discovery as the fallback |

---

## 5. Smaller follow-ups

- Retire "served set" in the code (33 uses) and "roster" in `ai-docs/architecture` (about 13 files) and `docs/settings-reference.md:747`.
- An incomplete provider list currently empties that provider's list in the picker as well as for availability. It should stay visible and only lose the right to deny. **DISCUSS** the exact rule.
- Redact `readinessDetail` before anything displays it. Nothing displays it today.
- A probe failure rendered `[object Object]` as its error (seen on the Mistral walk). **RESEARCH** where the object reaches the message.
- Extend the vocabulary guard to the retired terms above once they are renamed.

---

## 6. Landing

CI has never run on these 45 commits. Order: finish the work above, run the suite and Test All, push
onto PR #266's branch (a fast-forward), let CI run, then release 9.8.0. Nothing is pushed until Jack
says so.

---

## 7. Housekeeping

- Three `worktree-agent-*` worktrees whose commits are already here, plus `agent-a9446b0dbea384afd`, which this session did not create.
- After 9.8.0 is installed: delete the `QWEN_CLOUD_PLAN_API_KEY` Keychain item.
- `/Users/jack/mag/claudish/.env` holds 5 duplicate lines.
- Jack's side, not claudish: the Alibaba Coding key is the Token Plan key, and PAYG needs model access granted in the Model Studio console.
