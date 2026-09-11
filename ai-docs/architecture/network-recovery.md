> Two-tier connection recovery: the in-request retry ladder, the magmux recovery pane, and the
> 503 handoff that lets Claude Code's own retry loop carry an outage the socket cannot.
>
> Indexed in [`README.md`](./README.md). Status-code neighbours: [`adapters.md`](adapters.md).

# Network recovery — why "retry forever" is two tiers and not one loop

A transport-unreachable failure used to end a turn. `classifyConnectionError` returned non-null,
`respondConnectionError` answered `400 connection_error`, and the transcript carried a dead turn the
user had to retype. VPN flaps, a Tailscale MagicDNS outage, a stopped `ollama serve`, a laptop lid
closing between two tool calls — all of them, terminal.

The fix is **not** an unbounded retry loop, and this document exists mostly to record *why not*,
because the reasons are measurements that the source cannot show you.

---

## 1. The client's clock is the real constraint, and it is a KNOB

The obvious design is to hold the inbound request open and retry until the network returns. Phase 0
measured what actually happens when you do.

**Claude Code aborts the connection at 359.607 s** — reproduced at 359.4 / 360.1 / 360.1 across two
processes, against a custom `ANTHROPIC_BASE_URL`. The important part is what that number *is*:

> It is **not** a fixed watchdog. It is `API_TIMEOUT_MS`'s default of 360 000 ms. Setting
> `API_TIMEOUT_MS=20000` produced six aborts at **exactly 20.000 s**.

That single fact decides the shape of the feature twice.

1. **A hold has a hard ceiling.** Whatever we do, the socket dies at the client's timeout. "Retry
   forever inside one request" is not implementable — not as a trade-off, as an impossibility.
2. **The deadline must be DERIVED, never written down.** A user with `API_TIMEOUT_MS=60000` gets a
   client that gives up at 60 s. A hardcoded 270 s deadline means *every* episode on that machine
   ends in `client_gone` and recovery never engages — silently, and only on their machine. So:

```
TIER1_DEADLINE_MS = max(FLOOR, min(API_TIMEOUT_MS ?? 360_000, 300_000) − 30_000)
```

`recovery/settings.ts` owns that computation and logs a `[Recovery]` line whenever the environment
shortens the budget, so a short hold is visible rather than mysterious. This is CLAUDE.md's
*"a default is a rule, never a pinned id"* arriving in the time domain.

The other two ceilings the derivation clears:

| ceiling | value | where |
|---|---|---|
| Bun's per-request idle timeout | 255 s | `proxy-server.ts`'s `idleTimeout` |
| the unclamped attempt 1 | up to 45 s | reserved out of the budget, never clamped (NFR-1) |

Bun's 255 s stops binding because `c.env.timeout(c.req.raw, 0)` **works** — measured, a request
given `0` survived **6×** its `idleTimeout` where the un-disarmed control died at 1.6×. That call is
made inside the `catch`, never on a healthy request.

### Claude Code's retry budget is a COUNT, not a duration

The second tier hands the retry back to the client. What the client will then spend is:

- **~11 attempts** on its default budget, spanning **~174 s** for a 503 chain (backoff caps at
  38.4 s per gap, and `retry-after` is honoured verbatim);
- **~300 attempts** with `CLAUDE_CODE_RETRY_WATCHDOG=1`, which claudish sets only when recovery is
  enabled, the UI is allowed, AND this launch can actually obtain a pane — reaching **~a day** of
  unattended recovery on a hung connection. All three gates, because the watchdog amplifies EVERY
  503 the session sees and is worth its cost only where a surface can exist (§7).

It is a count, not a clock. That is why `EPISODE_GRACE_MS` is 120 s: the client's worst gap is
38.4 s, so 120 s is 3.1× inside it and a returning client always finds its episode still open.

**The watchdog is a deliberate, informed acceptance of RISK-6** — see §7.

---

