# Debugging

> Debug logging, `CLAUDISH_UPSTREAM_ERROR_LOG`, raw SSE capture, and the failed-translation workflow.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### `CLAUDISH_UPSTREAM_ERROR_LOG` — the one thing `--debug` being off loses forever

A non-ok upstream response short-circuits before the stream parser, so
`response-capture` never sees it. `composed-handler.ts` reads the body, hands it
to the classifier, and drops it — and `log()` persists **nothing** unless
`--debug` set a log file. So on a normal run the literal 429/402 body is gone
the instant it has been classified, which is exactly the artifact that
distinguishes a rate limit worth retrying from a hard quota wall that is not.
Reported by @jsboige (#184) from a real incident: a GLM coding-plan 5h cap
saturated, the shape was reconstructable from request counts, the body was not.

`CLAUDISH_UPSTREAM_ERROR_LOG=<path>` appends one JSON line per non-ok upstream
response: `{at, provider, model, status, body}`. Unset = off, and off is the
default **on purpose** — this writes provider error text, which can carry
account identifiers, to a path the user names. It is not part of `--debug`
because the two answer different questions: `--debug` is "show me everything
about this run", this is "keep the one field I will want next week".

Three properties worth preserving if it is ever touched: the body is capped at
2KB; truncation is **marked** (`truncated` + `original_bytes` appear only when
it happened, so an unmarked body can be trusted as whole); and it **never
throws**, because it runs on the error path where something is already going
wrong and a capture facility that can break a request is worse than none.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```
