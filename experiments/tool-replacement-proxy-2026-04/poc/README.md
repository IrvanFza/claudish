# Advisor-Replacement Proxy — Proof of Concept

This directory contains a working proof-of-concept validating that a proxy
CAN transparently replace Anthropic's native `advisor_20260301` tool with
third-party models, and that Claude Code (via the Anthropic SDK) accepts
the fabricated advisor blocks as if they were native.

## TL;DR — What's Validated

| # | Assumption | Test | Status |
|---|------------|------|--------|
| 1 | Claude Code sends `advisor_20260301` when advisor is enabled | `01-recording-proxy.ts` | ⏳ user-run |
| 2 | Proxy can return well-formed SSE with `server_tool_use` + `advisor_tool_result` blocks | `02-mock-advisor-proxy.ts --self-test` | ✅ PASS |
| 3 | The real `@anthropic-ai/sdk` parses fabricated advisor events without errors | `03-sdk-validation.ts` | ✅ PASS |
| 4 | Multi-turn round-trip — SDK sends advisor blocks back verbatim | `04-multi-turn-validation.ts` | ✅ PASS |
| 5 | Regular-tool-replacement approach: executor calls a normal tool, proxy intercepts | `05-tool-loop-proxy.ts --self-test` | ✅ PASS |
| 6 | **End-to-end**: third-party advice actually reaches and influences the executor | `06-sdk-e2e-validation.ts` | ✅ PASS |

## Files

### `01-recording-proxy.ts` — Transparent recording proxy
A passthrough proxy on `:8787` that forwards every request to
`api.anthropic.com` verbatim and logs:
- Request JSON + headers → `logs/req-NNNN-_v1_messages.json`
- Response SSE events (parsed to NDJSON) → `logs/resp-NNNN-_v1_messages.ndjson`
- Flags advisor-related requests/events in bold text

Use this to capture what Claude Code actually sends when advisor is enabled.

```sh
bun run 01-recording-proxy.ts
# In another terminal, with a real Anthropic API key:
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY
claude
# Ask Claude Code something that should trigger advisor use.
# Then: ls logs/ and inspect the captured files.
```

### `02-mock-advisor-proxy.ts` — SSE format validator
A mock `/v1/messages` server that does NOT forward upstream. It fabricates
a complete SSE stream containing text + `server_tool_use` + `advisor_tool_result`
+ continuation text blocks.

```sh
bun run 02-mock-advisor-proxy.ts --self-test
# → reconstructs the message from its own output and verifies shape
```

### `03-sdk-validation.ts` — Real SDK validates the mock
Points `@anthropic-ai/sdk@0.88.0` (the same SDK Claude Code uses) at the
mock proxy and asks it to stream a message. Passes if the SDK reconstructs
our 4-block advisor message without errors.

```sh
bun run 02-mock-advisor-proxy.ts &
bun run 03-sdk-validation.ts
```

### `04-multi-turn-validation.ts` — Multi-turn round-trip
Runs two turns of a conversation with advisor blocks in the history.
Passes if the SDK sends the advisor blocks back verbatim on turn 2 without
validation errors (important because Anthropic's API returns 400 if you
strip them mid-conversation).

```sh
bun run 02-mock-advisor-proxy.ts &
bun run 04-multi-turn-validation.ts
```

### `05-tool-loop-proxy.ts` — The real architecture
Implements the "tool-loop advisor replacement" approach end-to-end:
1. Detects `advisor_20260301` in the client request
2. Replaces it with a regular tool definition
3. Forwards to a mock executor
4. Intercepts `tool_use` calls for "advisor"
5. Runs a mock third-party advisor with the full transcript
6. Feeds the advice back to the executor as a `tool_result`
7. Collects the executor's continuation
8. Transforms everything into client-facing `server_tool_use` +
   `advisor_tool_result` blocks

```sh
bun run 05-tool-loop-proxy.ts --self-test
```

The mock executor is programmed to echo the advice it received in its
continuation text. A canary string ("THIRD_PARTY_ADVICE_MARKER") is used
to verify the third-party advice actually flowed through — not the original
one that would have been produced by Anthropic.

