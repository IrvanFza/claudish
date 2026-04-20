# Research Plan: Advisor Tool Pattern + Claudish Integration

**Session:** dev-research-advisor-tool-claudish-20260410-113936-42c61676
**Date:** 2026-04-10
**Status:** Planning

---

## Background

Anthropic's **Advisor Tool** (beta `advisor-tool-2026-03-01`, type `advisor_20250301`) pairs a fast executor model with a higher-intelligence advisor model in a single `/v1/messages` request. The advisor sees the full transcript and returns strategic guidance. Currently restricted to Anthropic model pairs (Haiku->Opus, Sonnet->Opus, Opus->Opus).

**Goal:** Determine whether and how we can extend this pattern to third-party models via Claudish/Claudish-MCP, enabling users to use Grok, Gemini, GPT-5, DeepSeek, etc. as advisors for Claude executors (or vice versa).

---

## Q1: Can We Simulate the Advisor Pattern with Third-Party Models via Claudish?

### Sub-Questions

1. **Protocol analysis:** What exactly does the advisor tool send to the advisor model? Is it the full message history, a summary, or a structured query? What is the response format?
2. **Latency budget:** How much latency does the advisor call add to the executor's turn? Is there a timeout? Does the executor block or continue speculatively?
3. **Invocation semantics:** Does the executor decide when to call the advisor, or is it called on every turn? Can the executor ignore advisor guidance?
4. **Transcript visibility:** Does the advisor see tool results, system prompts, and cached content, or just user/assistant messages?
5. **Simulation fidelity:** What minimum subset of the advisor protocol must we replicate for a useful third-party implementation?

### Success Criteria

- [ ] Complete specification of the advisor tool's request/response protocol documented
- [ ] Identified which aspects can be replicated outside Anthropic's API and which cannot
- [ ] Feasibility verdict: YES (full simulation), PARTIAL (degraded but useful), or NO (fundamental blockers)
- [ ] If YES/PARTIAL: architectural sketch of how claudish would provide the advisor interface

### Information Sources

- Anthropic API documentation: `/v1/messages` with `advisor_20250301` tool type
- Anthropic developer blog posts and announcements (March 2026+)
- Anthropic cookbook / GitHub examples for advisor tool usage
- Claude API changelog entries for `advisor-tool-2026-03-01` beta
- Community implementations and discussions (GitHub, Discord, forums)
- Direct experimentation: send requests with advisor tool to observe behavior

---

## Q2: What Integration Points Exist in Claude Code?

### Sub-Questions

1. **Hook-based interception:** Can `PreToolUse` hooks intercept tool calls and inject advisor consultation before execution? What is the latency impact of a hook that makes an external API call?
2. **MCP tool surface:** Could claudish-mcp expose an `advisor` tool that Claude Code's executor treats like the native advisor? Does Claude Code's tool routing distinguish advisor-type tools from regular tools?
3. **System prompt augmentation:** Can we instruct the executor (via system prompt or CLAUDE.md) to proactively consult an external model before complex decisions? How reliable is this compared to a native tool?
4. **PostToolUse feedback loop:** Could PostToolUse hooks send tool results to an external advisor and inject corrective guidance into the conversation?
5. **SessionStart initialization:** Can we set up advisor context at session start (pre-warm external model, establish session state)?
6. **Stop hook reflection:** Can the Stop hook trigger an advisor-based retrospective that feeds into future sessions?

### Success Criteria

- [ ] Matrix of all Claude Code extension points with advisor-pattern compatibility ratings
- [ ] Identified the most promising integration point(s) with rationale
- [ ] Documented any Claude Code limitations that block or constrain integration
- [ ] Prototype-ready specification for the top 1-2 integration approaches

### Information Sources

- Claude Code hooks documentation (PreToolUse, PostToolUse, SessionStart, Stop, SubagentStop)
- Claude Code plugin system internals: `plugin.json` manifest format, hook execution model
- Claudish MCP tool definitions: `create_session`, `run_prompt`, `team`, etc.
- Existing hook implementations in magus plugins (multimodel, dev, terminal, gtd, code-analysis)
- Claude Code source behavior: hook timeout limits, async vs sync execution

---

## Q3: Does Anthropic Publish a Test Harness for Advisor Tool Validation?

### Sub-Questions

1. **Official evaluation framework:** Has Anthropic released any benchmark suite, evaluation scripts, or test harness specifically for the advisor tool pattern?
2. **Published metrics:** What metrics did Anthropic use in "early benchmarks" mentioned in advisor tool documentation? (Task completion, tool efficiency, plan quality, cost?)
3. **Open-source tooling:** Are there GitHub repositories (anthropic-cookbook, anthropic-quickstarts, community forks) with advisor tool evaluation code?
4. **SWE-bench integration:** Did Anthropic evaluate the advisor pattern on SWE-bench, HumanEval, or similar coding benchmarks? Are those configurations public?
5. **A/B testing methodology:** How did Anthropic compare advisor-augmented vs. standalone performance? What statistical methods were used?

