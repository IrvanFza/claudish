# Grok Build subscription — verified protocol spec

Reverse-engineering write-up for the `grok-subscription` provider (`gk@`), which serves
xAI's Grok models against the user's **SuperGrok / X Premium+** subscription instead of
the metered `XAI_API_KEY` path that the existing `x-ai` provider uses.

Every fact below was measured live on 2026-08-18 against a real signed-in account.
Nothing here is inferred from documentation alone; where something is unverified it says so.

## Why this provider exists

`x-ai` is metered: `XAI_API_KEY` → `api.x.ai/v1/chat/completions`, billed per token.
xAI also ships **Grok Build**, a first-party CLI (`curl -fsSL https://x.ai/cli/install.sh | bash`)
whose inference is covered by a SuperGrok or X Premium+ subscription. Same models, different
billing. This is the same subscription-vs-metered split claudish already models for
GLM (`gc@` vs `glm@`), MiniMax (`mmc@` vs `mm@`), Qwen (`qc@` vs `qp@`) and Sakana (`sc@` vs `sakana@`).

## Credentials — claudish's OWN OAuth, with the CLI's token as a fallback

Two independent sources, in preference order:

1. **`claudish login grok`** → `~/.claudish/grok-oauth.json`. No Grok CLI required.
2. **The Grok CLI's `~/.grok/auth.json`**, reused verbatim when present.

### Why claudish can own this flow (and could not for Antigravity)

The difference is structural, not a matter of effort. Antigravity goes through the vendor CLI
because Google registered its client as **confidential**: the `GOCSPX-…` secret rotates, cannot be
shipped in an npm package, and is therefore extracted from the user's own local `agy` binary at
runtime. xAI registered the Grok CLI as a **public** client — `auth.x.ai`'s discovery document
lists `"none"` in `token_endpoint_auth_methods_supported`, the correct registration for a CLI
precisely because a widely-distributed secret is not a secret. There is nothing to rotate, so
nothing to chase.

The client id (`b1a00492-073a-47ea-816f-4c329264a828`) is **published by xAI** in their own
installer as `OIDC_SCOPE="https://auth.x.ai::b1a00492-…"`. claudish prefers the id found in a local
`auth.json` when one exists, so a rotation is absorbed without a release.

**RFC 8628 device flow**, not authorization-code + loopback: claudish frequently runs where a
localhost redirect cannot be received — an MCP child, a `team` fan-out, a remote shell — and the
device grant is the one that works in all of them. `POST /oauth2/device/code` →
`POST /oauth2/token` polling. `slow_down` must raise the interval **permanently** (RFC 8628 §3.5);
a one-shot bump is rejected again on the next iteration.

### The scope trap — a clean login is NOT a working credential

This cost a full round trip and is the single most transferable lesson here.

An earlier version requested a sensible-looking subset of the issuer's advertised
`scopes_supported`: `openid profile email offline_access grok-cli:access`. **Login succeeded.** The
IdP issued a token, claudish wrote it to disk at mode 0600, and printed "login successful". Every
subsequent inference request then failed:

```
403 {"code":"permission-denied","error":"OAuth2 token missing required scope: api:access"}
```

The authorization server and the resource server disagree about what a usable token looks like, and
**only the resource server's opinion matters**. The fix was to stop guessing from
`scopes_supported` and read the `scope` claim out of the CLI's actually-working token:

```
openid profile email offline_access grok-cli:access api:access
conversations:read conversations:write workspaces:read workspaces:write
```

`offline_access` is separately load-bearing — without it no refresh token is issued, and a 6-hour
access token with no refresh means re-authenticating three times a day. Note `team:read`,
`org:read` and `grok-plugins:access` are advertised but absent from the CLI's token, so claudish
does not request them: matching the CLI is the known-good configuration, and asking for authority
we do not need is the wrong default.

