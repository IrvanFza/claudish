> Gemini on an Antigravity subscription: shared keychain token, runtime client-secret extraction, live model discovery.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Antigravity Provider (`ag@`) — Gemini via your Antigravity subscription

Two separate Gemini flows, deliberately split:

| Flow | Prefix | Auth | Backend | Billing |
|---|---|---|---|---|
| Direct Gemini API | `g@` / `google@` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | pay-per-use |
| **Antigravity** | `ag@` / `antigravity@` | your Antigravity OAuth token (shared with the `agy` CLI) | `cloudcode-pa.googleapis.com/v1internal` | your Antigravity subscription (free / Pro / Ultra) |

`go@` is a **deprecated alias → `ag@`**. Google retired the old "Gemini Code Assist for individuals" tier for gemini-cli's OAuth client (`UNSUPPORTED_CLIENT`); that product is dead, so `go@` now routes to Antigravity with a one-line deprecation notice.

**The `gemini-codeassist` provider was fully REMOVED (v7.36.0)** — definition, transport, credential provider, OAuth registration, quota adapter, probe entry, and the `--gemini-login`/`--gemini-logout` flags. It could not authenticate for any consumer account, yet it sat FIRST in the `gemini-*` routing chain, so every bare `gemini-*` name paid a guaranteed-failing round-trip before falling through to the metered `google` API — silently billing per-token for a model the user's subscription already covered. The chain is now `["antigravity", "google", "openrouter"]`, matching the subscription-first convention every other family already follows. A leftover `~/.claudish/gemini-oauth.json` no longer reads as a live credential (its `oauth-registry.ts` entries are gone), which is what kept a dead provider in the config TUI's Test All list.

The Antigravity half of the old `auth/gemini-oauth.ts` was extracted to **`auth/antigravity-user.ts`** (project/tier resolution, `retrieveUserQuota`, live served-set discovery) before that file was deleted — Antigravity depends on it, so deleting wholesale would have taken `ag@` down too. `retrieveUserQuota` deliberately keeps the gemini-cli User-Agent it was written with: that exact call is verified working on Ultra, and `loadCodeAssist` is known to gate on identity, so changing it is a live experiment, not a tidy-up.

**Why not just spoof the identity:** the backend has two independent gates. `loadCodeAssist` gates the visible *tier* on request identity (`User-Agent` + `metadata.ideType: ANTIGRAVITY`), but `streamGenerateContent` gates *generation* on the OAuth **client that minted the token** — headers can't fake it (403 PERMISSION_DENIED). So claudish does not spoof; it **reuses the user's own Antigravity token**.

**Token lifecycle** (`auth/antigravity-token.ts`, macOS):
- **Shared store**: the same keychain item the `agy` CLI uses — `service=gemini, account=antigravity`, value `go-keyring-base64:<base64(JSON)>` (zalando/go-keyring). claudish reads AND writes it, so both tools reuse one live token.
- **Self-refresh**: when the token is expired, POST `oauth2/token` with `grant_type=refresh_token`. The Antigravity client_id/secret are **never shipped** — they're extracted at runtime from the user's own local `agy` binary (`strings` for the `…apps.googleusercontent.com` id + `GOCSPX-` secret; the working combo is discovered by first-200 and cached). The refreshed (and possibly rotated) token is written back to the shared store.
- **Degradation**: no store (agy not installed / not signed in) or non-macOS → actionable error pointing at `g@` + `GEMINI_API_KEY`.

**Model ids — LIVE discovery, no hardcoded map**: the Antigravity backend requires a reasoning-tier suffix (bare `gemini-3.6-flash` → 404), but which variants a subscription serves is **per-account and drifts**, so claudish never hardcodes a roster. `getServedAntigravityModels()` fetches the live set from the backend's own `v1internal:fetchAvailableModels` (body `{project}`) — the served ids are the response `models` keys, plus a backend `defaultAgentModelId` — cached with a TTL. `resolveAntigravityModelId(requested, servedIds, defaultId)` then resolves against that LIVE set: exact match passes through; a bare family (e.g. `gemini-3.6-flash`) resolves to the backend's `defaultAgentModelId` when it's a variant of that family, else to the strongest reasoning tier by a *rank rule* (`high>medium>low>extra-low>tiered` — a rule, like `rankCodeAssistModel`, not pinned ids); anything else passes through to the F1–F7 404 rewrite. The only literals are the tier-rank ordering and endpoint strings — no concrete model ids in source.

**Identity strings**: `User-Agent: antigravity/cli/<ver> (aidev_client; os_type=<platform>; arch=<arch>; auth_method=consumer)` + `metadata: { ideType: "ANTIGRAVITY" }`. The transport keeps all the F1–F7 improvements from the old codeassist path (terminal-error → 400 surfaced inline, served-set-aware 404 rewrite, `rankCodeAssistModel`). Full reverse-engineering write-up: `ai-docs/sessions/antigravity-refactor-20260803-125333-d0791562/architecture.md` (write-up lost — predates the ai-docs tracking fix).
