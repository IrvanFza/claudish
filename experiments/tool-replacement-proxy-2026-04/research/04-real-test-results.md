# Real-Claude-Code Test Results (2026-04-14)

## TL;DR

Ran real Claude Code 2.1.107 through the recording proxy. Captured real traffic.
**Claude Code does NOT currently send `advisor_20260301` in its tools array**, even
though it advertises the `advisor-tool-2026-03-01` beta in every request header.

This invalidates the "swap advisor_20260301 for a regular tool" assumption at the
heart of the previous architecture report. The replacement approach still works,
but the architecture is simpler than previously assumed.

## What Was Tested

**Setup** (real, not mocked):
- Claude Code 2.1.107 (`/Users/jack/.local/bin/claude`)
- Bun 1.3.10 recording proxy on `127.0.0.1:8787`
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
- `ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY` → proxy translates
  `Authorization: Bearer sk-ant-*` → `x-api-key: sk-ant-*` before forwarding
- Two helper panes in tmux, observed interactively

**Prompts issued through Claude Code**:
1. `What is 2+2? Answer in one word.` — trivial, got "Four"
2. `Walk me through the architecture of a distributed rate limiter. Think carefully about the tradeoffs.` — complex, got a thoughtful multi-paragraph answer

Both requests ran successfully through the proxy (auth worked, streaming worked).

## What Was Captured

### Request shape (from `logs/req-0003-_v1_messages.json`, the main session call)

```
model: claude-sonnet-4-6
tools count: 87
betas field (body): None     ← no body-level betas
top-level keys: model, messages, system, tools, metadata, max_tokens,
                temperature, output_config, stream
output_config: {'effort': 'high'}
```

**Advisor-related content**: NONE. Zero tools had `type: "advisor_20260301"`.
The only "advisor" string in the request was in the working directory path
(coincidence — this session directory contains the word "advisor").

### Headers actually sent by Claude Code

```
authorization: Bearer sk-ant-api03-...
anthropic-beta: claude-code-20250219,
                interleaved-thinking-2025-05-14,
                redact-thinking-2026-02-12,
                context-management-2025-06-27,
                prompt-caching-scope-2026-01-05,
                advisor-tool-2026-03-01,        ← advisor beta declared
                effort-2025-11-24
anthropic-version: 2023-06-01
```

So Claude Code declares the beta but doesn't invoke the tool.

### Response shape (from `logs/resp-0003-_v1_messages.ndjson`)

Event sequence captured:
```
message_start → content_block_start → ping → content_block_delta → content_block_stop
              → message_delta → message_stop
```

Relevant detail from `message_delta.usage.iterations[]`:
```
iterations=['message']  ← EXACTLY ONE iteration of type "message"
```

Per Anthropic's advisor docs, a request that actually invokes the advisor returns
a `usage.iterations[]` array with multiple entries, including one with
`type: "advisor_message"` and the advisor model name. We observed **no such
iteration in any of the 3 real `/v1/messages` calls**. This confirms, from
Anthropic's own server-side accounting, that no advisor sub-inference ran.

## Per-Request Summary

| Req | Model | Tools | `advisor_20260301` in tools | `advisor-tool-2026-03-01` header | Response `iterations` |
|---|---|---|---|---|---|
| 2 | haiku-4-5 | 0 | no | yes | `[message]` |
| 3 | sonnet-4-6 | 87 | no | yes | `[message]` |
| 4 | sonnet-4-6 | 87 | no | yes | `[message]` |

## Bugs Found and Fixed in the PoC

Running against real traffic immediately exposed two bugs in the recording proxy
that no amount of SDK-mock testing would have caught:

### Bug 1: Bearer token → x-api-key mismatch
Claude Code sends `Authorization: Bearer sk-ant-api03-*` when
`ANTHROPIC_AUTH_TOKEN` is set. Anthropic's `/v1/messages` accepts `x-api-key`
for API key auth, not bearer. Every request returned 401.

**Fix**: In `01-recording-proxy.ts`, if the forwarded `Authorization` header is
`Bearer sk-ant-api*`, strip it and set `x-api-key` instead.