**Verified live**: after the scope fix, a token minted by `claudish login grok` returned `OAUTH_OK`
from `/v1/chat/completions`, and `resolveGrokAccessToken()` was confirmed to resolve from
claudish's own store rather than the CLI's file. Minting a claudish token did **not** invalidate
the existing `grok` CLI session — xAI issues independent tokens per authorization (the CLI's token
still answered 200 afterwards).

### The client-version header when no CLI is installed

The proxy's `x-grok-client-version` gate is a **minimum**, so a shipped constant works only until
xAI raises that floor — after which every request 426s and the fix needs a claudish release. With
no local install there is no version to read, so claudish reads the same channel pointer xAI's own
installer reads: `https://x.ai/cli/stable` (plain text, currently `1.0.5`), cached per process,
shape-validated so an HTML error page can never be signed into a header. Local install → live
pointer → constant.

## The Grok CLI's token format (fallback source)

`grok login` writes `~/.grok/auth.json`, mode 0600. Shape:

```json
{
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    "key": "<JWT access token, ~882 chars, starts eyJ0eXAi>",
    "refresh_token": "<~86 chars>",
    "expires_at": "2026-08-18T04:50:04.747677Z",
    "create_time": "2026-08-17T22:50:04.747677Z",
    "auth_mode": "oidc",
    "oidc_issuer": "https://auth.x.ai",
    "oidc_client_id": "b1a00492-073a-47ea-816f-4c329264a828",
    "principal_type": "User",
    "principal_id": "...", "user_id": "...", "team_id": "...",
    "email": "...", "first_name": "...", "last_name": "..."
  }
}
```

The top-level key is a **scope string**, not a fixed name. Two scopes exist:

| Scope | Meaning |
|---|---|
| `https://auth.x.ai::<client_id>` | OIDC (current). This is what `grok login` writes today. |
| `https://accounts.x.ai/sign-in` | Legacy. Still parsed by xAI's installer; not observed live. |

xAI's own installer resolves auth in the order **`GROK_DEPLOYMENT_KEY` env > OIDC scope > legacy
scope**, so claudish mirrors that precedence rather than inventing one.

**Do not hardcode the scope string.** The client_id is embedded in it and can rotate. Select the
entry by `auth_mode === "oidc"`, falling back to the legacy scope key, falling back to the single
entry when only one exists.

### Token lifetime is 6 hours — refresh is mandatory

Measured: `create_time` 22:50:04Z → `expires_at` 04:50:04Z, exactly 6h. A claudish session
routinely outlives that, so a read-only credential provider (the Devin pattern) is **not**
sufficient here.

Refresh is a standard OIDC public-client refresh. From `https://auth.x.ai/.well-known/openid-configuration`:

```json
{ "token_endpoint": "https://auth.x.ai/oauth2/token",
  "grant_types_supported": ["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic","client_secret_post","none"] }
```

`"none"` is present, so the client is **public — no client secret is required**. This is strictly
simpler than Antigravity, which has to extract a client_id/secret pair out of the user's local `agy`
binary at runtime. Here the `client_id` is a field in the credential file itself.

Refresh request (form-encoded):

```
POST https://auth.x.ai/oauth2/token
grant_type=refresh_token&refresh_token=<rt>&client_id=<oidc_client_id from the file>
```

Probed with a deliberately invalid refresh token, the endpoint answers the standard OAuth error
shape, which confirms the contract without consuming the real token:

```json
{"error":"invalid_grant","error_description":"Invalid or unknown refresh token"}
```

**Write-back is required and must be atomic.** OIDC servers may rotate the refresh token on use.
Refreshing without persisting the result would leave the user's own `grok` CLI holding a dead
refresh token — claudish would have broken a tool it does not own. This is the same shared-store
obligation Antigravity has with the `agy` keychain item.

As implemented: read-modify-write of the WHOLE file (so unrelated scopes and fields survive),
then temp-file + `rename`, mode 0600. The rename is what guarantees a crash mid-write can never
leave a truncated credential file.