## 2. The two tiers, and the episode that makes them one thing

```
POST /v1/messages ──► ComposedHandler.handle()   startTime = performance.now()
                        attempt 1 = today's expression, BYTE-IDENTICAL ──► success
                          │ throws
                          ▼
                      classifyConnectionError()  ── null ──► rethrow, unchanged
                          │ non-null
                          ▼
                      shouldSkipTier1()?  probe header · recovery disabled ·
                                          user pressed [q] · no budget left
                          │ no
      ┌───────────────────▼──────────────────────────────────────────┐
      │ TIER 1 — in-request, PRE-FLUSH, deadline derived from §1      │
      │   joinEpisode(key)   ONE episode per target, N waiters        │
      │   5 → 10 → 30 → 60 → 60 … on a SHARED clock                   │
      │   re-issue THROUGH provider.enqueueRequest, re-classified     │
      │   success ─► return the upstream Response ────────────────────┼──►
      └───────────────────┬──────────────────────────────────────────┘
                          │ deadline reached
      ┌───────────────────▼──────────────────────────────────────────┐
      │ TIER 2 — hand the retry back                                  │
      │   uiLeaseValid(episodeId) ? 503 overloaded_error              │
      │                             + x-should-retry: true            │
      │                             + x-claudish-recovery: 1          │
      │                           : 400 connection_error  (as before) │
      │   the episode stays OPEN for EPISODE_GRACE_MS                 │
      └───────────────────┬──────────────────────────────────────────┘
                          │ Claude Code's own retry re-POSTs and JOINS
                          │ the same episode — one continuous banner
```

**The episode is what makes two tiers read as one recovery.** It is a process-level singleton keyed
by `${provider}|${host}`. A handoff leaves it open; the client's re-issued request finds it,
increments `clientRetries`, and continues the *same* attempt counter, ladder position and banner —
while getting a *fresh per-request deadline*, because the deadline belongs to the socket and the
socket is new.

Three lifetimes, and none of them is the state machine. Conflating them was the largest defect of
the superseded design:

| lifetime | scope | owner | ends when |
|---|---|---|---|
| the **deadline** | one inbound request | the waiter | its own `deadlineAt` passes — *that waiter alone* answers and leaves |
| the **ladder** | one episode (`key`) | the coordinator | the last waiter leaves, or an attempt succeeds |
| the **lease** | one pane × one episode | the UI manager | `UI_LEASE_MS` after the last heartbeat naming that episode |

When one waiter's deadline moved the *shared* episode into `handoff` — a state with no timer — every
other parked waiter silently stopped being retried and answered having attempted nothing. The
visible symptom was a banner reading `waiters: 4` with one of them actually being retried.

### The measured ladder

Real clock, real refused loopback socket, through `ComposedHandler.handle()`:

| attempt | fires at | gap |
|---|---|---|
| 1 | t+0 | — |
| 2 | t+5.002 s | 5002 ms |
| 3 | t+15.004 s | 10002 ms |
| 4 | t+45.009 s | 30005 ms |
| 5 | t+105.010 s | 60001 ms |
| 6 | t+165.011 s | 60001 ms |
| 7 | t+225.012 s | 60001 ms |
| — | handoff at t+225.018 s, deadline 270 s | |

18 ms of drift over 225 seconds. **The last array element repeats and the DEADLINE ends the
schedule** — which inverts `STREAM_RETRY_DELAYS_MS`, where the array running out *is* the budget.
The two schedules are deliberately separate: merging them would couple the sniffer's 12 s budget and
a duration quoted verbatim in a user-facing message to this one.

On a tier-2 rejoin the ladder does **not** reset. The target has been down for the whole of it, and
restarting at 5 s would hammer a dead host harder the longer the outage lasted.

### `PER_ATTEMPT_CONNECT_CAP_MS` is 45 s because 75 s collides with the OS

