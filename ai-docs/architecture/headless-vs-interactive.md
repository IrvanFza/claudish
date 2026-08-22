# Headless is not a faithful subset of interactive

Claude Code's print/headless mode (`-p`, `--output-format stream-json`, `--input-format
stream-json`) is not merely "interactive without a TTY". It diverges behaviourally, and at least
one divergence turns a hard, self-explaining error into silence. This is why claudish drives a
CONTROLLED INTERACTIVE session (magmux) wherever the answer has to be trustworthy, rather than
treating `-p` as the general-purpose interface.

Measured 2026-08-22 against Claude Code v2.1.239.

## The measurement

`--agent <name>` with a name that does not exist. One variable — the input format — and
`claude` invoked DIRECTLY, with no claudish in the path:

| invocation | exit | stderr | agent applied? |
|---|---|---|---|
| `claude --agent zzz-not-real` (interactive, TTY) | — | `--agent 'zzz-not-real' not found. Available agents: …` | run refused |
| `claude -p --output-format stream-json --agent zzz-not-real` | **1** | same, lists all 24 agents | run refused |
| `claude -p --output-format stream-json --input-format stream-json --agent zzz-not-real` | **0** | *(empty)* | **no — silently default** |

Adding `--input-format stream-json` is the whole difference.

The flag is NOT inert in that mode — a VALID name IS honoured. The `system/init` frame proves
it, via the tool allowlist:

    --agent dev:reviewer   -> tools: ["Read", "Bash"]                      (agent applied)
    --agent zzz-not-real   -> tools: ["Task","Bash","CronCreate","Edit",…] (full default set)

So the agent loads correctly; only its VALIDATION is skipped.

## It is not "errors moved into the stream"

The obvious defence of this design is that an SDK-facing mode should keep the protocol stream
alive rather than exit, surfacing problems as frames. It does not do that. Searching the entire
stream for the bogus name and for any error frame:

    mentions of "zzz-not-real" anywhere in the stream: 0
    frame types: system/init, system/hook_started, system/hook_response,
                 assistant, rate_limit_event, result/success
    result.is_error: false

The run reports SUCCESS. There is no signal in any channel — not the exit code, not stderr, not
the stream. A typo silently runs the default agent with the FULL tool set and reports success.

## Upstream status: documented nowhere, and closed as not planned

The official CLI reference defines both flags and says nothing about their interaction or about
validation of unknown agent names:

> `--agent` — Specify an agent for the current session (overrides the `agent` setting)
> `--input-format` — Specify input format for print mode (options: `text`, `stream-json`)

<https://code.claude.com/docs/en/cli-reference>

The nearest report, [anthropics/claude-code#15815](https://github.com/anthropics/claude-code/issues/15815)
("`--agent` Flag Not Working for Non Interactive (Affects SDK)"), was **closed as not planned**,
with no maintainer explanation in the thread. Two caveats on citing it:

- That report (v2.0.76, Dec 2025) was that the agent NEVER LOADS headlessly. On v2.1.239 a valid
  agent does load — measured above — so that part appears fixed since.
- What remains is narrower: the agent loads, but an invalid name is not validated.

**Treat this as settled upstream behaviour, not as a bug awaiting a fix.** Anthropic saw the
adjacent complaint and declined it. Design around it; do not wait for it.

## Why magmux exists

`docs/usage/magmux.md` presents magmux as a side-by-side viewer for `--grid`. That is what it
does, not why it is in the dependency tree. The reason is this class of divergence: **when the
result has to be trustworthy, run a real interactive session under programmatic control instead
of a headless one.**

Interactive mode is the faithful path — it refuses the unknown agent, with the list. Headless
mode is the one that quietly does something else. A multiplexer gives back what `-p` costs: a
real TTY and a real session, with panes that can still be driven and read programmatically.

`packages/magmux-{darwin,linux}-*` ship with the CLI for exactly this reason; `team-grid.ts`
is the current consumer.

## What this means when you are writing code here

- **Do not assume a headless run behaves like the interactive one.** Where the difference would
  be silent, measure both — the A/B above is the pattern, and it took two commands.
- **`exit 0` from a headless child is not evidence the flags were honoured.** This is the same
  lesson `team-capture.md` records for output: exit 0 proves nothing, which is why
  `require_pattern` exists. Argument handling has the same hole.
- **Validate at the claudish boundary when the child will not.** `agent-availability.ts` does
  this for `--agent`: it discovers the roster live (`claude --agent <sentinel> -p`, ~0.5s, no API
  call, no tokens), caches it PER CWD because the roster is cwd-dependent (24 names in this repo,
  5 in `/tmp`), and fails OPEN when the roster cannot be determined — blocking every session
  because a probe broke would be a worse failure than the one it guards.
- **Prefer magmux over `-p`** for anything where a silent behavioural difference would corrupt
  the result rather than merely degrade it.
