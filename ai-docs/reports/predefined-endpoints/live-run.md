# C1 — Live end-to-end validation, predefined custom endpoints

**Date:** 2026-08-14
**Branch:** `feat/predefined-custom-endpoints`
**Worktree:** `/Users/jack/mag/claudish/.claude/worktrees/pull-requests`
**Binary under test:** the LOCAL worktree build, invoked as
`bun run packages/cli/src/index.ts …` — never the globally installed `claudish`.

## Which binary?

Both the local build and the global install print `claudish version 7.48.0` (the version constant
was not bumped on this branch), so the version string alone cannot distinguish them. The
distinguishing check is the feature itself:

```
$ which claudish
/Users/jack/.bun/bin/claudish
$ grep -rl "tuningengines" /Users/jack/.bun/install/global/node_modules/claudish/
   (no output — the bundled catalog does not exist in the global install)
$ grep -n "tuningengines" packages/cli/src/providers/predefined-catalog.ts
337:    name: "tuningengines",
```

The global 7.48.0 has no `tuningengines` string anywhere in it. Every command below therefore ran
against the worktree source through `bun run packages/cli/src/index.ts`.

## Setup

`OPENAI_API_KEY` was confirmed present in the environment before starting — **set: true, length:
164**. Its value is never printed here or anywhere in this document.

The shipped catalog row used as the vehicle (`packages/cli/src/providers/predefined-catalog.ts:337`):

```ts
name: "tuningengines",
displayName: "Tuning Engines",
baseUrl: "https://api.tuningengines.com",
apiPath: "/v1/chat/completions",
format: "openai",
apiKeyEnvVar: "TUNING_ENGINES_API_KEY",
baseUrlEnvVars: ["TUNING_ENGINES_BASE_URL"],
```

Its `apiPath` is byte-identical to OpenAI's, so pointing `TUNING_ENGINES_BASE_URL` at
`https://api.openai.com` and feeding it a real OpenAI key exercises the complete predefined-endpoint
path against a real vendor **with no source change at all**. No file in the repository was modified
for this run.

Env used for tests 2–5 (key redacted):

```bash
export TUNING_ENGINES_API_KEY="<OPENAI_API_KEY — redacted, 164 chars>"
export TUNING_ENGINES_BASE_URL="https://api.openai.com"
```

---

## Test 1 — the endpoint is INVISIBLE without a credential

**PASS**

Command (both variables confirmed unset via `printenv` beforehand — no output for either):

```bash
bun run packages/cli/src/index.ts --probe tuningengines@gpt-4o-mini
```

Output (ANSI stripped):

```
┌─ tuningengines@gpt-4o-mini ────────────────────── tuningengines · 0/1 live ─┐
│                                                                             │
│  # │ Provider      │ Model Spec                              │ Status       │
├────┼───────────────┼─────────────────────────────────────────┼──────────────┤
│  1 │ tuningengines │ tuningengines@tuningengines@gpt-4o-mini │ ⊗ error 400  │
│      └ Explicit model "tuningengines@gpt-4o-mini" could not be routed —      │
│        its provider has no credential. No API key for provider              │
│        "tuningengines".                                                     │
│                                                                             │
│  Key  —                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

The row never registers as a usable provider: the request is refused at the credential gate with
`No API key for provider "tuningengines"`, and nothing is sent anywhere. This is R-gate working as
designed — a bundled row is inert until the user's own machine holds its key.

*(Cosmetic observation, not a failure: the probe's "Model Spec" column renders the prefix twice —
`tuningengines@tuningengines@gpt-4o-mini`. It is a display concatenation in the probe table; the
actual outbound request in Test 3 carries the correct bare model id, as the debug log shows.)*

---

## Test 2 — the endpoint APPEARS with a credential

**PASS**

Command:

```bash
export TUNING_ENGINES_API_KEY="<redacted>"
export TUNING_ENGINES_BASE_URL="https://api.openai.com"
bun run packages/cli/src/index.ts --probe tuningengines@gpt-4o-mini
```

Output (ANSI stripped):

```
  Leaderboard — fastest model first
      MODEL                     PROVIDER      TIMELINE                    TOTAL      tok/s
  1 ● tuningengines@gpt-4o-mini tuningengines                             5.47s     52 t/s
  ────────────────────────────────────────────────────────────────────────────────────────
  Details — per-model routing chains