### Success Criteria

- [ ] Catalog of all publicly available advisor tool evaluation resources (repos, docs, blog posts)
- [ ] Summary of Anthropic's published benchmark methodology and metrics
- [ ] Assessment: can we reuse their harness directly, adapt it, or must we build from scratch?
- [ ] List of relevant benchmark datasets that would apply to our use case

### Information Sources

- Anthropic GitHub: `anthropic-cookbook`, `anthropic-quickstarts`, `anthropic-sdk-python`, `anthropic-sdk-typescript`
- Anthropic research blog and documentation site
- ArXiv papers from Anthropic mentioning advisor or hierarchical model patterns
- Third-party evaluations and blog posts about the advisor tool
- SWE-bench leaderboard entries mentioning advisor configurations
- Anthropic Discord and developer community discussions

---

## Q4: How to Validate Claudish + Third-Party Model Advisor Quality?

### Sub-Questions

1. **Benchmark selection:** Which tasks best demonstrate advisor value? (Complex multi-step coding, architectural decisions, debugging, code review?)
2. **Baseline measurements:** What is the performance of the executor model alone on the benchmark suite? What is the performance with native Anthropic advisor?
3. **Third-party advisor variants:** Which external models are worth testing as advisors? (Grok 4, Gemini 2.5 Pro, GPT-5, DeepSeek R1, Qwen 3?)
4. **Metrics framework:**
   - **Task completion rate:** Did the executor complete the task correctly?
   - **Tool call efficiency:** How many tool calls were needed vs. baseline?
   - **Plan quality:** Was the advisor's strategic guidance followed and effective?
   - **Latency impact:** Total wall-clock time with and without advisor
   - **Cost analysis:** API cost per task with each advisor model
5. **Statistical rigor:** How many trials per configuration? What confidence intervals? How to handle non-determinism?
6. **Regression detection:** How to detect when an external advisor degrades performance vs. no advisor?

### Success Criteria

- [ ] Defined benchmark suite with 20+ tasks spanning difficulty levels
- [ ] Metrics collection framework specification (what to measure, how to measure, how to report)
- [ ] Cost-quality tradeoff analysis framework: Pareto frontier of advisor models by quality vs. cost
- [ ] Comparison methodology: statistical tests, sample sizes, confidence levels
- [ ] Automated evaluation pipeline specification (can run overnight, produces comparison reports)

### Information Sources

- Existing magus autotest framework (`autotest/framework/runner-base.sh`)
- SWE-bench, HumanEval, MBPP benchmark datasets
- Claudish session logging and cost tracking capabilities
- OpenRouter pricing data for cost analysis
- Academic literature on LLM-as-judge evaluation methodology
- Existing `/team` command implementation for parallel model execution patterns

---

## Q5: Architectural Options for Implementation

### Option A: MCP-Based Advisor Tool

**Concept:** Claudish-MCP exposes a new `advisor` tool that the executor can call like any MCP tool.

#### Sub-Questions
1. Can Claude Code treat an MCP tool as functionally equivalent to the native advisor tool type?
2. How does the executor know when to call the advisor? (System prompt instruction vs. automatic routing)
3. Can the MCP tool access the full conversation transcript to provide context-aware advice?
4. What is the latency profile? (MCP call -> claudish -> external model API -> response)
5. How to handle streaming? (Native advisor may stream; MCP tools return complete responses)

#### Evaluation Criteria
- Fidelity to native advisor pattern: LOW-MEDIUM (explicit tool call, not transparent)
- Implementation complexity: MEDIUM
- User experience: Executor must be prompted to use the tool
- Latency: MEDIUM-HIGH (full round-trip through MCP + external API)

---

### Option B: Hook-Based Advisor

**Concept:** A `PreToolUse` hook intercepts tool calls, consults an external model for strategic guidance, and injects advice into the conversation.

#### Sub-Questions
1. Can PreToolUse hooks inject content that appears as advisor guidance in the conversation?
2. What is the hook timeout limit? Is it sufficient for an external model API call?
3. Can the hook see enough context (previous messages, tool results) to provide useful advice?
4. How does the hook decide which tool calls deserve advisor consultation? (All? Only complex ones?)
5. Can the hook modify the tool call parameters based on advisor feedback?

#### Evaluation Criteria
- Fidelity to native advisor pattern: MEDIUM (transparent to executor, but limited context)
- Implementation complexity: MEDIUM-HIGH
- User experience: Transparent; executor doesn't need to know about the advisor
- Latency: HIGH (hook adds latency to every intercepted tool call)

---

### Option C: Prompt-Injection Pattern

**Concept:** System prompt or CLAUDE.md instructs the executor to proactively consult claudish MCP tools before making complex decisions.

