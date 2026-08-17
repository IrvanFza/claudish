# stream-json fixtures

Captured from real `claude -p --output-format stream-json --verbose` runs. These
pin the wire shape that `team-stream-capture.ts` reads.

## `haiku-post-answer-turn.jsonl`

The minimal reproduction of the print-mode dropout, captured 2026-08-15 on
`claude-haiku-4-5`. Prompt:

> Say exactly ALPHA_MARKER on its own line. Then run the bash command: echo hi.
> Then say exactly OMEGA_MARKER on its own line.

The stream carries **both** assistant text blocks (`ALPHA_MARKER`, then a
`tool_use`/`tool_result` pair, then `OMEGA_MARKER`), while the terminal `result`
event's `.result` field holds `OMEGA_MARKER` alone — and `.result` is exactly
what `claude -p` prints. That single file is the whole bug and the whole fix:
the answer survives upstream, and only the capture format discarded it.

**Trimmed, not synthesised.** Every retained line is byte-identical to the
capture. Three event kinds were dropped because they carry local environment
detail with no bearing on parsing: the `init` event (mcp servers, plugins,
skills, memory paths, socket path) and the `hook_started` / `hook_response`
events (which echo the capturing session's own directives). The `system`
(`thinking_tokens`), `assistant`, `user`, and `result` events remain, so the
fixture still exercises every branch the parser has.
