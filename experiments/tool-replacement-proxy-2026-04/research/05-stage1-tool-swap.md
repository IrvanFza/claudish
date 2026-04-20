# Stage 1 Results — Advisor Tool Swap Validation

**Date**: 2026-04-15
**Claude Code**: v2.1.108
**Executor model**: claude-opus-4-6 (Claude Max subscription, high effort)
**Proxy**: claudish monitor mode, patched with experimental advisor-swap transformer

## The Question

If we swap Anthropic's native server tool `{type: "advisor_20260301", name: "advisor"}`
for a regular tool of the same name, does the executor model still call it at the same
decision points it would have called the native advisor?

## The Answer

**YES** — with a caveat that actually simplifies Stage 2.

## What The Proxy Did

Patch: `claudish/packages/cli/src/handlers/native-handler.ts` +
`claudish/packages/cli/src/handlers/native-handler-advisor.ts`
(both gated behind `CLAUDISH_SWAP_ADVISOR=1` env var; zero effect when unset).

For each outbound request to `api.anthropic.com`:
1. Find any `{type: "advisor_20260301", ...}` in `tools[]` and replace with a regular
   tool definition named `"advisor"` (with a description that mirrors the native
   advisor's invocation guidance, plus empty `input_schema`).
2. Strip `advisor-tool-2026-03-01` from the `anthropic-beta` header so the server
   doesn't complain about a beta flag without a matching server tool.

Everything else is forwarded verbatim.

## Observed Behavior (captured traffic, `evidence-stage1-swap.ndjson`)

Scenario: user typed "Design a sharded counter service. Think carefully and consult the
advisor before committing to an approach."

Timeline:

```
T+0.000  request #1: title-classifier (Haiku) — no tools, no swap needed
T+21.3   request #2: user prompt arrives — 183 tools, advisor_20260301 swapped for regular tool
T+22.2   response #2: stop_reason=end_turn (preamble response only)

T+33.0   response #2 continues: emits tool_use block
         { name: "advisor", input: {}, id: toolu_011Np8dPfVZyKy296XW2Vzn1 }
         stop_reason=tool_use
T+33.1   request #3: Claude Code's follow-up carries a tool_result block:
         {
           tool_use_id: "toolu_011Np8dPfVZyKy296XW2Vzn1",
           is_error: true,
           content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>"
         }
T+40.2   response #3: model calls advisor AGAIN
         (new tool_use_id: toolu_01HSeTsXcj9H2EVmZ1kJdWnt, stop_reason=tool_use)
```

## Key Observations

1. ✅ **The model still calls the regular `advisor` tool.** Opus emitted `tool_use` for
   `advisor` at the same "before-substantive-work" moment the native tool would have
   fired. Our 4-line description was sufficient — no system-prompt nudge was needed.

2. ✅ **Claude Code's tool loop fires naturally.** It looked up "advisor" in its
   client-side tool registry, didn't find it, and generated a clean
   `tool_result` with `is_error: true` and content
   `"<tool_use_error>Error: No such tool available: advisor</tool_use_error>"`.
   No crash, no halt — the model just continued with the error.

3. ✅ **The model retries the advisor after an error.** Even after receiving the
   "No such tool" error, Opus called the advisor a second time on the next turn.
   This suggests the trained "consult advisor" behavior is robust to transient
   failures and we don't need to worry about single-shot misses.

4. ⚠️ **The UI displayed "No advisor tool available in this context"** — but this
   was the model's own narration after getting our error result, NOT a Claude Code
   runtime failure. Users would see this as a subpar experience. That's what Stage 2
   fixes.

5. ✅ **No `server_tool_use` / `advisor_tool_result` emissions** after the swap. The
   server respected our request: regular tool in → regular tool_use out. This means
   our decision to strip the `advisor-tool-2026-03-01` beta header was correct.

## Implication for Stage 2

**The hard path I was planning (inline SSE surgery) is unnecessary.** The easy path:

### Stage 2 design: intercept the inbound tool_result, not the outbound stream

The proxy already sees every inbound request. When Claude Code sends a follow-up
request whose last user message contains a `tool_result` block where:
- `tool_use_id` matches an id we logged as an advisor tool_use, OR
- `content` matches `"No such tool available: advisor"` (or similar)

The proxy REWRITES that `tool_result` block, replacing it with a successful
`tool_result` whose `content` is the output of a third-party advisor call
(via claudish's existing handler system — Gemini, GPT, Grok, etc.) on the
full conversation transcript.

The model then sees a successful advisor result and proceeds normally.

Pros:
- No SSE parsing needed (inbound JSON requests only)
- Reuses claudish's existing provider routing (one `run_prompt`-equivalent call)
- Idempotent: if Claude Code eventually implements "advisor" client-side, our
  rewrite will just be a no-op
- Compatible with the existing tool_use retry pattern — we answer the retry just
  as well as we answer the first call

Cons:
- Requires tracking advisor `tool_use_id`s across requests (small in-memory map)
- The model wastes ~1 round-trip (the initial error tool_result is sent but
  replaced before reaching Anthropic)
- Still shows the "No such tool available" text briefly in Claude Code's UI if
  the user watches the model's streamed preamble before the retry

### Even simpler alternative (possibly best-of-all): pre-register "advisor" as an MCP tool

Instead of intercepting in the proxy at all, we could:
1. Register an MCP tool named `advisor` via a lightweight MCP server claudish
   already knows how to run.
2. Claude Code would then find "advisor" in its client-side registry, invoke
   the MCP tool for execution, and get a real result.
3. The MCP server routes to a third-party model via claudish's handler system.

This is architecturally the cleanest (no proxy interception, standard MCP
contract, pluggable backends) but requires a new MCP server which is out of
scope for a quick experiment.

### Recommended next step

Stage 2 via proxy-side tool_result rewrite is simpler to implement (probably
~150 LOC in a new `native-handler-advisor-complete.ts` module) and directly
answers the original research question: *"Can we transparently replace the
native advisor with a third-party model?"*

The MCP-server path is worth considering for the long-term product story but
can follow Stage 2, not precede it.

## Artifacts

- `evidence-stage1-swap.ndjson` — full captured traffic including request bodies
- `claudish/packages/cli/src/handlers/native-handler.ts` — patched handler
- `claudish/packages/cli/src/handlers/native-handler-advisor.ts` — the transformer

## Reproduce

```bash
# from claudish repo
export CLAUDISH_SWAP_ADVISOR=1
export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.ndjson
export CLAUDISH_SWAP_ADVISOR_DUMP=1  # optional — dumps full request bodies
bun run packages/cli/src/index.ts --monitor
# then in Claude Code:
/advisor opus
# then send any prompt asking for design advice
```
