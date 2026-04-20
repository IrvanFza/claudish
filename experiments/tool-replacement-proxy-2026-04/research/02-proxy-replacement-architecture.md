# Research Report: Transparent Advisor Tool Replacement via API Proxy

**Session**: dev-research-advisor-proxy-replacement-20260410-124844-e0f32539
**Date**: 2026-04-10
**Goal**: Build a system where Claude Code believes it's using native Anthropic advisor, but a proxy transparently routes the advisor sub-inference to third-party models via Claudish

---

## Executive Summary

**It IS possible via a proxy that implements its own tool execution loop**, but it's more nuanced than a simple pass-through. The key insight: the native advisor sub-inference is **opaque** — it happens inside Anthropic's server in a single request, and the streamed response is a *record* of what already happened, not a live conversation. You can't simply modify the stream to swap the advisor response, because the executor already consumed the original advice.

**The viable approach**: A proxy that replaces `advisor_20260301` (server tool) with a regular tool, forwards to the executor provider, then **handles the advisor tool call client-side** by routing to a third-party model. This uses the proxy's own tool execution loop — the executor generates → calls advisor (regular tool_use) → proxy intercepts → runs third-party model → sends tool_result back → executor continues with THIRD-PARTY advice.

The transport layer already exists (`ANTHROPIC_BASE_URL` + claude-code-router). What's missing is the **advisor protocol implementation** inside the proxy.

> **CORRECTION from background explorer**: Approach E (streaming interception) was initially rated as viable but is actually **cosmetic only** — the executor's continuation is already generated based on the original Opus advice. Only the regular-tool-replacement approach (where the proxy controls the tool loop) allows the executor to actually use third-party advice.

---

## The Architecture You Want

```
Claude Code
    │
    │ ANTHROPIC_BASE_URL=http://localhost:8082
    │ (Claude Code thinks it's talking to Anthropic)
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Advisor Proxy Server (NEW - to build)           │
│                                                  │
│  REQUEST PHASE:                                  │
│  1. Receives /v1/messages request                │
│  2. Sees advisor_20260301 in tools array         │
│  3. Replaces it with a regular tool:             │
│     { name: "advisor", description: "..." }      │
│  4. Forwards modified request to Provider A      │
│                                                  │
│  TOOL EXECUTION LOOP:                            │
│  5. Streams executor response to Claude Code     │
│  6. When response has stop_reason: "tool_use"    │
│     and tool name is "advisor":                  │
│     ──► Pause streaming to Claude Code           │
│     ──► Run Provider B with full transcript      │
│     ──► Get third-party advisor response         │
│     ──► Construct tool_result for "advisor"      │
│     ──► Send follow-up request to Provider A     │
│         with advisor result in messages          │
│     ──► Resume streaming continuation            │
│  7. Transform tool_use/tool_result blocks into   │
│     server_tool_use/advisor_tool_result for       │
│     Claude Code (so it looks native)             │
│                                                  │
│  Claude Code sees native-looking advisor flow    │
└──────────────────────────────────────────────────┘
         │              │
         ▼              ▼
  ┌─────────────┐ ┌──────────────┐
  │ Provider A  │ │ Provider B   │
  │ (Executor)  │ │ (Advisor)    │
  │ Claude via  │ │ Gemini/GPT/  │
  │ OpenRouter  │ │ Grok/etc     │
  └─────────────┘ └──────────────┘
```

### Critical Difference: Tool Execution Loop

The native Anthropic advisor is a **server tool** — the sub-inference happens inside the server's generation loop. Our proxy must implement its own **client-side tool execution loop**:

1. Send request to executor (with advisor as regular tool)
2. Executor generates → eventually emits `tool_use` for "advisor" with `stop_reason: "tool_use"`
3. **This is a standard tool call** — the response STOPS, waiting for a tool result
4. Proxy intercepts: runs third-party advisor model
5. Proxy sends follow-up request with `tool_result` containing the advisor's response
6. Executor continues generating, now informed by the THIRD-PARTY advice
7. Proxy transforms the tool_use/tool_result blocks to look like server_tool_use/advisor_tool_result before sending to Claude Code

**This means the executor actually uses the third-party advice** (not just cosmetic replacement), because the tool call creates a genuine request-response boundary.

---

## Why Simple Proxying Doesn't Work

### The Problem
The native advisor flow is **opaque**:
1. Client sends ONE request with executor + advisor tool
2. Server runs executor, detects advisor call, runs advisor, injects result
3. Client gets back the COMBINED response
4. There's no client-side round-trip where a proxy could intercept

### What Existing Proxies Do

