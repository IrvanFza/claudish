# Team lifecycle — why nothing kills a slot

`team` spawns N Claude Code sessions and collects their answers. This file
records why it has no deadline, why `run` does not block, and who is allowed to
terminate a slot.

## The measurement that removed the deadline

Session `team-20260827-0015`, five models, `timeout: 600`. Two completed, three
were killed. All three killed slots were working at the moment they died:

| Slot | Tool calls | Output tokens | State when killed |
|---|---|---|---|
| `02` grok-4.6 | 45 Read, 7 Bash | 2,773 | mid-analysis |
| `03` kimi-k3 | 13 Bash, 8 Read | 10,198 | mid-verification |
| `04` qwen3.8-max | 24 Bash, 10 Read | 30,557 | starting a probe |

Two observations from `status.json`, both measured rather than inferred.

**The kills were on a 60-second grid, not a deadline.** Measured from the run's
own `startedAt`, every kill landed within 133 ms of a 60 s multiple — 659.867 s,
779.879 s, 1139.901 s. The two COMPLETED slots landed at arbitrary offsets
(−4.05 s, −2.15 s from the nearest tick). That grid was `GRACE_INTERVAL_MS`, the
watcher's poll cadence. An earlier reading of the same data concluded that kills
tracked sibling completions; they did not. Two completions happened to fall a few
seconds before ticks that were going to fire regardless.

**The progress signal could not see work.** The watcher read `updated_at` from
`stats/<id>.json`. Every write to that file comes from `TokenTracker.writeFile`,
whose call sites are all usage-recording paths — a response arriving from a
provider. There is no timer. So the timestamp freezes for the entire duration of
a local tool call, and a slot running `go test ./...` is indistinguishable from a
wedged process. Cross-checking the recorded `updated_at` against the kill times
confirms it exactly: idle at kill was 90.6 s, 108.2 s, 102.3 s against a 90 s
threshold. Slot `02` missed surviving by 0.6 seconds.

## Why a stall detector was never needed

Claude Code bounds its own tool calls. The `Bash` tool has a timeout (default
120 s, maximum 600 s), and Claude Code emits
`Background tasks still running after 600s; terminating`, which
`team-orchestrator.ts` already parses as `BG_CEILING_RE`.

A tool call inside the child cannot hang forever. A claudish-side tool-stall
detector guarded a condition the harness prevents.

## What replaced it

**Nothing terminates a slot on a timer.** `TeamRunOptions.timeout`,
`graceExtension`, `maxGraceSeconds` and `stallSeconds` are gone, along with the
watcher, `timeoutModel`, and the token-file progress read.

**Silence is reported, not judged.** Each child's raw stdout and stderr writes
stamp a timestamp — a listener separate from the answer capture, because those
ask different questions. Capture asks "is this an answer?" and says no to a
`tool_progress` heartbeat; liveness asks "is anything alive?" and the same frame
says yes. `teamSlotIdleSeconds()` publishes the result, and `mode: "status"`
returns it as `idle_seconds_by_slot`.

Frames keep arriving during a long tool call — Claude Code emits `tool_progress`
heartbeats every 30 s — which is exactly why this signal stays honest where the
token-flow timestamp did not.

**The caller decides, and `cancel` is how it acts.** `cancelTeamRun` is the only
thing that kills a slot. It kills the process GROUP: `claudish` is a launcher
that runs the real CLI under Bun, which runs `claude`, so signalling the direct
child reaches only the launcher and leaves the tree billing and holding the
response pipe open.

## Why `run` does not block

A team slot is a full Claude Code session and can legitimately work for a long
time. Holding a tool call open for that duration makes the run's length the MCP
client's problem: a client aborts a call that emits nothing for its idle window,
and a real `team` run died at exactly 1800 s for that reason. The keepalive
(`notifications/progress`, the only notification measured to reset that timer)
was built to defeat it.

`startModels` returns as soon as the children exist, handing back a `TeamHandle`
with the team session id and a model-to-slot map. The run continues in the
background; the caller polls `mode: "status"`. This removes the reason the 1800 s
ceiling ever mattered rather than working around it.

`runModels` remains as the blocking form, for `run-and-judge` — a pipeline
cannot judge answers that do not exist yet.

### Blinding is unaffected

`run` returns display model → slot id. That does not weaken blind judging. The
manifest is shuffled so the judge CHILDREN, which read `response-<id>.md` without
a manifest, cannot attribute answers. The orchestrating caller has always seen
the mapping — `status.txt` prints model names beside slot ids.

## One parser, two consumers

`team` drove `createAssistantTextCapture()` directly and hand-rolled everything
around it. The channel wrapped that SAME capture in `StreamJsonReducer` and added
what team lacked: a state machine that tells thinking from tool execution, and
`sawResult` — the child's own terminal `result` frame, a real completion oracle
where exit 0 is not (`claude -p` exits 0 on API errors too).

Two implementations of one job existed because `team-orchestrator.ts` dates from
2026-03-20 and `stream-json-reducer.ts` from 2026-08-22. `team` now feeds the
reducer, and `StreamJsonReducer` is the only production consumer of the capture.
`feed()` and `end()` return exactly what `capture.write()`/`capture.end()`
returned, so `byteCount`, `stdoutTail` and `classifyRunOutput` were unaffected by
the swap.

### The one behaviour that had to be made explicit

The two parsers disagreed on a line that is valid JSON but is NOT stream-json
vocabulary — a bare array, a stray object:

| Line | capture | reducer (before) |
|---|---|---|
| not JSON (`[API Error: …]`) | passthrough | passthrough |
| recognised frame | recover prose | recover prose |
| JSON, unrecognised | **passthrough** | **dropped** |

Both behaviours are correct for their own consumer. A channel session's stdout is
pure stream-json, so a stray JSON object is machine noise and keeping it would
pollute the answer. A team slot's `response-<id>.md` is the only place a reader
ever sees what the child printed, and this project has already lost real answers
to a parser deciding something was not worth keeping (`team-capture.md`).

So it is an option — `keepUnrecognizedJson`, default false, and `team` passes
true — rather than one rule imposed on both. Note the asymmetry it resolves: an
UNPARSEABLE line was always kept ("it is the only place a reader would ever see
it"), so dropping *valid* JSON was the stricter rule, not the looser one.

This was caught by the `--print-argv` test, whose fake child prints a JSON array
to stdout: under the reducer's default the argv never reached the response file
and the slot was classified EMPTY.

## What is still owed

Per-slot spawn plumbing is still team's own: its argv is one-shot (`--stdin`)
where the channel's is bidirectional (`--input-format stream-json`, which is what
makes `send_input` work), and team owns its own directory layout, token file and
anonymised ids. Moving team onto `SessionManager.createSession` would give each
slot a session id addressable by `get_output`, `get_diagnostics` and
`cancel_session`. It needs `SessionCreateOptions` to accept a caller-chosen
session id, session directory and token file, and must preserve the single
prehydrated 1Password handshake for the whole run.

## Coverage removed with the mechanism

Deleting the reaper deleted the tests that drove it: `team-timeout-termination`
(7 tests), `team-timeout-diagnostics` (1), and 2 of 9 in `team-timeout-repro`.
Two of those covered behaviour reachable only through the kill path — an answer
flushed during shutdown being recovered, and nothing being written after the run
returns. Equivalent coverage belongs against the agent-initiated cancel path.