macOS gives up on its own TCP connect at **75.004 s** (measured against the unrouted `192.0.2.1`; a
refused loopback port is 5 ms). A 75 000 ms clamp races the operating system by **4 ms** and is
decided differently on different runs, which makes every assertion keyed on "the attempt ended at
the clamp" flaky by construction. 45 s clears the collision by 30 seconds and always wins.

**Slow and fast connect failures are indistinguishable BY CODE on macOS.** `192.0.2.1:443` reports
`ECONNREFUSED` / `ConnectionRefused` — the same code a loopback port refuses instantly with. Only
elapsed time separates them, so nothing may branch on the code to tell them apart. `isLoopback(endpoint)`
is the only honest discriminator, and it reads the address, not the error.

---

## 3. The status table — and why 503 and not 429

| condition | status | headers | why |
|---|---|---|---|
| recovered inside tier 1 | the upstream's own | — | the caller carries on as if the first attempt had worked |
| exhausted, **a lease is valid** | **503** `overloaded_error` | `x-should-retry: true`, `x-claudish-recovery: 1` | the reason is legible on the pane, so the retry may be handed back |
| exhausted, **no lease** | **400** `connection_error` | — | nothing can display the reason, so it must ride the status |
| `[q] give up` | **400** `connection_error` | — | guarded on `result.kind`, never on the lease — see below |
| **a request arriving within 60 s of `[q]`** | **400** `connection_error` | — | the ladder is SKIPPED outright: the user said stop |
| client disconnected | 499 (unread) | — | the socket is already gone |
| unclassifiable throw on any attempt | rethrown unchanged | — | recovery must not widen what "transient" means |

### `[q] give up` suppresses the HOLD, not only the banner

`bye` originally did two things, both inside the UI manager: it suppressed re-opening the pane for
60 s, and it called `giveUpAll()` — which iterates the episodes alive *at that instant*. Nothing
recorded that the user had asked recovery to stop, and `shouldSkipTier1` had no gate that could
notice. So the next request against the same dead target opened a NEW episode, found the pane
suppressed, got no pane and no lease, and then held its socket for the full ~4.5-minute deadline
before answering 400 — **a long hold with no surface, which is the state this design calls "strictly
worse than the bug this feature exists to remove", reached from the one affordance whose entire
purpose is to end it.** Before recovery existed those requests failed in milliseconds.

It is not an edge case. Claude Code issues concurrent requests during an outage (main loop, title
model, subagents), so a request arriving inside the suppression window is the EXPECTED one.

The fact is therefore process-level — `recovery/settings.ts`'s `recoveryGiveUpActive()` — and is read
by **both** `shouldSkipTier1` (the hold) and `ensureRecoveryUi` (the surface). One number, one
window, two readers. A control that appears to stop something and does not is worse than no control.

### 429 would have been a live billing bug

`fallback-handler.ts` contains, verbatim:

```ts
// Rate limited — per-provider limit, a different provider may have capacity
if (status === 429) return true;
```

A 429 from the exhausted network path makes `FallbackHandler` **advance to the next provider**.
During a network outage the next provider is unreachable for the same reason, so the chain burns
every candidate — each paying its own multi-minute budget — and per CLAUDE.md's standing invariant,
an advance off a `SUBSCRIPTION_PROVIDERS` candidate onto a metered one quotes real money for a fault
no provider caused.

503 does not have this problem: `isRetryableError` has **no 503 branch**. It is the status the house
already owns for "transient after our own retries, do not switch the user's provider" — the stream
sniffer's exhaustion arm uses it for exactly that reason (`adapters.md`).

529 was considered and rejected: it is absent from `exhaustedChainStatus`'s transient set and would
add a status this codebase has never carried, re-opening every `status ===` under `handlers/`.

### Chain-safety is STRUCTURAL, not wording-based — and ORDER is the property

A 503 stopping the chain is not enough, twice over:

- **`isRetryableError`'s FIRST statement is `hasQuotaExhaustionWording(errorBody)`**, deliberately
  status-agnostic (it exists *because* of the 400 remap), and its phrase list contains the **bare
  substring `"quota"`**. A 503 whose *message* happened to carry that word advanced the chain and
  spent the user's money.
- **`exhaustedChainStatus` could demote it.** With an earlier candidate already failed, a
  non-retryable response goes to `formatCombinedError`, whose status is 503 only if *every*
  accumulated error is transient. One earlier auth or 404 failure turns our 503 into a terminal 400
  and the client never re-POSTs.

So the marker is a **header**, `x-claudish-recovery: 1`, checked in two independent places:
`handle()` returns a marked response VERBATIM before reading the body (defeating the combining), and
`isRetryableError` returns `false` on it **above** the quota match (defeating the wording).

> **Moving the marker check below the quota match — present, but LATE — is a live billing bug.**
> It is mutation-covered as one, and the mutation that kills it is the quota-wording variant
> specifically. A test whose 503 body says nothing about quota cannot see the defect at all.

The marker cannot be forged: every non-ok exit from `ComposedHandler` is `c.json(...)`, which builds
headers from nothing, and the only path that copies upstream headers verbatim
(`stream-head-sniffer.ts`'s `replayResponse()`) runs after `!response.ok` has already returned.
**If a future edit ever returns an upstream `Response` object on a non-ok path, the marker must be
stripped there.**

### `[q] give up` is guarded on the OUTCOME, never on the lease

A lease is by definition valid at the moment the give-up key is pressed — the pane that took the
keystroke is alive. A lease-only test would answer a retryable 503, Claude Code would immediately
re-ask, and the give-up key would be a no-op with a banner still on screen.

---

## 4. The lease — why the heartbeat must not be driven by frames

The generalisable rule the two exhaustion arms encode:

> **A retryable status is permissible exactly when claudish still has a surface on which the reason
> is legible.** Absent such a surface, the reason must ride the status, which means 400.

The gate is not a boolean and not a latch. A latch set on `hello` and never cleared is true after
`[q] give up`, after a killed pane, after a dead magmux and after a socket EOF — and the exhaustion
arm then answers 503 with the reason visible nowhere, *which is strictly worse than the bug this
feature exists to remove*. It is a **lease**:

```
uiLeaseValid(episodeId)
  ⇔ the proxy itself opened a pane and holds the `open_pane` reply
  ∧ some connected client has HEARTBEATED `ack` naming THIS episode within UI_LEASE_MS
```

Every clause works. *Naming this episode* makes it episode-scoped, so two concurrent episodes cannot
borrow one pane's legitimacy. *`ack`, not `hello`* makes it **post-render** — a process can send
`hello` before painting anything. *Within `UI_LEASE_MS`* makes it self-clearing on EOF, crash and
freeze, with no cleanup path to forget. *The proxy opened the pane* means a forged same-uid client
cannot manufacture the forbidden 503-with-no-banner state.

**"Heartbeated", not "renewed by frame receipts" — this is the single most consequential word here,
and the superseded design had it wrong.** Frames were emitted only while the episode was `waiting`.
There is no tick during `attempting`. A real `unreachable` connect takes 20–75 s (`192.0.2.1`
measured at **75 005 ms**), which is 2×–7.5× `UI_LEASE_MS` — so the lease expired *while the banner
was alive and painted*, and the exhaustion arm answered 400 for exactly the failure class that
motivated the feature.

The lease is a statement about **the renderer being alive and painting this episode**, so it is
renewed by the renderer on its own `UI_HEARTBEAT_MS` timer and by nothing else. The proxy's
`FRAME_TICK_MS` tick — now emitted in *every* live state, not only `waiting` — is then free to serve
the banner rather than the gate.

**Every loopback-only test passed over this bug.** A refused loopback connect resolves in ~1 ms, so
the ladder is all `waiting` and frames never stop. The regression is only visible with a slow
connect, which is why the unit test fakes a 45-second attempt (4.5 lease windows, **not one frame
emitted**) and the integration test runs a real pane against a 20-second lease clock.

No transition in the episode's table touches the lease, and the lease never causes a transition. The
retry loop is not the pane's business, and the pane's liveness is not the deadline's business.

---

## 5. A connection failure can wear an AUTH status code — at five separate sites

This is the half of the work that shipped on its own merits and would have been worth doing with no
recovery ladder at all.

`fallback-handler.ts` reads **401 as retryable**. So a network outage during a token refresh did not
fail the request — it **advanced the chain**, moving a subscription user onto a per-token candidate
mid-outage, for a fault that had nothing to do with their credentials. Reproduced:

```
[Fallback] Sakana Fugu failed (HTTP 401), trying next provider...
[Fallback] Metered Fallback succeeded after 1 failed attempt(s)
```

An *unclassified throw* leaving `handle()` is the same bug one layer out: it lands in
`fallback-handler.ts`'s catch, which pushes `{ status: 0 }` and advances **unconditionally** —
without even the per-token cost warning, which sits on the non-throwing branch. On a single-candidate
route no `FallbackHandler` exists, so it lands in `proxy-server.ts` as a bare 500 instead.

The inventory — every outbound call in `ComposedHandler` that can throw without a `Response`:

| # | site | before | after |
|---|---|---|---|
| 1 | `refreshAuth()` catch | classified **never** — unconditional **401** | classify FIRST, before `err.terminal` |
| 2 | `forceRefreshAuth()` catch (wraps the 401-retry `fetch` too) | classified **never** — unconditional **401** | classify FIRST |
| 3 | parameter-recovery re-fetch | **no `try` at all** — escaped `handle()` → `{status: 0}` + advance | wrapped; classified → 400, unclassified → rethrown |
| 4 | `getHeaders()` | **outside every `try`** — escaped `handle()`, or a bare 500 | wrapped; classified → 400, unclassified → rethrown |
| 5 | primary `fetch` / `enqueueRequest` | already classified — the control | unchanged, refactored onto the shared helper |

**Site 4 is worth a paragraph.** `getHeaders()` looks like a pure accessor and is not one. For `gk@`
it is the request's *first* network touch: `grok-subscription.ts` → `grok-credential.ts` →
`resolveGrokAccessToken()` → `fetch(auth.x.ai/oauth2/token)`. The touch is **refresh-conditional**,
which makes the escape rare — not safe. Rarity is what kept it alive through three reviews.

The rule all five now obey: **classify first, or rethrow unchanged; none may invent a status.** There
is exactly one way to answer "claudish could not reach the host" — `respondConnectionError()` — and
it answers 400 `connection_error`, never 401 and never a bare 500.

Local transports needed evidence preservation before any of this could reach them: `local.ts` used
to swallow its connect error in `catch (e: any) { log(…) }` and throw a bare
`Error("Cannot connect to Ollama at …")`. `findConnectionCode` found no `.code`, no `.cause` and no
message match, so `classifyConnectionError` returned **null** and a stopped Ollama — the single most
common local failure — never reached tier 1 at all. Same class of fix in `vertex-oauth.ts`
(discarded `code`), `openai.ts` (neither `code` nor `cause` on its error classes) and
`antigravity.ts` (the banner must name the *auth* host, not the eventual inference endpoint).

`healthChecked` latches on **success only**, so a retried `refreshAuth()` re-probes instead of
returning a false success to attempt two.

### Three things the auth path needs that the fetch path gets for free

- **The clamp has to be ENFORCED, not handed over.** `op` takes the per-attempt signal, and the fetch
  path threads it into `fetch`. `refreshAuth()` and `getHeaders()` take no arguments, so
  `() => this.provider.refreshAuth!()` discards it — and Grok's token exchange then performs an
  unbounded `fetch(auth.x.ai/oauth2/token)`. A swallowed connection there outlived both the 45 s cap
  and the client's own disconnect while `withConnectionRetry` awaited a promise nothing could settle:
  the unbounded hold this feature exists to remove, reached from inside the machinery that removes
  it. `untilAborted` now enforces the ceiling at the one place that owns it. The operation is
  *abandoned*, not cancelled — threading a real signal through every transport's auth call is the
  deeper fix and is still worth doing.
- **The error must name the host that actually failed.** `connectionEndpointFor` falls back to the
  MODEL endpoint when the error carries no `claudishEndpoint`, so an `auth.x.ai` outage was reported
  — in the banner, in the log and in the episode key — as `api.x.ai`. Grok's refresh wrapper now
  attaches it, as `local.ts` already did.
- **`noteTargetReachable` closes by PROVIDER, not by host.** Because an auth episode can be keyed on
  a different host than the one a later success reaches, a strict key lookup missed it and the pane
  painted "waiting for Claude Code to retry" over a working session for the full 120 s grace. A
  request that reached the model endpoint had to authenticate first, so it has proved every host it
  touched is answering — and a `handoff` episode holds no waiters, so nothing is closed from under
  anyone.

---

## 6. Stats — and the one step whose omission is silent

Five optional fields on `StatsEvent`, absent on every healthy request:

| field | scope | what it answers |
|---|---|---|
| `retry_attempts` | **request** | how many times *this request* re-issued against the same provider. Not `fallback_attempts`, which counts different providers |
| `recovery_ms` | **request** | how much of this record's `latency_ms` was backoff and failed connects |
| `recovery_episode_id` | episode | the correlation key — `count(distinct …)` is the only honest answer to "how often" |
| `recovery_client_retry` | episode | which tier-2 re-entry this request is; 0 = the original |
| `recovery_outcome` | episode | `recovered` / `handoff` / `client_gone` / `gave_up` |

**`latency_ms` continues to INCLUDE the waits**, per the standing decision in `adapters.md` ("the
honest figure is time-to-usable-response"). `recovery_ms` exists so the resulting skew is explicable
rather than mysterious: `latency_ms: 246_000, recovery_ms: 201_900` reads as a 44-second turn behind
a three-and-a-half-minute outage. Without the second field, the same record reads as a four-minute
model.

**Why two scopes.** The episode's cumulative counters cannot stand in for the per-request ones: N
concurrent requests share one episode, so each would report the sum of all of them, and a tier-2
re-entry inherits counters from a request that already recorded its own. Summing `retry_attempts`
across an outage would multiply it by the number of waiters and again by the number of re-entries.
The episode-scoped figures are what the *banner* quotes, because the banner is about the outage.

**The cardinality rule.** `stats-otlp.ts` says verbatim "one per LLM request". A request that hits
both an auth-path episode and a fetch-path episode carries the id of the episode that **decided its
status** — the later one. An auth episode that *recovered* emits no record of its own: its attempts
fold into the same request's `retry_attempts` and its waits into the same `recovery_ms`. The
coordinator emits **no lifecycle records at all**; a `grace_expired` event with no request behind it
would be a phantom distorting request counts, success rate and latency percentiles in the very
stream that is supposed to answer the question. Episode lifecycle is a `[Recovery]` structural log
line instead.

### The trap: `eventToLogRecord` is a hand-written allowlist

A field added to the `StatsEvent` interface and populated by `stats.ts` but **not pushed in
`eventToLogRecord`** is typed, type-checked, buffered, and written to
`~/.claudish/stats-buffer.json` — and never leaves the machine. Nothing throws. The number is simply
absent from every dashboard built to read it, and the loss surfaces a quarter later when someone
asks a question the data cannot answer.

The guard is in `stats-otlp.test.ts` and has two layers:

1. `satisfies Record<OptionalStatsKey, …>` makes its table **exhaustive over `StatsEvent`'s optional
   fields at COMPILE TIME**. Add an optional field to the interface and the test file stops
   compiling until it is listed.
2. The table then drives emit-when-set and omit-when-unset per field, so listing a field without
   pushing it is red.

Layer 1 is the load-bearing one — it is what stops this being a checklist someone has to remember to
read. Both directions are mutation-proven: deleting the `recovery_episode_id` push, and swapping one
`!== undefined` for a truthiness check (which drops `retry_attempts: 0`, the record that says "an
episode existed and this request added nothing to it").

`retryAttempted` on the error report is now **derived**, not hand-set. It had been a literal `false`
on the connection path since before the ladder existed, so every recovered-then-failed outage was
reported as a first-and-only attempt.

---

## 7. Risks accepted, explicitly

**RISK-6 — duplicate charges on a re-issue.** A retry after `ECONNRESET`/`EPIPE` may re-run
inference the provider already started billing. The user accepted this at the scale of our own
ladder, and then accepted it again, with the arithmetic in front of them, at the watchdog's scale:

| | watchdog dropped | **watchdog restored (chosen)** |
|---|---|---|
| client retry budget | ~11 attempts | ~300 attempts |
| unattended reach, hung connection | ~66 min | **~a day** |
| worst-case retry attempts per turn | ~46 | **~2,100** |
| RISK-6 exposure | as originally accepted | **≈30× that** |

`recovery_episode_id` is what makes the exposure *attributable* — without it, attribution breaks
exactly across a tier-2 handoff, which is the highest-exposure path.

**What RISK-6 does NOT extend to, and the two ways it leaked past its own boundary.** Both were
found in review and closed; both are the same mistake — applying the accepted arithmetic to a case
the user was never shown.

1. **A LATENCY event is not a network fault.** `classifyConnectionError` mapped the NAME
   `TimeoutError` to `unreachable`. That name is also what `AbortSignal.timeout` on a transport's own
   *inference* request rejects with — `vertex-oauth.ts` puts a 30 s ceiling on the model call itself.
   A `vx@` turn whose time-to-first-byte exceeded 30 s (ordinary for a thinking model) was therefore
   classified as "the host is unreachable", entered the ladder, took the tier-2 handoff, and was
   re-POSTed ~300 times — **each one running one more real billed inference against a host that had
   answered the TCP connect and was already generating.** The discriminator is now the SIGNAL'S
   ORIGIN, not the name: our per-attempt clamp and our reachability probes carry a `markOwnTimeout`
   own-property and classify; everything else keeps its pre-recovery route out, unclassified and
   rethrown. The user-facing sentence was wrong too — it told the user to check VPN and DNS for a
   host that was mid-generation.
2. **The watchdog needs three gates, not one.** `CLAUDE_CODE_RETRY_WATCHDOG=1` was exported from the
   UI preference alone, so `-p`, `--no-recovery`, a pipe and a machine without magmux all expanded
   every UNRELATED 503 to ~300 client attempts while being structurally incapable of holding the
   lease a recovery 503 requires. It now requires `resolveRecoveryEnabled()` **and**
   `resolveRecoveryUi()` **and** `magmuxPaneCapability() !== none` — the last asked BEFORE the child
   environment is finalised, which is why that predicate is side-effect free and is the same one
   `planMagmuxWrap` consumes.

**The transport's `getRequestInit()` is re-minted per attempt.** It was hoisted once, before the
primary fetch, and spread into every re-issue. A transport that returns a one-shot
`AbortSignal.timeout` therefore poisoned the whole ladder the moment it fired:
`AbortSignal.any([fired, live])` is ALREADY ABORTED, so every later attempt rejected without opening
a socket. For `vx@` that made tier 1 silently dead past t+30 s — the request held the full deadline
making **zero** real connect attempts while the log and the pane counted attempts that never left the
process. `mergeSignalIntoInit` now also drops an `own` that is already aborted, as the belt behind
that brace.

**RISK-7 — a CI run holding a dead endpoint for the full deadline.** `--no-recovery` /
`CLAUDISH_RECOVERY=0` restores today's immediate 400 everywhere, byte for byte. `--no-recovery-ui` /
`CLAUDISH_RECOVERY_UI=0` keeps the retries and drops only the pane (and with it the 503 arm, since
the lease can never be valid).

**There is NO loopback carve-out, and its absence is a decision.** An earlier design skipped the
ladder for a refused loopback address on the reasoning that a stopped local server will not start
itself. It was cut for two reasons. The narrow one: the predicate was a regression generator — every
revision of it either fired universally (skipping recovery everywhere) or fired never, and both
times the defect was invisible because the *same rule* decided the tests. The broad one, which is
the real one, in the user's words: *"why are we talking about ollama at all? we are not building a
solution for ollama, it is a general one."* A user who restarts their server mid-ladder gets their
turn back, exactly as a user whose VPN reconnects does.

**The probe path must fail fast.** Every probe POSTs through `ComposedHandler`, so without a gate
`--probe` and the config TUI's Test All would each hold an unreachable link open for the full
deadline and then misreport it as a `timeout` — breaking the two tools that exist to diagnose this
exact fault, and multiplying a Test All run by the probe timeout per unreachable link.
`probe-live.ts` sends `x-claudish-no-recovery: 1` and `shouldSkipTier1` honours it.

**The MCP path is deadline-bounded only.** `mcp-server.ts` passes `method`, `headers` and `body` but
**no `signal`**, so when Claude Code cancels the MCP *tool call*, the proxy socket stays open,
`c.req.raw.signal` never fires, and the ladder runs its full deadline. `client_gone` covers only the
MCP server process dying outright.

---

## 8. What a healthy request pays

Nothing, and the guarantee is **placement**, not a flag: the entire retry apparatus is constructed
inside the `catch`, after classification has already returned non-null. The primary fetch expression
— including its `enqueueRequest` ternary — is byte-identical to what it was before recovery existed.
That is verifiable by reading the diff rather than by trusting a predicate.

The re-issue goes through that **same ternary**. Six transports implement `enqueueRequest`, and what
they implement is not decoration: a bounded 429 loop with `Retry-After`, a served-set model-fallback
chain, and the local concurrency gate that stops `ollama@llama3.2:3` running four inferences at once.
Skipping it would make the attempt that finally *connects* behave differently from the one that
failed — and at the moment a network returns, N woken waiters would stampede unqueued into a
provider that has just come back.

The one measured cost is launch: wrapping the session in a magmux pane adds **+107 ms median**
(login shell +47, magmux +60; worst wrapped sample 718 ms), which is 4.7× inside the 500 ms bar the
design set for itself. Default-on survives on that evidence.

---

## 9. Evidence

| report | what it establishes |
|---|---|
| [`network-recovery-phase0-measurements.md`](../reports/network-recovery-phase0-measurements.md) | the 359.607 s client abort and its `API_TIMEOUT_MS` cause; `c.env.timeout(req,0)`; `Request.signal` firing in 0.49–0.86 ms; the 75.004 s macOS connect; magmux's +107 ms |
| [`network-recovery-phase2-verification-20260911.md`](../reports/network-recovery-phase2-verification-20260911.md) | the measured 5/10/30/60/60/60 ladder with 18 ms drift over 225 s; the four modules that shipped with no tests |
| [`network-recovery-phase3-pane-20260911.md`](../reports/network-recovery-phase3-pane-20260911.md) | the lease, the frame-driven-heartbeat CRITICAL, and the two tests that can fail on it |
| [`network-recovery-phase4-status-flip-20260911.md`](../reports/network-recovery-phase4-status-flip-20260911.md) | the 503 flip through a real interactive session; the chain-safety mutations, including the quota-wording one |

Auth-path detail — the five-site inventory with per-site line references and the reproduced
`[Fallback]` advance — is in the Phase-1 half of the same body of work, summarised in §5 above.