#### Sub-Questions
1. How reliable is prompt-based instruction for triggering advisor consultation?
2. Can we define clear triggers (e.g., "before writing more than 50 lines", "before architectural decisions")?
3. Does this degrade with model updates or instruction-following variance?
4. How to prevent over-consultation (calling advisor on trivial decisions)?
5. Can this be combined with Option A (prompt guides when to use the MCP advisor tool)?

#### Evaluation Criteria
- Fidelity to native advisor pattern: LOW (depends on executor compliance)
- Implementation complexity: LOW
- User experience: Unpredictable; executor may ignore or over-use
- Latency: VARIABLE (depends on when executor decides to consult)

---

### Option D: Wrapper/Proxy Pattern

**Concept:** A proxy layer sits between Claude Code and the API, intercepting requests and injecting advisor consultation transparently.

#### Sub-Questions
1. Can we proxy Claude Code's API calls through a local service?
2. How does the proxy decide when to inject advisor consultation?
3. Can the proxy modify the message stream to add advisor responses?
4. How to handle authentication and API key routing?
5. Does this violate Anthropic's terms of service?

#### Evaluation Criteria
- Fidelity to native advisor pattern: HIGH (most transparent)
- Implementation complexity: HIGH
- User experience: Fully transparent; no changes to executor behavior
- Latency: MEDIUM (proxy adds minimal overhead; external model call is the bottleneck)
- Risk: ToS compliance concerns, fragile to API changes

---

### Option E: Hybrid Approach (Recommended for Exploration)

**Concept:** Combine Option A (MCP tool) + Option C (prompt guidance) with selective Option B (hooks for validation).

#### Sub-Questions
1. MCP tool provides the advisor interface (claudish routes to external model)
2. Prompt/CLAUDE.md provides guidance on when to consult the advisor
3. PostToolUse hook validates advisor recommendations were followed
4. How do these three layers interact without creating loops or conflicts?
5. What is the user configuration surface? (Which advisor model, consultation triggers, cost limits)

#### Evaluation Criteria
- Fidelity to native advisor pattern: MEDIUM-HIGH
- Implementation complexity: HIGH
- User experience: Good; guided but not forced
- Latency: MEDIUM (only consults when prompted to)

---

## Research Execution Plan

### Phase 1: Documentation Deep Dive (2-3 hours)

| Step | Action | Output |
|------|--------|--------|
| 1.1 | Read full Anthropic advisor tool documentation | Protocol specification notes |
| 1.2 | Search anthropic-cookbook and GitHub for examples | Example code catalog |
| 1.3 | Search for evaluation harnesses and benchmarks | Evaluation tooling inventory |
| 1.4 | Review Claude Code hook execution model and limits | Integration constraints doc |
| 1.5 | Review claudish MCP tool capabilities and limits | Capability matrix |

### Phase 2: Feasibility Analysis (2-3 hours)

| Step | Action | Output |
|------|--------|--------|
| 2.1 | Map advisor protocol to claudish capabilities | Gap analysis |
| 2.2 | Evaluate each architectural option (A-E) | Options comparison matrix |
| 2.3 | Identify blocking constraints and dealbreakers | Risk register |
| 2.4 | Draft recommended architecture | Architecture decision record |

### Phase 3: Validation Framework Design (2-3 hours)

| Step | Action | Output |
|------|--------|--------|
| 3.1 | Design benchmark task suite | Task definitions |
| 3.2 | Define metrics and collection methodology | Metrics specification |
| 3.3 | Design automated evaluation pipeline | Pipeline architecture |
| 3.4 | Plan cost-quality tradeoff analysis | Analysis framework |

### Phase 4: Prototype Specification (1-2 hours)

| Step | Action | Output |
|------|--------|--------|
| 4.1 | Write detailed spec for recommended approach | Implementation spec |
| 4.2 | Define MVP scope (minimum viable advisor) | MVP definition |
| 4.3 | Identify required changes to claudish-mcp | Change list |
| 4.4 | Draft user-facing configuration interface | UX specification |

---

## Deliverables

1. **Feasibility Report:** Can we do it? What are the tradeoffs?
2. **Architecture Decision Record:** Which approach and why
3. **Evaluation Framework Spec:** How to measure advisor quality
4. **Implementation Spec:** Detailed technical plan for the chosen approach
5. **MVP Definition:** Smallest useful version we can build and test

---

## Open Questions (to resolve during research)

- Does Claude Code's hook system have a timeout that would prevent external model consultation?
- Can MCP tools access conversation history, or only receive explicit parameters?
- Does Anthropic plan to open the advisor tool to custom model endpoints?
- Are there rate-limiting or cost implications of having every tool call trigger an advisor consultation?
- How does the native advisor handle context window limits when the transcript is very long?
- Could we use claudish's `team` tool to run multiple advisors in parallel and take a consensus?
