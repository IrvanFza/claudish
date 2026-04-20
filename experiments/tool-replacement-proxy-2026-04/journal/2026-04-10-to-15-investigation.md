# Investigation Journal: 2026-04-10 → 2026-04-15

## Day 1 (April 10): Research Phase

**Goal**: Understand Anthropic's advisor tool pattern and whether we can integrate
it with Claudish/third-party models.

### What happened
- Fetched full Anthropic advisor tool documentation (platform.claude.com)
- Ran `/team` multi-model analysis across 7 external models (GPT-5.4, Gemini,
  MiniMax, Kimi, GLM, Qwen, Grok). Only GPT-5.4 (30K chars) and Gemini (8.6K)
  responded; 5 timed out at 600s.
- Launched 3 parallel researcher agents for sub-questions (test harness, hooks/MCP
  feasibility, model cost analysis)
- All sources converged on "hybrid MCP + prompt guidance" architecture
- Key finding: Anthropic has NOT published a public test harness for advisor

### Key decisions
- Decided to investigate the "transparent proxy replacement" angle after user
  feedback that they want Claude Code to THINK it's using native advisor

## Day 2-3 (April 10-14): Proxy Architecture & PoC

### What happened
- Built 6 standalone PoC scripts (Bun/TypeScript):
  - Recording proxy (passthrough + logging)
  - Mock advisor proxy (SSE format validation)
  - SDK validation (real @anthropic-ai/sdk@0.88.0 test)
  - Multi-turn round-trip test
  - Tool-loop proxy (full replacement E2E)
  - SDK end-to-end validation
- All 5 automated tests passed against mocks
- **BUT**: I overclaimed "approach validated" when all tests used mocks

### Critical correction (user pushed back)
User called out that SDK mock tests aren't real validation. This led to...

## Day 3 (April 14): Real Claude Code Traffic Capture

### What happened
- Built recording proxy, ran real Claude Code through it via tmux split panes
- **Bug #1**: 401 Unauthorized — Claude Code sends `Authorization: Bearer sk-ant-*`
  but Anthropic expects `x-api-key`. Fixed: translate header in proxy.
- **Bug #2**: ZlibError — Bun auto-decompresses but proxy forwarded original
  `content-encoding: gzip` header. Fixed: strip encoding headers.
- After fixes: captured 3 real `/v1/messages` requests

### THE FINDING that changed everything
All 3 requests had `advisor-tool-2026-03-01` in the beta header but
**zero** had `advisor_20260301` in the tools array. `hasAdvisor: false` on
every request.

**Initial conclusion**: "Claude Code doesn't send advisor tool." This was WRONG.

### Binary reverse-engineering
- Ran `strings` on Claude Code 2.1.107 binary (87MB)
- Found the advisor gate function chain:
  ```
  Xx() → tengu_sage_compass2 GrowthBook gate
  sqH() → firstParty auth + !DISABLE_EXPERIMENTAL_BETAS
  AI9() → requires userSettings.advisorModel to be set
  ```
- Discovered `/advisor opus|sonnet|off` slash command (hidden when gate is closed)
- Found `advisorModel: None` in my settings → that's why no tool was sent
- Checked `~/.claude.json` → `tengu_sage_compass2: {enabled: true}` → gate IS open for me
- **THE ANSWER**: run `/advisor opus` to enable it. That's it.

### Verification
- Ran `/advisor opus` → "Advisor set to Opus 4.6"
- Re-sent a prompt → proxy captured request with 88 tools, 88th was `advisor_20260301`
- Response stream contained `server_tool_use` + `advisor_tool_result` blocks
- `message_delta.usage.iterations` had 3 entries including
  `advisor_message model=claude-opus-4-6 in=68736 out=1008`
- **Complete end-to-end native advisor flow captured through proxy**

## Day 4 (April 15): Stage 1 + Stage 2 Validation

### Stage 1: Tool Swap
- Patched claudish's NativeHandler to swap `advisor_20260301` → regular tool
- Also strips `advisor-tool-2026-03-01` from beta header
- Ran real Claude Code through patched proxy
- **Result**: Opus emitted `tool_use{name:"advisor"}` → **model DID call the
  regular tool**
- Claude Code returned `tool_result{is_error:true, content:"No such tool available: advisor"}`
- Model even retried the advisor call after the error

### Stage 2: Tool_result Rewrite
- Extended patch: track advisor tool_use ids from streamed responses, intercept
  matching inbound tool_results, replace error content with stub advice
- **Result**: proxy rewrote the error → model received stub advice → Opus's
  continuation quoted the stub themes verbatim:
  - "The advisor highlights: the failure mode (fail-open vs fail-closed) is the
    single most important decision"
  - Architecture: Local Token Bucket + Central Quota Coordinator + Cross-Region CRDT
  - All themes from the 5-line canary stub

### Stage 2 conclusion
**Transparent advisor replacement works end-to-end.** The model treats proxy-injected
advice identically to native Opus advisor advice.

## Failures and Wrong Turns

1. **"Approach validated" overclaim** — Mock tests passed but real traffic exposed
   two bugs (auth header, gzip) that would have been showstoppers in production.
   Lesson: never claim validation without live traffic.

2. **"Claude Code doesn't send advisor_20260301"** — Wrong. It does, but only
   after `/advisor opus`. The binary reverse-engineering was needed to discover
   the hidden slash command. Without it we would have built the wrong
   architecture (injecting a new MCP tool instead of intercepting the native one).

3. **SSE stream surgery assumption** — Early architecture assumed we'd need to
   parse and rewrite SSE events mid-stream. The actual solution is much simpler:
   rewrite the inbound JSON tool_result, no SSE parsing needed.

4. **5/7 external models timed out in /team** — MiniMax, Kimi, GLM, Qwen, Grok
   all failed at 600s timeout. Only GPT-5.4 and Gemini produced usable analysis.

## What We Learned (Generalizable)

1. `ANTHROPIC_BASE_URL` gives full control of Claude Code's API transport —
   officially supported, not a hack
2. Claude Code's tool loop handles unknown tools gracefully (clean error, no crash)
3. Inbound tool_result rewrite is a general extension pattern, not advisor-specific
4. GrowthBook feature flags gate unreleased features; cached in `~/.claude.json`
5. Binary reverse-engineering via `strings` + regex is effective for finding
   undocumented slash commands and feature gates
