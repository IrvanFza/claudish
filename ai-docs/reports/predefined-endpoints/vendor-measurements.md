# Phase 2 — Vendor research and endpoint measurement

Every row below is a measurement taken on 2026-08-14, not a claim from a vendor's
documentation. Raw responses: `probes/probe-results.json`, `probes/probe-v2-results.json`.

## Method

For each candidate host, `POST <base><path>` with a deliberately invalid bearer token and a
nonexistent model, then classify the reply.

Pass 1 asked "401/403 with a JSON `error` object?" and produced **four false negatives**, so
pass 2 replaced it with a self-discriminating test: probe each candidate path **alongside a
deliberately bogus sibling path** (`<path>-claudish-probe-404`). If the two replies differ,
the route is real. If they are byte-identical, we are talking to a catch-all and the path is
wrong.

That comparison needs no documentation, no API key, and no trust in what a vendor's site
claims — which is the point. CLAUDE.md already records what happens when a list endpoint is
taken as evidence: Alibaba's `coding-intl` `/v1/models` returns its full roster to a bogus
key *and* to no key at all. **No `GET /v1/models` result is used here.**

### Accepted evidence

| Verdict | Meaning | Ships |
|---|---|---|
| `auth-realm` | 401/403 — credentials are checked at this exact path | Yes |
| `model-gate` | Route resolved and rejected the fake model, and differs from the bogus sibling | Yes |
| `path-missing` | Generic 404/405/HTML, or identical to the bogus sibling | No |
| `gone` | 410 | No |
| `unreachable` | Hostname does not resolve | No |

## Shipping — 25 vendors

| # | Name | Base URL | Path | Evidence | Env var |
|---|---|---|---|---|---|
| 1 | groq | `https://api.groq.com/openai` | `/v1/chat/completions` | 401 | `GROQ_API_KEY` |
| 2 | cerebras | `https://api.cerebras.ai` | `/v1/chat/completions` | 401 | `CEREBRAS_API_KEY` |
| 3 | together | `https://api.together.xyz` | `/v1/chat/completions` | 401 | `TOGETHER_API_KEY` |
| 4 | fireworks | `https://api.fireworks.ai/inference` | `/v1/chat/completions` | model-gate | `FIREWORKS_API_KEY` |
| 5 | deepinfra | `https://api.deepinfra.com/v1/openai` | `/chat/completions` | 401 | `DEEPINFRA_API_KEY` |
| 6 | nebius | `https://api.studio.nebius.com` | `/v1/chat/completions` | 401 | `NEBIUS_API_KEY` |
| 7 | hyperbolic | `https://api.hyperbolic.xyz` | `/v1/chat/completions` | 401 | `HYPERBOLIC_API_KEY` |
| 8 | sambanova | `https://api.sambanova.ai` | `/v1/chat/completions` | model-gate | `SAMBANOVA_API_KEY` |
| 9 | novita | `https://api.novita.ai/v3/openai` | `/chat/completions` | 401 | `NOVITA_API_KEY` |
| 10 | baseten | `https://inference.baseten.co` | `/v1/chat/completions` | 403 | `BASETEN_API_KEY` |
| 11 | perplexity | `https://api.perplexity.ai` | `/chat/completions` | 401 | `PERPLEXITY_API_KEY` |
| 12 | venice | `https://api.venice.ai/api` | `/v1/chat/completions` | 401 | `VENICE_API_KEY` |
| 13 | chutes | `https://llm.chutes.ai` | `/v1/chat/completions` | 401 | `CHUTES_API_KEY` |
| 14 | featherless | `https://api.featherless.ai` | `/v1/chat/completions` | 401 | `FEATHERLESS_API_KEY` |
| 15 | parasail | `https://api.parasail.io` | `/v1/chat/completions` | 401 † | `PARASAIL_API_KEY` |
| 16 | inference-net | `https://api.inference.net` | `/v1/chat/completions` | 401 | `INFERENCE_NET_API_KEY` |
| 17 | aimlapi | `https://api.aimlapi.com` | `/v1/chat/completions` | 401 | `AIMLAPI_API_KEY` |
| 18 | requesty | `https://router.requesty.ai` | `/v1/chat/completions` | 403 | `REQUESTY_API_KEY` |
| 19 | nanogpt | `https://nano-gpt.com/api` | `/v1/chat/completions` | 401 | `NANOGPT_API_KEY` |
| 20 | cohere | `https://api.cohere.ai/compatibility` | `/v1/chat/completions` | 401 | `COHERE_API_KEY` |
| 21 | scaleway | `https://api.scaleway.ai` | `/v1/chat/completions` | 403 | `SCALEWAY_API_KEY` |
| 22 | upstage | `https://api.upstage.ai` | `/v1/chat/completions` | 401 | `UPSTAGE_API_KEY` |
| 23 | writer | `https://api.writer.com` | `/v1/chat/completions` | 401 † | `WRITER_API_KEY` |
| 24 | moonshot-cn | `https://api.moonshot.cn` | `/v1/chat/completions` | 401 | `MOONSHOT_CN_API_KEY` |
| 25 | tuningengines | `https://api.tuningengines.com` | `/v1/chat/completions` | 401 | `TUNING_ENGINES_API_KEY` |

† **Non-OpenAI error shape.** Parasail returns `Unauthorized. Invalid token.` as plain text
under a `application/json` content-type; Writer returns `{"tpe":"fail.auth","errors":[…]}`.
Both check credentials at the right path, so routing and auth work. The only degradation is
that a failure message reaches the user less prettily than an OpenAI-shaped one. Recorded
rather than hidden.

## Excluded — 5 vendors, with reasons

| Name | Verdict | Evidence |
|---|---|---|
| nvidia | `path-missing` | `integrate.api.nvidia.com/v1/chat/completions` returned `404 page not found` as `text/plain`, **byte-identical to the bogus sibling path** — a catch-all. Alternate host `ai.api.nvidia.com/v1/gr` behaved the same. Correct host not found without an account. |
| gmi | `path-missing` | `No matching target server found for model …` as `text/plain`, identical to the bogus sibling. Catch-all. |
| targon | `gone` | HTTP **410 Gone** — the service has been discontinued at this endpoint. |
| lambda | `unreachable` | `api.lambda.ai` and `api.lambdalabs.com` both return **no DNS records**. Stated as measured; this is a resolution failure from here, not proof the company is gone. |
| kluster | `unreachable` | `api.kluster.ai` returns **no DNS records**. Same caveat. |

## Notes that affect the design

1. **Two API-path shapes exist in the wild.** DeepInfra (`/v1/openai` + `/chat/completions`),
   Novita (`/v3/openai` + `/chat/completions`) and Perplexity (`/chat/completions`, no `/v1`)
   do not use the default. The catalog schema must express `apiPath` per entry — a fixed
   `/v1/chat/completions` would silently break 3 of 25.

2. **`tuningengines` is real and authenticates.** This is the vendor from PR #136, which
   proposed a full built-in provider (definition + profile + transport). It qualifies for the
   catalog as a single data row, which is a far better outcome for that PR than closing it:
   the contributor's vendor ships, without the two-table coupling risk.

3. **No shipped name collides with a built-in provider name** (checked against all 32 in
   `provider-definitions.ts`). Shortcut collisions cannot be ruled out by inspection, so R6
   must be enforced in code against the live registry rather than by this table.

4. **Everything here is `format: "openai"`.** No candidate required the `anthropic` transport,
   and none required `gemini`/`ollamacloud` (which the loader does not support anyway).