### `06-sdk-e2e-validation.ts` — Real SDK against the tool-loop proxy
The strongest test we can run without Claude Code: the real Anthropic SDK
calls the tool-loop proxy, which runs the full pipeline. The SDK gets back
a message whose final text contains the canary string, proving the advice
round-tripped correctly.

```sh
bun run 06-sdk-e2e-validation.ts
```

## Running Claude Code Through the Proxy (The One Remaining Validation)

We've validated that:
- The SSE format is wire-compatible with the Anthropic SDK
- Multi-turn round-trips work
- The tool-loop logic correctly swaps in third-party advice
- The executor's continuation is informed by third-party advice, not Anthropic's

What remains is to run Claude Code itself through a proxy that forwards to
real Anthropic for the executor and calls real third-party models for the
advisor. This requires:

1. A real `ANTHROPIC_API_KEY` (for the executor)
2. An `OPENROUTER_API_KEY` (for the third-party advisor)
3. A small change to `05-tool-loop-proxy.ts` to use real backends instead of mocks

The proxy architecture in `05-tool-loop-proxy.ts` is already correct — only
the `callExecutor()` and `callThirdPartyAdvisor()` URLs need to change.

To do this real validation:
```sh
# Pseudocode — requires completing the real-backend version:
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
bun run 05-tool-loop-proxy.ts  # with real backends
# In another terminal:
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
export ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY
claude
# Ask it to solve something complex. Observe:
#  - Claude Code's UI should show "Advisor consulted" as if it were native
#  - The proxy logs should show a call to the third-party advisor model
#  - The resulting advice comes from the third-party model, not Opus
```

## What We Proved — and What We Didn't

### Proved
- The Anthropic wire protocol for advisor is reproducible by a proxy
- The Anthropic SDK accepts proxy-generated advisor blocks as valid
- Multi-turn state survives proxy round-trips
- The "replace advisor with regular tool + intercept tool_use + inject tool_result"
  approach works: the executor actually uses the third-party advice in its continuation
- A real E2E flow (Anthropic SDK → tool-loop proxy → mock executor + mock advisor)
  produces a wire-compatible response the SDK happily parses

### Not yet proved
- Claude Code specifically (vs the SDK) treats our fabricated blocks as native advisor UX
- Streaming-mode tool-loop works (this PoC uses non-streaming for the tool-loop;
  Phase 4 would implement SSE streaming end-to-end)
- Real Anthropic executor + real third-party advisor (needs API keys)
- Performance/latency of the full pipeline under realistic loads

### Known limitations of the PoC
- `06-sdk-e2e-validation.ts` uses **non-streaming** (`messages.create`) because
  the tool-loop proxy returns a single JSON message. Claude Code prefers streaming.
  Implementing streaming means:
    1. Keep the executor response non-streaming internally (much simpler)
    2. But re-emit the final combined response as an SSE stream to the client
  This is ~100 LOC more of SSE event generation; the logic is identical.
- The mock executor is trivial: it either calls the advisor or doesn't. A real
  executor might call the advisor multiple times per turn, interleave it with
  other tools, etc. The `MAX_ITERATIONS` cap in the proxy handles this.

## Next Steps to Production

1. **Streaming output**: adapt the tool-loop proxy to emit SSE events for
   the final combined message (reuse the event builder from `02-mock-advisor-proxy.ts`)
2. **Real backend adapters**: point `callExecutor()` at `https://api.anthropic.com`
   and `callThirdPartyAdvisor()` at OpenRouter/Claudish
3. **Context packaging**: currently we forward the entire transcript to the advisor;
   in production we'd use the "advisor packet" approach from the previous research
   (summary-first, artifacts on demand)
4. **Error handling**: timeout handling, fallback to native advisor on third-party
   failure, per-request cost caps
5. **Multi-advisor consensus**: run multiple third-party models in parallel and
   synthesize (leverages Claudish's existing `/team` pattern)
6. **Observability**: log every advisor call, cost, latency, and diff between
   what Opus would have said vs the third-party advice (optional compare mode)
