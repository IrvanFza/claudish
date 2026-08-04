# Spec request: behaviour telemetry endpoint

**For:** backend developer
**From:** claudish CLI
**Status:** request for implementation — the contract below is what the client needs; storage, infra, and query design are yours.
**Related:** MTL-77 (self-improving supervisor)

---

## 1. What this is, in one paragraph

Claudish routes Claude Code to non-Anthropic models. Those models frequently violate Claude Code's conventions in ways that are invisible to the transport — HTTP 200, valid response, model just did the wrong thing. Claudish now has a **Layer 4 behavior supervisor** that detects and repairs some of these. This endpoint collects **aggregate evidence about which models violate which conventions, and how often**, so rules can be written for models the maintainer does not personally use.

## 2. What this is NOT

**It is not the existing `https://claudish.com/v1/report`.** That is a *bug report* endpoint: it fires when a provider call **fails**, and carries provider name, HTTP status, error type. Its question is "is this provider broken?"

This endpoint fires when everything **succeeded**. Its question is "which model misbehaved, and how often?" Different trigger, different schema, different consent. Please give it its own name and route — mixing the two makes both harder to query.

Suggested: `POST https://claudish.com/v1/behavior`

## 3. Payload — session aggregates only

**One request per Claude Code session**, sent when the session ends or is flushed. Not one per decision.

```jsonc
{
  "schema": 1,
  "sessionId": "<opaque, hashed client-side — see §5>",
  "startedAt": "2026-08-04T01:00:00Z",
  "endedAt":   "2026-08-04T01:42:11Z",
  "client": { "version": "7.29.0", "platform": "darwin" },
  "model":    "gpt-5.6-sol",
  "provider": "openai-codex",
  "contextBucket": "150-200k",          // coarse bucket, never an exact count
  "turns": 42,
  "decisions": [
    {
      "ruleId":  "plan-mode/plan-file-path",
      "surface": "tool_call",            // request | tool_call | model_output | sequence
      "toolName": "Write",
      "counts": { "repaired": 11, "ignored": 420, "warned": 0, "matched": 0, "novel": 0 },
      "pathRelations": {                 // categorical only — never a path
        "as_expected": 420,
        "same_dir_wrong_name": 11,
        "outside_expected_dir": 0
      }
    }
  ]
}
```

### Field notes

- `contextBucket` is coarse on purpose. Exact token counts across many sessions are a behavioural fingerprint; the analytical question ("do violations rise with context?") only needs buckets.
- `pathRelations` is the whole reason this data is useful **and** the reason it is safe. `same_dir_wrong_name` is the exact discriminator the plan-mode rule keys off, and it carries no path.
- `decisions` is an array so new rules and surfaces need no schema change.

## 4. What claudish will NEVER send

This list is enforced client-side by an **allow-list projection**, not a deny-list, so a future field cannot leak by accident. Please treat it as a contract you can rely on when reasoning about retention and access:

- file paths, or any fragment of one
- tool-call argument **values** (argument *key names* only, and only where useful)
- message text, prompts, code, or model output
- `device_id` or `account_uuid` (Claude Code sends both alongside the session id; claudish discards them at extraction)
- API keys, tokens, or credentials of any kind
- repository, branch, or project names

If you ever receive any of the above, that is a **client bug** — please report it rather than storing it.

## 5. Session id

Claude Code supplies a per-session UUID. Claudish will send a **salted hash** of it, not the raw value, so this dataset cannot be joined against any other service that sees the same id. It is stable within a session and unlinkable across them.

You need it only to group rows and to deduplicate retries.

## 6. Auth and abuse

Open question for you — claudish has no user accounts on this path, and the existing report endpoint is unauthenticated. Suggest what you want: a shared client token, per-install token, or unauthenticated with rate limiting. Please state the rate limit so the client can respect it.

## 7. Delivery semantics the client guarantees

- Opt-in only, default **off** (`behavior.telemetry.enabled`), separate from the existing stats consent
- Fire-and-forget with a short timeout; any failure is silently discarded and never affects the user's request
- No retry storm: at most one retry, then dropped
- Client honours a `Retry-After` header if you send one

## 8. Retention — the decision we need from you

Because the client sends **only session aggregates**, the server never holds raw per-decision records. That removes the hardest retention question before it is asked. What remains:

- How long are session summaries kept?
- Are they further rolled up (per model / per rule / per week) after some window, with session rows dropped?

**Our recommendation:** session summaries for 12 months, rolled up to per-model/per-rule/per-week aggregates kept indefinitely. Rationale: rule discovery uses recent data; long-term value is in trend ("did this model get better after a release"), which survives rollup.

Whatever you choose, please state it publicly — this is user data collected under an explicit opt-in, and the consent prompt should be able to quote the retention period.

## 9. Queries this needs to answer

Design storage for these; they are the whole point.

1. For model M, which rules fire and at what rate per session?
2. Which models violate rule R most often? (finds models needing a rule armed)
3. Does violation rate for rule R correlate with `contextBucket`? (the plan-mode bug was context-pressure driven)
4. Did rule R's repair rate drop after client version V? (did a fix work)
5. Which `toolName` + `surface` combinations produce `novel` decisions with no matching rule? (finds rules worth writing)

Query 5 is the highest-value one — it is how the next rule gets discovered.

## 10. Not in scope for you

Analysis, rule generation, and the "dream session" all run **client-side** against the local journal, which keeps full detail. This endpoint is only the cross-user aggregate. Please do not build analysis on top of it without talking to us — we would rather send you a better payload than have logic diverge.

## 11. Open questions

1. Endpoint name and route — confirm or propose
2. Auth model and rate limit (§6)
3. Retention decision (§8)
4. Do you want a `schema` version negotiation, or is client-side `schema: N` plus server-side tolerance enough?

## Contact / references

- Client design: `CLAUDE.md` → "Layer 4: Behavior Compatibility Layer"
- Client projection: `packages/cli/src/behavior/journal.ts` → `toUploadable()`
- Existing bug-report endpoint for contrast: `packages/cli/src/telemetry.ts`
