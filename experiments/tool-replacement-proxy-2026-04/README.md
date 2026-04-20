# Tool Replacement via API Proxy — Claude Code Extension Technique

**Status**: Active (Stage 2 PoC validated, Stage 2.1 pending)
**Dates**: 2026-04-10 → 2026-04-15 (active investigation)
**Category**: Claude Code extension technique, applicable beyond advisor tool

## Discovery

We found a **general technique for extending Claude Code's tool capabilities** at the API transport layer. By routing requests through claudish's monitor-mode proxy (`ANTHROPIC_BASE_URL`), we can:

1. **Replace server tools** with regular tools (the executor still calls them)
2. **Intercept tool_result blocks** from Claude Code and rewrite them before forwarding upstream
3. **Inject custom tools** into the request's tools array that Claude Code doesn't know about
4. **Modify system prompts** to guide tool invocation behavior

The advisor tool replacement was the first application, but the same pattern works for replacing or augmenting any native tool (Bash, Read, Grep, etc.) — or adding entirely new ones that Claude Code's client runtime doesn't implement.

## What Was Validated (with primary-source evidence)

| Claim | Evidence | File |
|-------|----------|------|
| Claude Code sends all API traffic through `ANTHROPIC_BASE_URL` | Recording proxy captured 100% of requests | `evidence/evidence-index.ndjson` |
| Advisor tool (`advisor_20260301`) is sent when `/advisor opus` is enabled | Request body with 88 tools, 88th is advisor | `evidence/evidence-req-advisor-enabled.json` |
| Proxy can swap server tool types for regular tools | Model called regular "advisor" tool after swap | `evidence/evidence-stage1-swap.ndjson` |
| Proxy can rewrite tool_result blocks before forwarding | Stub advice replaced Claude Code's "No such tool" error | `evidence/evidence-stage2-rewrite.ndjson` |
| Executor model uses the rewritten advice in its continuation | Opus paraphrased stub themes verbatim in its design | `evidence/evidence-stage2-ui-transcript.txt` |
| The Anthropic SDK accepts fabricated `server_tool_use` + `advisor_tool_result` blocks | SDK test against mock proxy passed | `poc/03-sdk-validation.ts` |
| Multi-turn round-trips preserve advisor blocks | SDK re-sends them verbatim | `poc/04-multi-turn-validation.ts` |

## Architecture

```
Claude Code  ──ANTHROPIC_BASE_URL──▸  Claudish Monitor Proxy
                                          │
                                    ┌─────┴──────┐
                                    │ Transform:  │
                                    │ 1. Swap tool│
                                    │    type     │
                                    │ 2. Strip    │
                                    │    beta hdr │
                                    │ 3. Rewrite  │
                                    │    tool_    │
                                    │    result   │
                                    └─────┬──────┘
                                          │
                                          ▼
                                    Anthropic API
                                    (or OpenRouter)
```

For the advisor use case specifically:

```
Request flow:
  Claude Code → advisor_20260301 in tools[] → proxy swaps for regular tool
  → Anthropic executor generates → emits tool_use{name:"advisor"}
  → stop_reason:tool_use → Claude Code sends tool_result{is_error:true}
  → proxy rewrites tool_result with third-party advice
  → Anthropic executor continues, using third-party advice
```

## How to Reproduce

### Prerequisites

- claudish repo at `/Users/jack/mag/claudish` with the advisor patch applied
- Claude Code with `/advisor opus` enabled (persisted in `~/.claude/settings.json`)
- The `tengu_sage_compass2` GrowthBook gate must be enabled for your account (check `~/.claude.json` → `cachedGrowthBookFeatures`)

### Stage 1: Tool swap only (detection)

```bash
cd /Users/jack/mag/claudish

# Apply the patch (if not already applied):
cp experiments-patch/native-handler-advisor.ts packages/cli/src/handlers/
# Then re-apply the native-handler.ts changes per claudish-patch/native-handler.patch

export CLAUDISH_SWAP_ADVISOR=1
export CLAUDISH_SWAP_ADVISOR_LOG=/tmp/advisor-swap.ndjson
bun run packages/cli/src/index.ts --monitor

# In Claude Code:
/advisor opus
"Design a rate limiter. Consult the advisor."

# Check:
jq -c '{kind, ids: .ids}' /tmp/advisor-swap.ndjson | grep tool_use_for_advisor
# Should show: tool_use_for_advisor with an id → Stage 1 passes
```

### Stage 2: Tool_result rewrite (stub advice)

Same as Stage 1, but the patch also rewrites the tool_result. Look for:
```bash
jq -c '{kind, ids: .ids}' /tmp/advisor-swap.ndjson | grep tool_result_rewritten
# Should show: tool_result_rewritten with the matched id
```

Then inspect Claude Code's response — it should paraphrase the stub's themes
(fail-open/fail-closed, token bucket, CAP tradeoff).

### Stage 2.1: Real third-party advisor (TODO — next step)