### Bug 2: Gzip double-decompression
Bun's `fetch` auto-decompresses upstream response bodies. The proxy was
forwarding the original `content-encoding: gzip` header with already-decompressed
bytes. Claude Code tried to gunzip plaintext and crashed with "Decompression
error: ZlibError".

**Fix**: Strip `content-encoding` and `content-length` from the response headers
before returning them to the client.

Both fixes landed in `poc/01-recording-proxy.ts`. After the fixes, both the
trivial and the complex prompts flowed through the proxy end-to-end with no
errors and produced real answers from Anthropic.

## Implications for the Architecture

The previous research (and the mock-validated PoC in `poc/05-tool-loop-proxy.ts`)
assumed:

> Claude Code sends `advisor_20260301` in requests → proxy swaps it for a
> regular tool → executor calls the regular tool → proxy intercepts → runs
> third-party advisor → returns tool_result → executor continues → proxy
> transforms `tool_use` back to `server_tool_use` + `advisor_tool_result`.

**The "Claude Code sends advisor_20260301" premise is FALSE** in Claude Code
2.1.107 at the time of this test. There is nothing to swap.

## Two Honest Paths Forward

### Path A: Inject advisor_20260301 in the proxy, forward to Anthropic
The proxy ADDS `{type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6"}`
to every request before forwarding to real Anthropic. The executor then calls
the native advisor, which runs Opus server-side. This actually works today —
but it gives us native advisor with Opus, which is what Anthropic already does.
**It does not let us swap in a third-party advisor** because the advisor
sub-inference happens server-side inside Anthropic's infrastructure, opaque
to the proxy.

### Path B: Inject a regular tool named "consult_advisor" + system prompt nudge
The proxy ADDS a regular tool to every request:
```json
{
  "name": "consult_advisor",
  "description": "Consult the strategic advisor for guidance on complex decisions. No parameters.",
  "input_schema": {"type": "object", "properties": {}}
}
```
Plus prepends a one-line system prompt instruction: "For complex architectural
or debugging decisions, call `consult_advisor` before committing to an approach."

When the executor calls the tool, the proxy intercepts, runs a third-party
advisor (Gemini/GPT/Grok via Claudish), and returns the advice as a `tool_result`.
Executor continues generation informed by the third-party advice. No transformation
back to `server_tool_use` is needed because Claude Code already handles normal
`tool_use` blocks natively.

**Advantages of Path B over the original architecture**:
- Works with any backend: Anthropic direct, OpenRouter, LiteLLM, etc.
- No wire-format transformation — the client sees regular tool calls
- No reliance on the advisor beta at all
- Doesn't matter whether Claude Code sends `advisor_20260301` or not
- The PoC's tool-loop logic (in `05-tool-loop-proxy.ts`) is reusable with just
  two small changes: skip the `extractAdvisorTool` step, and don't transform
  the output blocks at the end.

**Risk of Path B** (unchanged from previous research):
- The executor model must be convinced by the system-prompt nudge to actually
  call `consult_advisor` at the right moments. Native advisor has special
  training for this; our regular tool does not. Measuring actual call frequency
  requires running it live.

## Remaining Unknowns

1. Does Claude Code ever send `advisor_20260301` under some other condition?
   (Different effort level? A specific flag? A later release?)
2. What would Anthropic do if we inject `advisor_20260301` in the proxy?
   (Does the executor call it? Does it succeed? Does it fail with a beta mismatch?)
3. For Path B: how reliably does Sonnet 4.6 call a regular `consult_advisor`
   tool given only a one-line system prompt nudge? Needs empirical measurement.

Each of these is a concrete follow-up experiment, not a research question.

## Files

- `poc/01-recording-proxy.ts` — recording proxy, now with bearer→x-api-key and
  gzip header fix
- `poc/logs/req-0003-_v1_messages.json` — real Claude Code request, 242KB, 87 tools
- `poc/logs/resp-0003-_v1_messages.ndjson` — real Anthropic response stream
- `poc/logs/index.ndjson` — index of all captured requests with metadata
