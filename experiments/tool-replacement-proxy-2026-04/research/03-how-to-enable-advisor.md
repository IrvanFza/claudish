# How to Enable the Native Claude Code Advisor Tool

**Validated 2026-04-14** with Claude Code 2.1.107, `claude-sonnet-4-6` executor, real traffic
captured through a recording proxy.

## TL;DR

You don't need a proxy trick, an env var, or a hidden flag. You need ONE slash command:

```
/advisor opus
```

(Or `/advisor sonnet` for a cheaper advisor, or `/advisor off` to disable.)

After that, every subsequent `/v1/messages` request will include:

```json
{
  "type": "advisor_20260301",
  "name": "advisor",
  "model": "claude-opus-4-6"
}
```

in the `tools` array, and Anthropic's server will run Opus as a sub-inference at the
executor's discretion. The real request and response we captured prove this end-to-end.

## The Gating Chain (from the Claude Code 2.1.107 binary)

The advisor tool is only injected into the request when ALL of these conditions hold:

```js
// plugins/cache/2.1.107 — minified, reverse-engineered
function Xx() {                                              // isAdvisorAvailable
  if (env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false;    // user kill-switch
  if (rq() !== "firstParty" || !sqH()) return false;         // must be firstParty + experimental betas enabled
  return S_("tengu_sage_compass2", {}).enabled ?? false      // GrowthBook feature gate
}

function sqH() {                                             // isAnthropicNative + experimental betas
  let authType = rq();
  return (authType === "firstParty" || authType === "anthropicAws" || authType === "foundry")
         && !env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
}

function rq() {                                              // auth type resolver
  if (env.CLAUDE_CODE_USE_BEDROCK)  return "bedrock";
  if (env.CLAUDE_CODE_USE_FOUNDRY)  return "foundry";
  if (env.CLAUDE_CODE_USE_ANTHROPIC_AWS) return "anthropicAws";
  if (env.CLAUDE_CODE_USE_MANTLE)   return "mantle";
  if (env.CLAUDE_CODE_USE_VERTEX)   return "vertex";
  return "firstParty";                                       // default
}

function nVH(mainModel) {                                    // main model supports advisor
  return mainModel.includes("opus-4-6") || mainModel.includes("sonnet-4-6");
}

function AI9(configuredAdvisor, mainModel) {                 // resolve advisor model for this request
  if (!Xx() || !configuredAdvisor) return undefined;         // gate + must have an advisor configured
  let advisorCanonical = qL(WK(configuredAdvisor));
  if (!nVH(mainModel))     return undefined;                 // main model must support advisor
  if (!u__(advisorCanonical)) return undefined;              // advisor model must be opus-4-6 or sonnet-4-6
  return advisorCanonical;
}

// At request build time:
let advisorModel = AI9(userSettings.advisorModel, currentModel);
if (advisorModel) tools.push({
  type: "advisor_20260301",
  name: "advisor",
  model: advisorModel
});
```

### In plain English

1. **`tengu_sage_compass2` GrowthBook gate** — Anthropic controls this server-side. It's
   cached in `~/.claude.json` under `cachedGrowthBookFeatures`. If it's not `{"enabled": true}`,
   the `/advisor` slash command is hidden and the tool is never injected. This is the primary
   rollout gate; you can't flip it locally.
2. **`firstParty` auth type** — default when none of the Bedrock/Vertex/Foundry/Mantle env
   vars are set. Required. If you route via Bedrock or Vertex, advisor is disabled.
3. **`!CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`** — this env var is a kill switch for all
   experimental betas, including the advisor.
4. **`!CLAUDE_CODE_DISABLE_ADVISOR_TOOL`** — a dedicated kill switch for the advisor tool.
5. **Main model must be `opus-4-6` or `sonnet-4-6`** (case-insensitive substring match).
   Haiku 4.5, older Sonnet/Opus versions, and 3.x models are not supported as executors.
6. **`userSettings.advisorModel` must be set to `opus` or `sonnet`** — no tool is injected
   unless the user has picked an advisor. This is the user-controlled opt-in.

The `/advisor <opus|sonnet|off>` slash command is exactly the setter for step 6.

## The Slash Command Definition

From the binary at offset 81575032:

```js
// Claude Code internal command registration
{
  type: "local-jsx",
  name: "advisor",
  description: "Configure the Advisor Tool to consult a stronger model for guidance at key moments during a task",
  argumentHint: "[opus|sonnet|off]",     // iVH = ["opus", "sonnet"]
  isEnabled: () => Xx(),                  // hidden unless the gate is open
  get isHidden() { return !Xx() },
  load: () => ...
}
```

Because `isHidden` is true when the gate is closed, you won't see `/advisor` in
autocomplete unless your account has been granted `tengu_sage_compass2`. That's why
my earlier assumption "maybe Claude Code doesn't have a /advisor command" was wrong —
it has one, but it was hidden from me UNTIL I ran it directly (which worked because
the gate was actually open for my account, I just never thought to try the command).

### The setter function

```js
function Bx7(H, mainModel, updateReduxState) {
  Q("tengu_advisor_command", {advisor: H});  // analytics event
  if (H === "off") {
    updateReduxState(A => ({...A, advisorModel: undefined}));
    M8("userSettings", {advisorModel: undefined});
    return "Advisor disabled";
  }
  let canonical = qL(H);  // e.g. "opus" → "opus-4-6"
  updateReduxState(A => ({...A, advisorModel: canonical}));
  M8("userSettings", {advisorModel: canonical});
  let msg = `Advisor set to ${Nu(canonical)}`;
  if (!nVH(mainModel))  // main model doesn't support advisor right now
    msg += ` Note: the current main model (${Nu(mainModel)}) does not support the advisor. It will activate when you switch to a supported main model.`;
  return msg;
}
```

