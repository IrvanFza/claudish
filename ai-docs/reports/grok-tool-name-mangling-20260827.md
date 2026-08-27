# Tool names are mangled on the openai-sse wire (grok-subscription)

**Date:** 2026-08-27
**Area:** Layer 1/2 stream translation, tool-call parsing
**Severity:** medium — corrupts recorded tool counts; may corrupt dispatched tool names (unconfirmed)
**Status:** observed, not root-caused

---

## Summary

A `gk@grok-4.6` run recorded a tool call whose NAME is a concatenation of a tool
name, a parameter name, a type fragment, and an argument value. The name is not a
tool that exists.

Recorded in `stats/02.json` of session
`/Users/jack/mag/madbench/.claude/worktrees/keychain/ai-docs/sessions/team-20260827-0015`:

```json
"tool_calls": [
  {"name": "Read", "count": 45},
  {"name": "Bash", "count": 7},
  {"name": "web_search", "count": 1},
  {"name": "web_search_query_listOpposed[\"macos security add-generic-password -X hex password flag\"]", "count": 1},
  {"name": "WebSearch", "count": 1}
]
```

Decomposing the malformed name:

| Fragment | Reads as |
|---|---|
| `web_search` | the tool name |
| `query` | a parameter name |
| `list` | a type fragment |
| `Opposed` | unattributed |
| `["macos security add-generic-password -X hex password flag"]` | the argument VALUE |

Three separate records exist for what is plausibly one or two real calls
(`web_search`, `WebSearch`, and the malformed entry).

---

## Environment

| | |
|---|---|
| Model spec | `gk@grok-4.6+x-ai@grok-4.6+or@x-ai/grok-4.6` |
| Provider | Grok-subscription (`"provider_name":"Grok-subscription"` in the stats file) |
| Wire | `openai-sse` |
| Host | macOS (darwin 25.6.0) |

---

## What the code shows

`TokenTracker.recordToolUse` does not construct names. It stores what it is
handed, trimmed:

```ts
// packages/cli/src/handlers/shared/token-tracker.ts:111
recordToolUse(name: string): void {
  const key = name.trim() || "unknown";
  this.toolCallsByName.set(key, (this.toolCallsByName.get(key) ?? 0) + 1);
}
```

Its only production call site is the single observation point in the composed
handler:

```ts
// packages/cli/src/handlers/composed-handler.ts:1373
const observeToolCall = (name: string): void => {
  this.tokenTracker.recordToolUse(name);
  behaviorSession?.observeToolCall(name);
};
```

That callback is installed as `onToolCallObserved` on every stream handler
(`composed-handler.ts:1399, 1416, 1439, 1459, 1484`). So the name was already
malformed when the stream handler emitted it.

Per the comment at `composed-handler.ts:1391-1393`, grok runs on the `openai-sse`
wire, alongside GLM, Kimi, DeepSeek, Qwen, OpenRouter and LiteLLM. The defect is
therefore on the busiest wire in claudish, not a niche one.

### Ruled out

The natural-language recovery path in
`packages/cli/src/handlers/shared/tool-call-recovery.ts:192-210` is NOT the
source. It filters every candidate against a `knownTools` allowlist before
emitting, and `web_search_query_listOpposed[...]` is not on that list:

```ts
if (!knownTools.some((t) => t.toLowerCase() === toolName.toLowerCase())) {
  continue;
}
```

### Leading hypothesis (unverified)

The `openai-sse` streaming handler assembles a tool name from streamed deltas.
OpenAI-dialect providers send `function.name` incrementally, and a parser that
appends deltas without respecting index boundaries will concatenate the name with
following fields. The shape of the corrupted string matches that failure mode.
Confirming this needs a `--debug` log from a grok run that calls a tool.

---

## Open question: did the malformed name reach the wire?

`observeToolCall` is documented as "the ONE place a completed tool call is
observed". If the handler dispatched the tool under the same string it reported,
then Claude Code received a tool call naming a tool that does not exist, and the
turn was wasted. If the corruption is confined to the reporting path, the impact
is limited to statistics.

This is not determinable from the artifacts in hand. It decides whether the
severity is medium or high.

---

## Reproduction

1. Run any `gk@grok-4.6` session with `--debug` on a task that provokes tool use,
   including a web search attempt.
2. Read the resulting log under `logs/`.
3. Inspect the raw SSE frames carrying `function.name` deltas, and compare them
   against the names passed to `onToolCallObserved`.
4. Inspect `tool_calls` in the session's token stats file for names that are not
   real tools.

---

## Impact

- Tool-call counts for every model on the `openai-sse` wire are unreliable. The
  end-of-session summary and `stats/*.json` both read from this map.
- If the corruption reaches dispatch, affected turns are lost outright.
- Corrupted names carry ARGUMENT VALUES into a map that is written to disk and
  surfaced in summaries. In this instance the value was a benign search query. A
  tool call carrying a secret in an argument would place that secret into
  `stats/*.json`, which is not a redacted surface.

---

## Related

Found while investigating the `team` timeout defect in the same session. The
`web_search` call that produced this entry is itself unimplemented
(`packages/cli/src/handlers/shared/web-search-detector.ts` is a v1 stub that
warns and passes through), which is tracked separately.
