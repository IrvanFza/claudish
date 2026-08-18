# Error-shape probe — parasail and writer

Measured 2026-08-14. Bodies fetched live with a deliberately
invalid bearer token; every verdict below comes from calling claudish's own
classifier functions on the captured body, not from reading them.

## parasail

- HTTP status: **401**
- content-type: `application/json;charset=ISO-8859-1`
- body: `Unauthorized. Invalid token.\n`
- `JSON.parse` succeeds: **false** (composed-handler catches; no crash path)
- `extractProviderMessage` → `Unauthorized. Invalid token.\n`
- `isTerminalError` → **true** (remapped to HTTP 400, surfaced inline)
- surfaced line the user sees:

  ```
  Parasail error (HTTP 401): Check API key / OAuth credentials. — Unauthorized. Invalid token.
  ```
- `ensureAnthropicErrorFormat` → `{"type":"error","error":{"type":"api_error","message":"Unauthorized. Invalid token."}}`
- `isRetryableError` (chain level) → **true** — the fallback chain advances to the next candidate
- in-stream retry ladder (3s/15s/30s) reachable: **no** — it is gated on HTTP 200 + stream format openai-responses-sse|devin; this row is openai-sse and answered HTTP 401

## writer

- HTTP status: **401**
- content-type: `application/json`
- body: `{"tpe":"fail.auth","errors":[{"description":"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =<redacted: sha256 of the invalid probe key>. Unable to find token in cache or `LiteLLM_VerificationTokenTable`","key":"fail.auth.generic","extras":"key"}],"extras":null}`
- `JSON.parse` succeeds: **true** (composed-handler catches; no crash path)
- `extractProviderMessage` → `{"tpe":"fail.auth","errors":[{"description":"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =<redacted: sha256 of the invalid probe key>. Unable to find token in cache or `LiteLLM_VerificationTokenTable`","key":"fail.auth`
- `isTerminalError` → **true** (remapped to HTTP 400, surfaced inline)
- surfaced line the user sees:

  ```
  Writer error (HTTP 401): Check API key / OAuth credentials. — {"tpe":"fail.auth","errors":[{"description":"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =<redacted: sha256 of the invalid probe key>. Unable to find token in cache or `LiteLLM_VerificationTokenTable`","key":"fail.auth.generic","extras":"key"}],"extras":null}
  ```
- `ensureAnthropicErrorFormat` → `{"type":"error","error":{"type":"authentication_error","message":"{\"tpe\":\"fail.auth\",\"errors\":[{\"description\":\"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =<redacted: sha256 of the invalid probe key>. Unable t`
- `isRetryableError` (chain level) → **true** — the fallback chain advances to the next candidate
- in-stream retry ladder (3s/15s/30s) reachable: **no** — it is gated on HTTP 200 + stream format openai-responses-sse|devin; this row is openai-sse and answered HTTP 401

## groq

- HTTP status: **401**
- content-type: `application/json`
- body: `{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}\n`
- `JSON.parse` succeeds: **true** (composed-handler catches; no crash path)
- `extractProviderMessage` → `Invalid API Key`
- `isTerminalError` → **true** (remapped to HTTP 400, surfaced inline)
- surfaced line the user sees:

  ```
  Groq error (HTTP 401): Check API key / OAuth credentials. — Invalid API Key
  ```
- `ensureAnthropicErrorFormat` → `{"type":"error","error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}`
- `isRetryableError` (chain level) → **true** — the fallback chain advances to the next candidate
- in-stream retry ladder (3s/15s/30s) reachable: **no** — it is gated on HTTP 200 + stream format openai-responses-sse|devin; this row is openai-sse and answered HTTP 401

## Verdict

**Both vendors are correctly classified as TERMINAL, and no retry budget is burned.**
The claim in `research.md` — "the only degradation is that a failure message reaches
the user less prettily" — survives the examination, for reasons that are structural
rather than lucky.