| Proxy | What happens to advisor |
|-------|------------------------|
| **OpenRouter** (direct) | Forwards to Anthropic → advisor works natively (can't change model) |
| **LiteLLM** (passthrough) | Same — forwards to Anthropic → native advisor |
| **LiteLLM** (translated) | Routes to non-Anthropic provider → advisor NOT supported, stripped |
| **claude-code-router** | Routes to any provider → advisor stripped, custom transformers only |
| **Simple proxy** | Either passthrough (native) or translation (no advisor) |

**None can selectively replace the advisor model while keeping the executor native.**

---

## The Solution: Implement Advisor Protocol in the Proxy

### How It Works (Detailed)

**Step 1: Intercept the request**
```json
// Claude Code sends:
{
  "model": "claude-sonnet-4-6",
  "tools": [
    { "type": "advisor_20260301", "name": "advisor", "model": "claude-opus-4-6" },
    { "name": "Read", "input_schema": {...} },
    // ... other tools
  ],
  "messages": [...]
}
```

**Step 2: Transform for executor**
- Extract and store the advisor tool config (model, max_uses, caching)
- Replace `advisor_20260301` with a REGULAR tool that signals intent:
```json
{
  "name": "advisor",
  "description": "Call for strategic guidance from a stronger model. Invoke when facing complex decisions.",
  "input_schema": { "type": "object", "properties": {} }
}
```
- Forward modified request to executor provider (Anthropic via OpenRouter, or any provider)

**Step 3: Stream executor response**
- The executor runs normally, generating text and tool calls
- When the executor calls the "advisor" tool (regular `tool_use` block):
  - Proxy detects `{ "type": "tool_use", "name": "advisor" }`
  - **Pauses streaming to Claude Code**

**Step 4: Run third-party advisor**
- Proxy constructs advisor context: full transcript (system prompt + all messages + all tool results up to this point)
- Sends to Provider B (e.g., Gemini 3.1 Pro via OpenRouter):
```json
{
  "model": "gemini-3.1-pro-preview",
  "messages": [
    { "role": "system", "content": "You are an advisor to a coding agent..." },
    // ... full transcript context
  ]
}
```
- Gets advisor response (400-700 tokens)

**Step 5: Transform response for Claude Code**
- Replace the `tool_use` block with `server_tool_use`:
```json
{ "type": "server_tool_use", "id": "srvtoolu_xxx", "name": "advisor", "input": {} }
```
- Add `advisor_tool_result`:
```json
{
  "type": "advisor_tool_result",
  "tool_use_id": "srvtoolu_xxx",
  "content": { "type": "advisor_result", "text": "<advisor response>" }
}
```
- Resume streaming to Claude Code

**Step 6: Handle multi-turn**
- On subsequent turns, Claude Code passes back `advisor_tool_result` blocks verbatim
- Proxy preserves these in the message history
- Claude Code is none the wiser

### Key Implementation Challenge: Streaming Transformation

The hardest part is the **streaming transformation**:
1. Executor generates via SSE stream
2. When executor emits `tool_use` for "advisor", proxy must:
   a. Stop forwarding SSE events to Claude Code
   b. Buffer the `tool_use` event
   c. Run the advisor inference (5-15 seconds)
   d. Transform `tool_use` → `server_tool_use` + `advisor_tool_result`
   e. Send these as SSE events to Claude Code
   f. Continue forwarding the rest of the executor stream

This requires the proxy to be a **stateful streaming transformer**, not just a pass-through.

---

## Existing Foundation to Build On

### claude-code-router (Best Starting Point)

`claude-code-router` already has:
- Local proxy server architecture
- Transformer system for request/response modification
- Multi-provider routing
- Streaming support
- Custom JavaScript transformers
- Shell activation (`eval "$(ccr activate)"`)

**What to add**: An `advisor` transformer that:
1. Detects `advisor_20260301` in tools
2. Replaces with regular tool
3. Intercepts `tool_use` for "advisor"
4. Runs third-party model
5. Transforms response

### Claudish Integration

Claudish can serve as the advisor model router:
- Already handles model alias resolution
- Already routes to 100+ providers via OpenRouter
- `run_prompt()` provides one-shot model invocation
- Could be called from within the proxy transformer

---

## Alternative: The "Prompt Engineering" Approach

If building a full protocol implementation is too complex, there's a simpler path:

### Use ANTHROPIC_BASE_URL + Custom Executor System Prompt

1. Route executor through OpenRouter to Claude (still Anthropic model)
2. DON'T use native `advisor_20260301` tool at all
3. Instead, add a REGULAR tool called `consult_advisor` to Claude Code's tool set via MCP
4. The executor's system prompt (via CLAUDE.md) tells it to call `consult_advisor` at decision points
5. The MCP server routes `consult_advisor` calls to third-party models via Claudish

**Pros**: Much simpler, works today, no proxy protocol implementation needed
**Cons**: Not transparent — executor must be prompted to use it, it's a regular tool call not native advisor

---

## Implementation Roadmap

### Phase 1: Proof of Concept (1 week)
- Fork claude-code-router
- Add `advisor` transformer
- Handle non-streaming first (simpler)
- Route advisor to Gemini via OpenRouter
- Test with `ANTHROPIC_BASE_URL` pointing to local proxy

### Phase 2: Streaming Support (1-2 weeks)
- Implement SSE stream transformation
- Handle `tool_use` → `server_tool_use` conversion mid-stream
- Add `advisor_tool_result` injection
- Handle pause/resume of stream

### Phase 3: Multi-Model Advisor Routing (1 week)
- Integrate with Claudish alias resolution
- Support multiple advisor models per mode (architecture/debug/review)
- Add cost tracking and budget controls

### Phase 4: Multi-Turn Support (1 week)
- Handle `advisor_tool_result` blocks in subsequent turns
- Maintain conversation state across requests
- Handle `max_uses` counting

### Phase 5: Production Hardening
- Error handling (advisor timeout, model failures)
- Graceful fallback (if advisor fails, continue without)
- Latency monitoring
- Cost dashboards

---

## Approach Feasibility Matrix (from Explorer Agent)

| Approach | Score | Verdict |
|----------|-------|---------|
| A: Strip advisor, two-phase | 1/10 | NOT FEASIBLE — executor won't call advisor if tool missing |
| B: Replace with custom client tool | 2/10 | NOT FEASIBLE — server tool type requires Claude Code modification |
| C: Full model replacement | 4/10 | DEFEATS PURPOSE — replaces everything, not just advisor |
| D: OpenRouter/LiteLLM aliasing | 2/10 | NOT POSSIBLE — no hooks into server sub-inferences |
| E: Streaming interception | 5/10 | COSMETIC ONLY — executor already consumed original advice |
| **F: Regular tool + proxy loop** | **8/10** | **RECOMMENDED — proxy controls tool execution, executor uses third-party advice** |

## Technical Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Claude Code validates `server_tool_use` format strictly | Proxy response rejected | Reverse-engineer exact format from Anthropic responses |
| Claude Code checks response source (certificate pinning, etc.) | Proxy can't impersonate Anthropic | Use ANTHROPIC_BASE_URL (officially supported custom endpoints) |
| Streaming event format changes with Claude Code updates | Proxy breaks | Version detection, compatibility layer |
| `advisor_20260301` type rejected as regular tool by executor | Executor won't call it | Use Claude's regular tool mechanism with advisor-like naming |
| Token counting mismatch | Usage tracking breaks | Proxy tracks tokens from both providers, reports combined |
| `pause_turn` interaction with proxy | Unexpected behavior | Test thoroughly, handle all stop_reason values |

---

## What Makes This Different from Previous Research

| Previous Research (MCP Approach) | This Research (Proxy Approach) |
|----------------------------------|-------------------------------|
| Executor KNOWS it's calling an MCP tool | Executor DOESN'T KNOW advisor is replaced |
| Explicit tool invocation | Transparent replacement |
| Executor must construct context | Proxy constructs context from transcript |
| MCP tool visible in conversation | Advisor appears native |
| Works within Claude Code's tool system | Works at the API transport layer |
| Easy to implement | Requires custom API server |
| Requires prompt engineering for invocation | Uses executor's natural advisor-calling behavior |

---

## Recommendation

**Build an advisor transformer for claude-code-router** (or a standalone proxy). The architecture:

1. `ANTHROPIC_BASE_URL` → local proxy
2. Proxy forwards to OpenRouter → Anthropic for executor
3. Proxy intercepts advisor tool calls
4. Proxy routes advisor to Claudish → third-party model
5. Proxy stitches response together as native-looking advisor result
6. Claude Code sees native advisor behavior

This is the **transparent replacement** the user wants. It requires implementing the advisor protocol in the proxy, which is significant engineering work but architecturally clean.

---

## Key Sources

- [Claude Code LLM Gateway Docs](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code Router](https://github.com/musistudio/claude-code-router)
- [LiteLLM Proxy](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)
- [OpenRouter Claude Code Integration](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration)
- [Anthropic Advisor Tool Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [Claude Code Proxy Projects](https://github.com/fuergaosi233/claude-code-proxy)