The setting is persisted to `~/.claude/settings.json` as `advisorModel: "opus"` or
`advisorModel: "sonnet"`. (NOT `~/.claude.json` — that file has `advisorModel` as a
top-level key too, but only gets set on older code paths. The current code writes to
`~/.claude/settings.json`.)

## Verified End-to-End with Real Traffic

### Test setup
- Claude Code 2.1.107
- Main model: Sonnet 4.6 at high effort
- Recording proxy on `http://127.0.0.1:8787` (`poc/01-recording-proxy.ts`)
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
- `ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_API_KEY` (proxy translates Bearer → x-api-key)
- Commands run in a real `claude` session via `tmux send-keys`

### Sequence
1. `/advisor opus`                       → "Advisor set to Opus 4.6"
2. `Design a rate limiter for a distributed system. Think carefully.`

### What the proxy captured (evidence preserved at session root)

**`evidence-req-advisor-enabled.json`** — request body has 88 tools, the 88th is:
```json
{
  "type": "advisor_20260301",
  "name": "advisor",
  "model": "claude-opus-4-6"
}
```

**`evidence-resp-advisor-enabled.ndjson`** — response stream contains:
```
content_block_start: type=server_tool_use name=advisor input={}
content_block_start: type=advisor_tool_result tool_use_id=srvtoolu_019idp...
  content.type=advisor_result
  content.text="This is a design task in a POC directory, with learning/explanatory mode active.
                Here's how to approach it: **Structure the design around these decision points..."
content_block_start: type=text       ← executor continuation, informed by advice
...
message_delta.usage.iterations:
  [0] type=message         model=-                 in=     3  out=   35
  [1] type=advisor_message model=claude-opus-4-6   in= 68736  out= 1008
  [2] type=message         model=-                 in=     1  out= 2917
  stop_reason=tool_use
```

Per Anthropic's own billing data, **Opus 4.6 was invoked server-side as the advisor**,
consumed 68,736 input tokens (the entire Sonnet transcript + system prompt + all 87
tools), and generated 1,008 output tokens of advice. Sonnet then consumed those 1,008
tokens (as seen by the 2,917-token continuation) and produced a real response.

## Comparison: Before vs After `/advisor opus`

| Observation | Before (`advisorModel=None`) | After (`advisorModel="opus"`) |
|---|---|---|
| `tools` array length | 87 | **88** |
| Contains `advisor_20260301`? | NO | **YES** |
| `anthropic-beta` includes `advisor-tool-2026-03-01`? | yes (always) | yes |
| Response has `server_tool_use` block? | NO | **YES** |
| Response has `advisor_tool_result` block? | NO | **YES** |
| `message_delta.usage.iterations` count | 1 (`message`) | **3** (`message`, `advisor_message`, `message`) |
| `advisor_message` model in iterations | n/a | **`claude-opus-4-6`** |

## What This Means for the Proxy-Replacement Research

The original research assumed Claude Code doesn't use advisor. That assumption was WRONG
in the specific sense that Claude Code DOES use advisor — once you enable it. So the
original architecture actually CAN intercept the native advisor now. Two paths forward:

### Path A: Intercept the native advisor request (the original PoC plan)
1. Claude Code sends a request with `advisor_20260301` in tools (confirmed).
2. Proxy replaces the advisor tool with a regular `tool_use` tool named "advisor".
3. Executor now calls a normal tool_use for advisor (pending validation — needs a
   follow-up real test to see if Sonnet still calls it when it's a regular tool).
4. Proxy intercepts, runs a third-party model, sends tool_result.
5. Executor continues with third-party advice.
6. Proxy transforms back to `server_tool_use` + `advisor_tool_result` blocks on the
   client-facing stream.

**Risk**: By replacing the `advisor_20260301` type with a regular tool, we lose
Anthropic's special advisor-trained prompting that makes Sonnet call it at the right
moments. The model may call a regular "advisor" tool less reliably, or only when we
prompt it to.

### Path B: Let Anthropic run the native advisor, just augment it with third-party consensus
1. Don't intercept anything — let Claude Code talk to Anthropic as normal.
2. Run `/advisor opus` so native advisor is active.
3. In parallel, expose a second MCP tool `consult_advisor_b` backed by Claudish.
4. Prompt the model to call both (native advisor for quick guidance, third-party for
   second opinion at high-stakes decisions).

This doesn't replace the native advisor at all — it composes with it. Strictly more
advice, strictly more cost.

### Path C: The thing the user originally asked for
Intercept the native advisor call in the proxy, NOT by replacing the tool type, but by
**routing the executor's request upstream WITHOUT the advisor tool and injecting the
advisor call ourselves** on every turn, with a claudish-backed model. The difficulty
here is that we lose the "decided by executor" semantics — we have to decide when to
call the advisor ourselves.

## Next Steps

1. Update the `REAL-TEST-RESULTS.md` to note the correction: the previous conclusion
   "Claude Code doesn't send advisor_20260301" was wrong — it just needs `/advisor opus`
   first.
2. Run the replacement PoC again with advisor enabled: can we swap `advisor_20260301`
   for a regular tool and have Sonnet still call it? This is the critical unvalidated
   assumption from the earlier mock-based PoC.
3. If Sonnet does call the regular tool reliably, wire up Claudish as the advisor
   backend (`run_prompt` to `gemini-3-pro` or similar) and measure advice quality
   and cost vs native Opus.