┌─ tuningengines@gpt-4o-mini ────────────────────── tuningengines · 0/1 live ─┐
│                                                                             │
│  # │ Provider      │ Model Spec                              │ Status       │
├────┼───────────────┼─────────────────────────────────────────┼──────────────┤
│  1 │ tuningengines │ tuningengines@tuningengines@gpt-4o-mini │ ✓  5.47s  ●  │
│                                  5.47s     52 t/s                           │
│                                                                             │
│  Key  —                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Machine-readable form, same env:

```bash
bun run packages/cli/src/index.ts --probe tuningengines@gpt-4o-mini --json
```

```json
[
  {
    "model": "tuningengines@gpt-4o-mini",
    "nativeProvider": "tuningengines",
    "isExplicit": true,
    "routingSource": "direct",
    "chain": [],
    "directProbe": {
      "state": "live",
      "latencyMs": 2864,
      "timing": {
        "ttfbMs": 2103,
        "ttftMs": 2147,
        "totalMs": 2864,
        "tokens": 58,
        "tokensPerSec": 80.89260808926082
      }
    }
  }
]
```

### The anti-criterion

`nativeProvider` is **`tuningengines`**. `routingSource` is `direct` and `chain` is `[]` — the
explicit spec short-circuits routing entirely, so there is no fallback list to be silently walked.
The single chain row names `tuningengines`. **No OpenRouter, and not the builtin `openai`
provider.** The proof that the base-URL override was honoured rather than merely accepted is the
debug-log line in Test 3.

Note on the probe surface itself: the current `--probe` TUI reports the routing chain and live
liveness/timing, not a transport / format-adapter / stream-format composition table. That
composition is instead visible in the debug log of Test 3, which shows the OpenAI Chat Completions
path (`[SSE:openai]` frames parsed by the openai-sse parser) reached through the `Tuningengines`
provider.

---

## Test 3 — a REAL TURN

**PASS**

First attempt used `gpt-4o-mini` and failed for a reason worth recording, because it is itself
evidence:

```bash
bun run packages/cli/src/index.ts --model tuningengines@gpt-4o-mini -d --quiet \
  "Reply with exactly the word BANANA and nothing else."
```

```
[claudish] Error [Tuningengines]: HTTP 400. Input too large. Reduce message history or use a
larger-context model. (max_tokens is too large: 32000. This model supports at most 16384
completion tokens, whereas you provided 32000.)
API Error: 400 max_tokens is too large: 32000. This model supports at most 16384 completion
tokens, whereas you provided 32000.
EXIT_CODE=1
```

That is OpenAI's own validation message for `gpt-4o-mini`, surfaced under the `[Tuningengines]`
provider label — i.e. the request genuinely reached OpenAI through the predefined endpoint. The
16384-token ceiling is a property of `gpt-4o-mini`, unrelated to this feature. Re-run against
`gpt-4.1-mini` (32768 output tokens):

```bash
bun run packages/cli/src/index.ts --model tuningengines@gpt-4.1-mini -d --quiet \
  "Reply with exactly the word BANANA and nothing else."
```

```
=== STDOUT BEGIN ===
BANANA
=== STDOUT END ===
EXIT_CODE=0
```

Real model output, exit code 0.

### The extracted request URL — the proof

From `logs/claudish_2026-08-14_02-28-25.log`, line 25, verbatim:

```
[2026-08-14T02:28:27.946Z] [Tuningengines] Calling API: https://api.openai.com/v1/chat/completions
```

Surrounding lines from the same log, showing the full round trip and the stream dialect:

```
[2026-08-14T02:28:27.939Z] [behavior] 1 rule(s) active for gpt-4.1-mini: plan-mode/plan-file-path=fix
[2026-08-14T02:28:27.946Z] [Tuningengines] Calling API: https://api.openai.com/v1/chat/completions
[2026-08-14T02:28:30.324Z] [Tuningengines] Response status: 200
[2026-08-14T02:28:30.324Z] [Streaming] ===== HANDLER STARTED for gpt-4.1-mini =====
[2026-08-14T02:28:30.345Z] [SSE:openai] {"id":"chatcmpl-ECbwi2hGLzgrXOQHOvXMBUONyKKty", … "model":"gpt-4.1-mini-2025-04-14", … }
[2026-08-14T02:28:30.378Z] [SSE:openai] { … "delta":{"content":"BAN"} … }
[2026-08-14T02:28:30.378Z] [Streaming] Text chunk: "BAN" (3 chars)
```

The URL is `https://api.openai.com/v1/chat/completions` — the overridden base URL joined to the
catalog row's own `apiPath`. The upstream model echoed back by OpenAI is
`gpt-4.1-mini-2025-04-14`, and the stream was parsed by the `openai-sse` parser.

The earlier `gpt-4o-mini` attempt logged the identical URL at
`logs/claudish_2026-08-14_02-28-04.log:25`:

```
[2026-08-14T02:28:07.145Z] [Tuningengines] Calling API: https://api.openai.com/v1/chat/completions
```

---

## Test 4 — the R12 malformed-override refusal

**PASS**

```bash
export TUNING_ENGINES_API_KEY="<redacted>"
export TUNING_ENGINES_BASE_URL="htp://not-a-url:9999"
bun run packages/cli/src/index.ts --probe tuningengines@gpt-4.1-mini --json
```

Warning on stderr, verbatim:

```
[claudish] predefined endpoint 'tuningengines' skipped: TUNING_ENGINES_BASE_URL is set to
'htp://not-a-url:9999', which is not a valid http(s) URL. Fix or unset it. (Not falling back to
https://api.tuningengines.com — the override was set on purpose.)
```

And the probe result:

```json
[
  {
    "model": "tuningengines@gpt-4.1-mini",
    "nativeProvider": "tuningengines",
    "isExplicit": true,
    "routingSource": "direct",
    "chain": [],
    "directProbe": {
      "state": "error",
      "latencyMs": 2045,
      "httpStatus": 400,
      "errorMessage": "Explicit model \"tuningengines@gpt-4.1-mini\" could not be routed — TUNING_ENGINES_BASE_URL is set to 'htp://not-a-url:9999', which is not a valid http(s) URL...."
    }
  }
]
```

The warning names the variable (`TUNING_ENGINES_BASE_URL`), quotes the offending value, and states
the refusal to fall back **explicitly in the message text**. The entry is skipped; no request is
issued. This is the data-egress guard: a self-hosted gateway operator who typos their host does not
have their traffic quietly redirected to the public `api.tuningengines.com`.

---

## Test 5 — an unexpanded placeholder is NOT malformed

**PASS**

```bash
export TUNING_ENGINES_API_KEY="<redacted>"
export TUNING_ENGINES_BASE_URL='${SOME_UNSET_VAR}'   # single-quoted; the shell does not expand it
bun run packages/cli/src/index.ts --probe tuningengines@gpt-4.1-mini --json
```

No skip warning is emitted — the row registers. The probe reaches the real Tuning Engines host and
comes back with that vendor's own auth rejection:

```json
[
  {
    "model": "tuningengines@gpt-4.1-mini",
    "nativeProvider": "tuningengines",
    "isExplicit": true,
    "routingSource": "direct",
    "chain": [],
    "directProbe": {
      "state": "auth-failed",
      "latencyMs": 1910,
      "httpStatus": 401,
      "errorMessage": "Tuningengines error (HTTP 401): Check API key / OAuth credentials. — Provider authentication failed…"
    }
  }
]
```

```
[claudish] Error [Tuningengines]: HTTP 401. Check API key / OAuth credentials.
(Provider authentication failed. … Provider said: 401: Invalid API key format)
```

To show the base URL that was actually used rather than inferring it from the 401, the same env was
run through a real turn with `-d`. From `logs/claudish_2026-08-14_02-29-02.log`, line 25:

```
[2026-08-14T02:29:04.579Z] [Tuningengines] Calling API: https://api.tuningengines.com/v1/chat/completions
```

The bundled `https://api.tuningengines.com` was used — the literal `${SOME_UNSET_VAR}` was treated
as UNSET, not as a malformed override, so the row was **not** skipped. (An OpenAI key is of course
not a Tuning Engines key, hence `401: Invalid API key format` from the real vendor. That 401 is
independent confirmation that `api.tuningengines.com` is a live auth-realm host, matching the
catalog row's recorded `evidence: { tier: "probe", verdict: "auth-realm", status: 401 }`.)

The distinction between Test 4 and Test 5 is the whole point: a *typo* is a decision the user made
badly and must be refused loudly; an *unexpanded placeholder* is a variable the user never really
set, and the documented default is correct.

---

## Verdicts

| # | Test | Verdict |
|---|---|---|
| 1 | Endpoint invisible without a credential | **PASS** |
| 2 | Endpoint appears with a credential, routed to `tuningengines` (not OpenRouter, not builtin `openai`) | **PASS** |
| 3 | Real turn — `BANANA`, exit 0, URL `https://api.openai.com/v1/chat/completions` | **PASS** |
| 4 | Malformed override skipped with a naming warning, no fallback | **PASS** |
| 5 | Unexpanded placeholder treated as unset, bundled base URL used | **PASS** |

## What this proves — and what it does not

**It proves the LAYER is fully functional end to end, against a real vendor with a real key.** A row
that ships in the bundled catalog travelled the entire path — catalog → credential gate → compile to
`CustomEndpointComplex` → collision check → runtime registration → routing as an explicit
`provider@model` spec → `OpenAIProviderTransport` → SSE parse → stdout — and produced correct model
output from a live API. The credential gate, the R12 base-URL override, the malformed-override
refusal, and the placeholder-is-unset rule are all confirmed on real traffic rather than in a
harness. The anti-criterion is met: at no point did a request land on OpenRouter or on the builtin
`openai` provider; the debug log names the endpoint and the overridden URL directly.

**It does not prove any specific one of the other 24 vendors' streaming dialects.** No key is held
for them, so nothing here says whether e.g. a given vendor's SSE chunking, tool-call encoding,
`finish_reason` vocabulary, or error shape is handled correctly. What has been validated for those
rows is only what is vendor-independent: that a row activates exactly when its key is present, that
its `baseUrl`/`apiPath`/`format` compile into a working custom endpoint, and that the override and
refusal rules behave. The per-vendor dialect surface remains untested until someone holding each key
runs a turn through it.

Additionally out of scope of this run: the `tuningengines` row was exercised **pointed away from its
own vendor**, so this says nothing about Tuning Engines' actual API behaviour beyond the 401
auth-realm probe in Test 5.

## Housekeeping

No source file was modified. Nothing was committed. The `logs/` directory is gitignored
(`.gitignore:49`), so the four debug logs produced here are not tracked. The test environment
variables (`TUNING_ENGINES_API_KEY`, `TUNING_ENGINES_BASE_URL`) were only ever set inside
short-lived wrapper scripts in the session scratchpad — they were never exported into the user's
shell, never written to any config file, and no key value appears in this document.