### Why the classification cannot go wrong here

Every load-bearing decision for these two bodies is made on the HTTP **status**, not on
the body shape:

| Decision | Function | Input used | Result |
|---|---|---|---|
| terminal vs transient | `isTerminalError` | `status === 401` → `true`, first line of the function | terminal for both |
| status the client sees | composed-handler step 7 | terminal → `400 invalid_request_error`, message surfaced inline | no "API error · Retrying" banner |
| chain advance | `isRetryableError` | `status === 401` → `true` | next candidate is tried, as for any vendor |
| in-stream 3s/15s/30s ladder | `settleResponsesStreamHead` / `settleDevinStreamHead` | gated on **HTTP 200** and stream format `openai-responses-sse` / devin | structurally unreachable: these rows are `openai-sse` and answered 401 |

So the specific failure the review was worried about — a terminal auth failure treated
as retryable and burning 48s of backoff — cannot occur for either vendor. It could only
occur for a body that arrives *inside an HTTP 200*, and that path is not wired for the
`openai-sse` stream format at all.

### The body shape is never trusted anywhere

`composed-handler.ts` reads `await response.text()` and then attempts `JSON.parse` inside
a `try/catch`, so a body that is not JSON produces `parsedErrorBody = undefined` and the
code falls back to `{ error: { type: "api_error", message: errorText } }`. Parasail's
reply is the interesting case precisely because its `content-type` **lies** — it says
`application/json;charset=ISO-8859-1` over plain text — and claudish never consults the
content-type, so the lie costs nothing. Measured above: `JSON.parse succeeds: false`, no
throw escapes, and the rendered line is clean.

### What is actually degraded, stated precisely

1. **Writer's surfaced message is the whole JSON document.** `extractProviderMessage`
   looks for `error.message` / `message` / `error` / `error.detail` / `detail` and
   Writer supplies none of them (its message lives at `errors[0].description`), so the
   function falls through to `JSON.stringify(body)`. The user sees ~450 characters
   including a key hash instead of one sentence. It is bounded — `buildSurfacedErrorMessage`
   truncates at 600 chars — and it does contain the real reason, so this is legibility,
   not information loss.
2. **`providerErrorType` is `undefined` for both.** composed-handler reads
   `parsed?.error?.type || parsed?.type || parsed?.code`; parasail is not JSON at all and
   Writer nests its code at `errors[0].key`. Consequence is confined to telemetry
   granularity (`report_error`, `recordStats`) — no user-visible behaviour depends on it.
3. **Parasail is arguably *better* than OpenAI-shaped.** `Unauthorized. Invalid token.`
   renders as a complete sentence; the control row (groq) renders `Invalid API Key`. The
   "less prettily" concern applies to Writer, not to Parasail.

### One thing worth knowing that the shape gave away

Writer's error names `LiteLLM_VerificationTokenTable`. Its OpenAI-compatibility endpoint
is a **LiteLLM proxy**, which means the odd `{"tpe":…,"errors":[…]}` envelope is Writer's
own auth gateway in front of it; body shapes past the auth boundary are likely to be
LiteLLM's — i.e. OpenAI-shaped. This is an observation from one measured response, not a
verified claim about the served path, and nothing in the catalog depends on it.

### Recommendation

**Keep both rows.** Neither misclassifies, neither burns a retry, neither can crash a
parse, and the degradation is one long line for one vendor.

**Optional follow-up, not done here** (it is a change to shared error code, outside the
"one data row" boundary this feature is being judged on): teach `extractProviderMessage`
about `errors[0].description` / `errors[0].message`. That is a two-line addition to the
existing `candidates` array in `handlers/shared/anthropic-error.ts` and would make
Writer's line read as one sentence. It should be judged on its own merits — the array
already carries a FastAPI-specific `detail[].msg` case, so the precedent exists — and
NOT bundled into the catalog fill.