Replace `stubAdvisorAdvice()` in `native-handler-advisor.ts` with an async
call to claudish's provider router (Gemini, GPT, Grok, etc.). ~30 LOC.

### Running the standalone PoC tests (no Claude Code needed)

```bash
cd poc/
bun run 02-mock-advisor-proxy.ts --self-test          # SSE format self-test
bun run 05-tool-loop-proxy.ts --self-test             # tool-loop end-to-end
bun run 06-sdk-e2e-validation.ts                      # real SDK validation
```

### Running unit tests

```bash
cd /Users/jack/mag/claudish
bun test packages/cli/src/handlers/native-handler-advisor.test.ts
# 18 tests, all should pass
```

## Key Technical Findings

### 1. Claude Code's advisor gate (reverse-engineered from binary)

```js
function isAdvisorAvailable() {
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false;
  if (authType !== "firstParty" || !isExperimentalBetasEnabled()) return false;
  return growthBookGate("tengu_sage_compass2").enabled ?? false;
}

// The tool is only injected if the gate passes AND userSettings.advisorModel is set:
let model = resolveAdvisorModel(userSettings.advisorModel, mainModel);
if (model) tools.push({type: "advisor_20260301", name: "advisor", model});
```

Enablement: run `/advisor opus` (hidden when gate is closed). Persists to `~/.claude/settings.json`.

### 2. The model treats `advisor_20260301` server-tool differently from a regular tool named "advisor"

When native advisor is available, the model's trained behavior fires it proactively. When we swap to a regular tool, the model STILL calls it (our description was sufficient) but Claude Code's client doesn't know how to execute it → returns `is_error: true` with "No such tool available: advisor".

**The proxy intercepts that error and rewrites it with real advice.** The model then treats the advice as authoritative (tested: Opus paraphrased stub advice verbatim).

### 3. General technique: tool_result interception

The tool_result rewrite pattern is not advisor-specific. Any tool that Claude Code can't execute client-side (or that you want to override) can be handled this way:

1. Add/replace a tool definition in the outbound request
2. Model calls it → Claude Code fails → sends error tool_result
3. Proxy intercepts the error, substitutes a real result
4. Model continues with the substituted result

This could be used to:
- Replace `Bash` with a sandboxed execution environment
- Add a `web_browse` tool backed by a headless browser
- Replace `Grep` with a semantic search engine
- Add tools Claude Code doesn't natively support

## Directory Layout

```
tool-replacement-proxy-2026-04/
├── README.md                          # This file
├── research/                          # Research reports (chronological)
│   ├── 01-advisor-pattern-research.md # Multi-model team research
│   ├── 01-research-plan.md            # Decomposed research questions
│   ├── 02-proxy-replacement-architecture.md
│   ├── 03-how-to-enable-advisor.md    # Binary reverse-engineering results
│   ├── 04-real-test-results.md        # First live Claude Code test
│   ├── 05-stage1-tool-swap.md         # Tool swap validation
│   └── 06-stage2-tool-result-rewrite.md # End-to-end PoC results
├── poc/                               # Standalone PoC scripts (Bun/TS)
│   ├── README.md                      # Test matrix and reproduction
│   ├── 01-recording-proxy.ts          # Transparent passthrough + logging
│   ├── 02-mock-advisor-proxy.ts       # SSE format validation + self-test
│   ├── 03-sdk-validation.ts           # Real @anthropic-ai/sdk test
│   ├── 04-multi-turn-validation.ts    # Round-trip preservation test
│   ├── 05-tool-loop-proxy.ts          # Tool-loop replacement E2E
│   └── 06-sdk-e2e-validation.ts       # Full stack SDK validation
├── evidence/                          # Captured real traffic (primary source)
│   ├── evidence-index.ndjson          # All captured requests (metadata)
│   ├── evidence-req-advisor-enabled.json   # Real 342KB request with advisor tool
│   ├── evidence-resp-advisor-enabled.ndjson # Real SSE stream with server_tool_use
│   ├── evidence-stage1-swap.ndjson    # Stage 1: tool swap traffic (440KB)
│   └── evidence-stage2-rewrite.ndjson # Stage 2: rewrite traffic (440KB)
│   └── evidence-stage2-ui-transcript.txt  # Claude Code visible output (29KB)
├── claudish-patch/                    # The actual code changes
│   ├── native-handler-advisor.ts      # Swap + rewrite + id tracker + stub
│   ├── native-handler-advisor.test.ts # 18 unit tests
│   └── native-handler.patch           # Diff for native-handler.ts integration
└── journal/                           # Session notes (TODO: add per-day logs)
```

## Next Steps

1. **Stage 2.1**: Wire real third-party model (Gemini/GPT/Grok) into `stubAdvisorAdvice`
2. **Generalize**: Extract the tool-replacement pattern into a reusable claudish plugin/transformer
3. **Benchmark**: Compare native Opus advisor vs third-party advisor (quality, cost, latency)
4. **Explore**: Test replacing other tools (Bash → sandboxed, Grep → semantic search)
