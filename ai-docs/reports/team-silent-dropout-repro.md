# Reproduction: `team` reports a vote-less epilogue as `succeeded`

Reproduces issue 1 of `bug-claudish-team-silent-dropout.md` (MadAppGang/Magus, 2026-08-11).
The original report says *"Not deterministic. It reproduced once."* It is deterministic
once the mechanism is known: **2/2 models, first attempt.**

## Root cause

`claude -p` in text output mode emits **only the final assistant message**. Any turn the
child takes *after* writing its answer discards that answer, and whatever the last turn
happened to say becomes `response-NN.md`.

Isolated proof, independent of claudish:

```
$ echo "Say exactly ALPHA_MARKER on its own line. Then run the bash command: echo hi.
        Then say exactly OMEGA_MARKER on its own line." \
    | claude -p --model haiku --dangerously-skip-permissions
OMEGA_MARKER          <- 13 bytes. ALPHA_MARKER is gone.
```

The data is not lost upstream, only by the capture path — the same prompt under
`--output-format stream-json --verbose` retains both:

```
$ jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' sj.jsonl
ALPHA_MARKER
OMEGA_MARKER
$ jq -r 'select(.type=="result") | .result' sj.jsonl
OMEGA_MARKER          <- the `result` field == last message == what text mode prints
```

## Trigger

Any post-answer turn. `input.md` here forces one deterministically:

1. **Step 1** — launch a background `Agent` (Task tool, `run_in_background: true`) and do
   not wait for it.
2. **Step 2** — write a long review (≥800 words).
3. **Step 3** — end with a fenced ` ```vote ` block.

The background agent's completion notification always arrives after step 3, so the model
takes one more turn to acknowledge it. That acknowledgement is the entire captured output.

In the original incident the same shape came from a `Task` + `TaskStop` pair; slot 03's
surviving text was *"The stray agent was already stopped — that notification just confirms
the kill I issued."*

## Measured

`ai-docs/sessions/terminal-plugin-raw-tmux-drift-20260811-134200-c4f19b2e/repro4/`,
claudish 7.48.0, Claude Code 2.1.227, macOS arm64.

| slot | model | reported state | bytes on disk | output tokens | ` ```vote ` blocks | tools called |
|---|---|---|---|---|---|---|
| 01 | `gc@glm-5.2` | `COMPLETED` | 250 B | 7,743 | 0 | Bash×3, **Agent×1**, Read×1 |
| 02 | `kc@k3` | `COMPLETED` | 396 B | 4,737 | 0 | Bash×4, **Agent×1**, Read×1 |

```
team: 2 models, 2 done, 146s, 99.8k tok, free
  01 gc@glm-5.2         done    250B   83.8k/7.7k    free
  02 kc@k3              done    396B    3.5k/4.7k    free
```

Slot 01 turned **7,743 output tokens into 250 bytes**. Both surviving texts refer to a
review that is not on disk:

> "That was step 1's parallel task — the review and vote **above** are complete and
> unaffected by it."  — response-01.md

> "The review and vote **above** stand as delivered."  — response-02.md

## Why the existing classifier cannot catch it

`classifyRunOutput` tests three things, and the epilogue passes all three:

- exit code is `0` — the child genuinely succeeded
- no `[API Error: …]` marker in stdout
- output is non-whitespace, and `DEFAULT_MIN_OUTPUT_BYTES` is `0` (opt-in, off)

`minOutputBytes` would catch it, but it is **not exposed on the MCP `team` tool's input
schema**, so the caller who hit this had no way to opt in.

## Incidental findings from the same session

1. **`claudish team` is dead code.** `teamCommand` is exported from `team-cli.ts` and
   imported nowhere. `claudish team run --models a,b` does not error — it falls through to
   catalog search and prints 50 models. `team` is MCP-only.
2. **A 1Password DesktopAuth stall is indistinguishable from a slow run.** The MCP `team`
   call sat at `PENDING`/`PENDING` for 24+ minutes with no children spawned and no message,
   while `~/.claudish/op-handshake.lock` was re-acquired by the same live pid. A caller
   polling `status.json` cannot tell "working" from "blocked on a dialog nobody is looking
   at". Same silent-failure direction as the reported bug.
3. **Bare `glm-5.2` probed `ZHIPU_API_KEY` and died in 0.6s** while the working credential
   is `GLM_CODING_API_KEY` — the `glm-5.2` casualty described in CLAUDE.md's parent-side
   route-pinning section, reproduced by accident when `runModels` was driven directly.

## Files

**Committed** (durable):

- `ai-docs/benches/answer-survival/` — the madbench eval that reproduces this on
  `claude-haiku-4-5` through plain Claude Code. Run it with
  `madbench preflight madbench.yaml && madbench madbench.yaml`.

**Local-only** (under `ai-docs/sessions/`, which is gitignored — these are the raw run
directories from the original investigation and do NOT survive a fresh clone):

- `repro/input.md` — the prompt that forces a post-answer turn (identical in repro2/3/4)
- `repro/drive.ts` — direct `runModels` driver, needed because the CLI entry point is orphaned
- `repro4/` — the successful reproduction; `repro2`/`repro3` are credential-failure arms

The measurements above are reproduced from those runs verbatim, so the evidence survives
here even though the raw directories do not. To regenerate them, use the committed bench.