**Known limitation — the CLI's `auth.json.lock` is NOT honoured.** The Grok CLI maintains a
sibling lock file; claudish does not take it. The atomic rename means neither process can observe
a corrupt file, so the residual risk is a *lost update*: if the CLI refreshes at the same instant,
one of the two valid tokens overwrites the other. The loser simply refreshes again on next use.
Worth revisiting if a concurrent-refresh failure is ever observed in the wild; not worth
cross-process file locking on speculation.

## Transport

Base URL `https://cli-chat-proxy.grok.com/v1` — taken from the served model records' own
`base_url` field, and from the installer's `GROK_PROXY_URL` default. It is overridable there,
so treat `GROK_PROXY_URL` as a base-URL override.

### Required client-identity headers

The proxy enforces a **minimum CLI version**. Without these headers every request fails, on both
surfaces, with HTTP 200-shaped JSON:

```json
{"error":"Your Grok CLI version (none) is outdated. Please update to version 0.1.202 or later via `grok update` ..."}
```

Header names recovered from the shipped binary (`strings`, adjacent to the literals `1.0.4`,
`grok-shell`, `cli-chat-proxy`):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <key>` |
| `x-grok-client-version` | the installed CLI version, e.g. `1.0.4` |
| `x-grok-client-identifier` | `grok-shell` |

Also present in the binary but not required for inference: `x-grok-client-mode`,
`x-grok-deployment-id`, `x-grok-user-id`.

**Read the version from the local install, do not pin `1.0.4`.** The gate is a *minimum*, and the
user's CLI self-updates. `~/.grok/version.json`, `~/.grok/models_cache.json`'s `grok_version`, and
`grok --version` all carry it. Pinning a literal guarantees a future silent breakage of exactly the
kind this gate is designed to cause.

### Two working surfaces — use Chat Completions

Both verified live with a real token:

| Path | Result |
|---|---|
| `POST /v1/chat/completions` | works — standard OpenAI shape |
| `POST /v1/responses` | works — OpenAI Responses shape (`output[]` with `reasoning` + `message`) |

The served model records declare `api_backend: "responses"`, which is what the CLI itself uses.
**Claudish should nonetheless use `/v1/chat/completions`**, because claudish already has a Layer-2
`GrokAdapter` (model dialect, reasoning-effort mapping) that applies on the Chat Completions path
only. Choosing `responses` would route through the Codex adapter and strand that existing work,
for no measured benefit.

Non-streaming response (note `reasoning_content`, the same field GLM uses, already handled by
claudish's `openai-sse` parser):

```json
{"object":"chat.completion","model":"grok-4.6-build",
 "choices":[{"message":{"role":"assistant","content":"OK","reasoning_content":"..."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":210,"completion_tokens":1,"total_tokens":323,
          "prompt_tokens_details":{"cached_tokens":128},
          "completion_tokens_details":{"reasoning_tokens":112},
          "cost_in_usd_ticks":1540200}}
```

Streaming is ordinary OpenAI SSE (`chat.completion.chunk`) with `delta.reasoning_content`,
verified with `stream: true`. `reasoning_effort` is accepted as a request parameter.

**Tool calling is standard OpenAI**, verified live — the proxy accepted a `tools` array and
answered with `content: ""` plus:

```json
"tool_calls":[{"id":"call-f7109ccf-…-0","type":"function",
               "function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]
```

which is exactly the shape `openai-sse.ts` already consumes. This mattered enough to test
separately: Claude Code sends tools on essentially every request, so a provider that could not
tool-call would be useless regardless of how well plain completion worked.

The `model` field echoes back as **`grok-4.6-build`** even when `grok-4.6` was requested — a
server-side alias. Do not treat the echoed id as the routing id.

`usage.cost_in_usd_ticks` is reported but is **not** money the user pays per token; billing is the
flat subscription. It must not be fed to TokenTracker as spend.

## Model roster — live discovery only, never hardcoded

`GET /v1/models` is **authenticated** (401 without a token — unlike Alibaba's `coding-intl` roster,
where a 200 proves nothing). Response is OpenAI-shaped `{object, data:[{id,...}]}`.

Measured on this account: `grok-4.6`, `grok-4.5`. That is an account-scoped set and will drift, so
it is discovered, not pinned.

The CLI caches the same data at `~/.grok/models_cache.json`, including per-model metadata worth
consuming (`origin` confirms the roster endpoint, and the record carries an `etag` for conditional
requests):

| Field | grok-4.6 | grok-4.5 |
|---|---|---|
| `context_window` | 500000 | 500000 |
| `supports_reasoning_effort` | true | true |
| `reasoning_efforts` | `xhigh, high, medium, low` | `high, medium, low` |
| `auth_scheme` | `bearer` | `bearer` |
| `api_backend` | `responses` | `responses` |

**The effort sets differ per model** — `grok-4.6` has `xhigh`, `grok-4.5` does not. This is exactly
the per-account, drifting data CLAUDE.md forbids hardcoding: derive the effort ladder from the
served record, and degrade an unsupported tier to the model's own strongest available one rather
than sending a value the backend will reject.

The 500K context window matters beyond display: `resolveContextWindowEnv()` must set both
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or Claude Code silently
clamps the session to its hardcoded 200K fallback and compacts at ~170K.

## Routing and provider identity

- Provider name `grok-subscription`, shortcut `gk@`. The existing `x-ai` keeps `grok@` so no
  existing command changes meaning.
- **`apiKeyEnvVar` MUST be `""`**, with a dedicated `CredentialProvider` plus transport-side
  `credentials.getRequestAuth()`. proxy-server's generic extraction block runs only for a non-empty
  value and derives the key by stripping `Bearer ` from `auth.headers.Authorization`; a provider
  that does not fit that shape yields `""` → `return null` → the handler is never built and the
  model **silently falls through to OpenRouter**. Same rule as Devin and Antigravity.
- **Do not alias `XAI_API_KEY`.** That key is the metered `x-ai` credential. Aliasing it here would
  let a metered key authenticate a provider claudish reports as flat-rate — the precise ambiguity
  that keeps `openai-codex` out of `SUBSCRIPTION_PROVIDERS`.
- **Bare-name routing is subscription-first**, matching every other split provider: the `grok-*`
  chain becomes `["grok-subscription", "x-ai", "openrouter"]`. A user holding both credentials is
  never silently billed per token for a model their subscription already covers. This is safe here,
  and *not* the Devin/Qwen-Plan situation, because Grok's model namespace belongs to xAI — there is
  no collision with another vendor's ids.
- **`grok-subscription` DOES belong in `SUBSCRIPTION_PROVIDERS`** — provided v1 supports only the
  `auth.json` subscription token. It has no metered credential path, so unlike `openai-codex` it is
  not dual-mode and the flat-rate answer is unambiguous. `GROK_DEPLOYMENT_KEY` (enterprise) is
  deliberately out of scope for v1 precisely because it would reintroduce that ambiguity.

## Failure modes to handle

| Condition | Correct behaviour |
|---|---|
| No `~/.grok/auth.json` | **Terminal** error naming `grok login`. Not a 401 — a 401 sends Claude Code into ~11 rounds of "API error · Retrying" over a condition that cannot self-heal. |
| Token expired, refresh succeeds | Transparent; persist the rotated token. |
| Token expired, refresh fails (`invalid_grant`) | Terminal, naming `grok login` to re-authenticate. |
| Missing/old client-version header | Surfaces as an `error` JSON body. Detect and rewrite to an actionable message naming `grok update`. |
| Unserved model id | Verify against the live roster before blaming the credential. |

## Evidence tier

**live** — a real turn was driven against the real backend with a real subscription token, on both
surfaces, streaming and non-streaming, plus an authenticated roster fetch. The refresh contract is
**probe** tier only: confirmed by the `invalid_grant` response to a deliberately bogus refresh
token, because exercising the real one risks rotating the user's working CLI session out from under
them. Refresh must be re-verified live once write-back is implemented.
