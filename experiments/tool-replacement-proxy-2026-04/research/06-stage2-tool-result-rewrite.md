# Stage 2 Results — Approach 1 PoC Works End-to-End

**Date**: 2026-04-15
**Claude Code**: v2.1.109
**Executor**: Opus 4.6 (Claude Max subscription, high effort)
**Proxy**: claudish monitor mode, patched with advisor swap + stub-advice rewrite
**Evidence**:
- `evidence-stage2-rewrite.ndjson` — 14 structured events, full request bodies
- `evidence-stage2-ui-transcript.txt` — the model's visible response

## Summary

**Approach 1 (proxy-side tool_result rewrite) works.** The proxy transparently
replaced Anthropic's native advisor response with a stubbed canary advice, and
the executor model (Opus 4.6) visibly cited the canary's content in its final
design. End-to-end transparent replacement is now validated in production-like
conditions.

## The Patch in One Paragraph

Two files under `/Users/jack/mag/claudish/packages/cli/src/handlers/`:

- **`native-handler-advisor.ts`** — pure helpers (zero deps). Swap advisor server
  tool for a regular tool, strip the beta header flag, track advisor
  `tool_use_id`s from streamed responses, rewrite matching inbound `tool_result`
  blocks with stub advice. 18 unit tests pass (`bun test …advisor.test.ts`).
- **`native-handler.ts`** — calls the helpers at the top of `handle()` (request
  mutation) and from the SSE chunk loop (id tracking). All gated behind
  `CLAUDISH_SWAP_ADVISOR=1`, zero effect when disabled.

Full build passes (`bun run build:cli`), unit tests 18/18.

## Captured Timeline (evidence-stage2-rewrite.ndjson)

```
T+0.000  request #1:  title-classifier (Haiku)  — no tools, no swap
T+16.729 request #2:  user prompt              — 183 tools → 1 swap + beta strip
T+17.621 response #2: stop_reason=end_turn      (preamble only, no advisor yet)
T+33.428 response #2: tool_use{name:"advisor",id:toolu_01M3TYKRJwbYSKgc2M841rxV}
T+33.494 response #2: stop_reason=tool_use
T+33.519 request #3:  Claude Code follow-up with tool_result for that id
                      ├─ tool_result_rewritten (matched id in tracker)
                      ├─ stub advice substituted in place of Claude Code's
                      │   "<tool_use_error>No such tool available: advisor</…>"
                      └─ forwarded to Anthropic
T+~60s   model completes full design, quoting the stub advice verbatim
```

## Proof the Stub Advice Reached the Executor

The stub advice (canary) was:

> **CLAUDISH_ADVISOR_STUB_<id>:** Evaluation mode — this advice was supplied by
> a claudish proxy stub. For the rate-limiter design, consider a hybrid: local
> token bucket per node for burst tolerance plus a central quota coordinator
> for cross-region fairness. Use the CAP tradeoff as your framing; expose
> availability vs accuracy knobs per tenant. The single most important
> decision is your failure mode: fail-open vs fail-closed.

The model's visible response opened with:

> **The advisor highlights a critical framing: the failure mode (fail-open vs
> fail-closed) is the single most important decision.** This is because in a
> distributed system, the central coordinator will become temporarily
> unreachable — and your choice here defines whether you prioritize
> availability (allow requests through, risking over-limit) or accuracy
> (reject requests, risking false denials).

And the full design mirrored every stub theme:

| Stub theme | Appears in executor's design as |
|------------|---------------------------------|
| "local token bucket per node for burst tolerance" | **Layer 1: Local Token Bucket** (per node, handles burst tolerance) |
| "central quota coordinator for cross-region fairness" | **Layer 2: Regional Quota Coordinator** (Redis Cluster) |
| "use the CAP tradeoff as your framing" | Availability-vs-accuracy tradeoff table |
| "failure mode: fail-open vs fail-closed" | Entire "Critical Decision: Failure Mode" section, 3-column fail-open/closed/degraded table |

The model did NOT echo the `CLAUDISH_ADVISOR_STUB_<id>` prefix — smart enough
to treat it as meta-content — but the SUBSTANCE of the stub appeared verbatim
throughout the response. That is exactly what transparent replacement looks
like from the user's perspective.

