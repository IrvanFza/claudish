# answer-survival — does the harness keep the agent's ANSWER?

```bash
madbench preflight madbench.yaml     # verify binaries/keys before spending
madbench madbench.yaml               # run it
madbench madbench.yaml --repeat 5    # flake check
```

## What it measures

`claude -p` prints **only the final assistant message**. Any turn the agent takes *after*
writing its answer replaces that answer on the captured surface. This bench measures
whether a given harness+model survives that.

Two scenarios ask for the **same deliverable** — a short review ending in a fenced
` ```vote ` block — and both assert PASS. Only one difference: `post-answer-turn`
guarantees a late notification by launching a background subagent first.

| control | treatment | reading |
|---|---|---|
| PASS | PASS | answers survive a late notification |
| PASS | **FAIL** | **the dropout** — answer generated, then overwritten by an epilogue |
| FAIL | — | the task itself is too hard; treatment tells you nothing yet |

String checks grade only the agent's final message — precisely the surface that loses the
answer — so `contains "```vote"` *is* the detector.

## Measured result

`claude-haiku-4-5-20251001`, Claude Code harness, 3 consecutive runs, identical each time:

```
✓ PASS  control-no-background-work        ~14s   $0.020
✗ FAIL  post-answer-turn                  ~33s   $0.064
    ✓ exec: test -f subagent-done.txt exited 0        <- scenario IS valid
    ✗ contains: expected "```vote" in output
      "All steps complete. The background agent counted 12 lines…"
```

**The dropout reproduces on a native Anthropic model through plain Claude Code, with no
claudish in the path.** It is a property of the print-mode capture surface, not of any
particular model or proxy.

## Two design decisions worth keeping

**The validity guard is a filesystem sentinel, not `trajectory:tool-used: Task`.** madbench
records subagents in a separate `subagents[]` array (`[{name: "general-purpose",
tool_calls: 2}]`); the spawning call never appears in `trajectory.calls`, which on a real
run held only `ToolSearch` and `Read` while a subagent demonstrably ran and reported back.
No builtin check reads `subagents[]`, so any trajectory-based guard is a guaranteed false
negative. The subagent is therefore told to write `subagent-done.txt`, and an `exec` check
tests for it. Its own tool calls are also absent from the main trajectory, which is why
that write cannot trip the read-only checks.

**The read-only contract is asserted on the artefact** (`grep -q 'STDOUT_TAIL_LIMIT = 4000'
classify.ts`) rather than the trajectory — for the same reason: a subagent that rewrote the
file would be invisible to a trajectory check.

## Gotchas hit while building this

- `madbench list` only validates YAML **shape**. It happily accepted `sandbox: home` and
  `session:tool-used`, both of which are wrong for this binary. **`madbench preflight`
  caught both** before spending anything — always run it.
- The `examples/` in the madbench repo use an older vocabulary (`session:tool-used`,
  `sandbox: home`). The installed binary wants `trajectory:tool-used` and
  `sandbox: process|container`, matching the skill docs rather than the examples.
- `--permission-mode bypassPermissions` is required, not `acceptEdits`: the treatment needs
  the agent to actually spawn a subagent. In `--print` mode an un-approved tool call
  silently no-ops, which would quietly degrade the treatment into a duplicate of the
  control and score a meaningless pass.
- The `not-regex` epilogue matcher is **advisory only** — the wording drifts every run and
  one of five observed phrasings escaped it during a genuine dropout.

## Next

Thresholds are deliberately generous (latency 180s/300s, cost $0.10/$0.20) against observed
~14s/$0.020 and ~33s/$0.064. Tighten to ~1.5–2× observed max after a few more runs.

To compare models, write an Eval file with explicit `runs:` entries — there is no matrix.