## Answers to the Research Questions (Stage 2 edition)

| Question | Answer |
|----------|--------|
| Can the proxy transparently replace the native advisor's response? | **YES** |
| Does the model trust and use the substitute advice? | **YES** — content paraphrased throughout the response |
| Does the user see any evidence of the swap? | **No hard errors.** The "⏺ ★ Insight" block rendered cleanly. Users see "the advisor highlights…" preamble as if it were a real native advisor consult. |
| Is any SSE parsing required? | **No.** Only request-body inspection (JSON) and chunk-level regex for id extraction. |
| Is the implementation reusable across executors? | **Yes.** The patch is in claudish monitor mode, which works for any firstParty Anthropic auth. For Sonnet-via-API-key users the same logic applies (different auth path, same handler). |

## Risks & Open Items (Still Unvalidated)

1. **Stub only.** Stage 2 replaced Opus's advice with a canned paragraph.
   Stage 2.1 needs to wire a real third-party model call (claudish's existing
   provider routing has `run_prompt`-equivalents for Gemini, GPT, Grok, Kimi,
   etc.). Estimated ~30 LOC change: swap `stubAdvisorAdvice(id)` for an
   async pre-fetch keyed by id, then `rewriteAdvisorToolResults(payload,
   precomputedMap.get.bind(precomputedMap))`.

2. **Cost of the initial Opus advisor call.** Because the request going to
   Anthropic still has the original `advisor_20260301` tool swapped but
   otherwise unchanged, Anthropic won't actually run the Opus advisor
   server-side (we stripped the beta flag + tool type). So we AREN'T paying
   for an Opus sub-inference we throw away. Need to verify this in billing.
   Evidence suggests `iterations[]` in the final `message_delta` had no
   `advisor_message` entry, confirming no server-side advisor call.

3. **Latency of the tool_use → rewrite round-trip.** There's a full extra
   client→server cycle (model emits tool_use → Claude Code sends tool_result →
   proxy rewrites → Anthropic continues). With a stubbed advice the cycle took
   ~100ms. With a real third-party call it'll be ~5-15s. Total session time
   would be 15-30s longer than native advisor (which is opaque server-side).

4. **Multi-turn advisor usage.** The model sometimes calls advisor multiple
   times per task. The id tracker is bounded to 256 entries (with FIFO
   eviction) to avoid unbounded memory growth. That should be fine for any
   realistic session.

5. **Claude Code renders "⎿ toolu_error" for the original (rewritten) turn.**
   I didn't see this in the visible transcript, but there's a possibility the
   UI briefly showed "No such tool available: advisor" before the rewrite
   took effect. Worth a re-test with debug flags to confirm UX cleanliness.

## Recommended Next Steps

- **Stage 2.1**: Replace `stubAdvisorAdvice` with a claudish async fetch
  against `gemini-3-pro-preview` or `gpt-5.4`, pre-computed per tool_use_id.
  This closes the real product story.
- **Add a CLI flag** `claudish --monitor --advisor <model>` so users can
  configure the third-party advisor without env vars.
- **Telemetry**: log cost + latency of the swap vs native baseline for the
  same prompt, to quantify "is it cheaper to do this than use native Opus
  advisor?".
- **UX polish**: If Claude Code briefly shows "No such tool available" during
  the tool_result round-trip, consider the alternative approach of fabricating
  a `server_tool_use`/`advisor_tool_result` pair in the outbound SSE stream.
  But only if real users complain — the current behavior is mostly invisible.

## Reproduce

```bash
cd /Users/jack/mag/claudish
bun test packages/cli/src/handlers/native-handler-advisor.test.ts  # 18/18

export CLAUDISH_SWAP_ADVISOR=1
export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.ndjson
export CLAUDISH_SWAP_ADVISOR_DUMP=1
bun run packages/cli/src/index.ts --monitor

# In Claude Code:
/advisor opus
# then:
"Design a distributed rate limiter. Consult the advisor before proposing an approach."

# Observe:
jq -c '{ts, kind, ids: (.ids // null), rewritten: (.rewrittenIds // null)}' /tmp/advisor-swap.ndjson
```
