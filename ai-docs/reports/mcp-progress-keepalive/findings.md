# `notifications/progress` is Claude Code's keepalive, not its progress UI

Measured 2026-08-14 against **Claude Code 2.1.231**, stdio transport, `claude -p`.

## The question

A `team` MCP call died with:

```
MCP server "plugin:claudish:claudish" tool "team" sent no response or progress
for 1800s; aborting.
```

Prior claudish investigation (ROADMAP "Optional: notifications/progress", re-measured
2026-07-29 on 2.1.220) concluded progress notifications **render nowhere** and parked the
feature. So: does Claude Code want updates from a server at all, or does it expect
something else?

## Answer

It wants updates — but as a **liveness signal**, never as display. Rendering and
liveness are two independent consumers of the same notification, and the earlier
investigation only measured rendering. The parked ROADMAP item's own footnote
("not entirely inert — it still resets the client's request timeout") turns out to be
the whole story.

## Measurements

Probe: `scratchpad/idle-probe.ts` — three tools, identical 90s duration, differing only
in what they emit while working. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=30000` throughout.

| Tool | Emits during the 90s | Outcome |
|---|---|---|
| `silent_sleep` | nothing | **aborted at 30s** |
| `progress_sleep` | `notifications/progress` every 10s | **survived 90s** → `progress done` |
| `channel_sleep` | `notifications/claude/channel` every 10s | **aborted at 30s** |

All three received `progressToken: 2` in `params._meta`, logged server-side. The channel
arm emitted 3 frames with no emit errors before being killed, so its abort is not an
emission failure.

Matched pair `silent_sleep` vs `progress_sleep` is the decisive comparison: same
duration, same window, same server, same transport, one variable.

### Two corrections to prior belief

- **`anthropics/claude-code#58687` is stale.** It reports the client sends no
  `_meta.progressToken`, and was closed as not planned. On 2.1.231 the token **is**
  sent — observed in every arm, including runs against the older
  `progress-regression-mock.ts`.
- **`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` has an undocumented floor.** Values of `1000`
  and `5000` were silently ignored (a silent 20s call survived a nominal 5s window).
  `30000` was honored exactly. Anything testing this below ~30s will produce a
  confounded run where the control cannot fail.

## Why this bit `team`

`team` blocks for the whole multi-model run and puts nothing on the transport that
counts. claudish deliberately emits no `notifications/progress` (parked on
rendering grounds), and its chosen push mechanism — `notifications/claude/channel` —
is measured above **not** to reset the idle timer. In this session channels were not
even registered (plain `claude`, no `--channels`), so the transport was fully silent
for the stdio default idle window of 30 min = the observed 1800s.

## The two mechanisms are complementary, not alternatives

| | visible to agent/human | resets idle timer |
|---|---|---|
| `notifications/progress` | ✗ (renders nowhere, 2.1.220 + unchanged here) | ✓ |
| `notifications/claude/channel` | ✓ | ✗ |

A long-running MCP tool in Claude Code needs **both**. Channel for the story, progress
for the heartbeat.

## What Claude Code offers instead

- **Automatic backgrounding** (v2.1.212+): a main-conversation call still running at 2
  min becomes a background task. Observed working — the failed `team` call became task
  `k0eh3g6wi`. But backgrounding does **not** exempt the call: the docs are explicit
  that the wall-clock and idle limits still apply while it runs in the background,
  which is exactly how a backgrounded call still died at 1800s.
- **MCP Tasks (SEP-1686)** — the standards-track answer for call-now/fetch-later.
  Claude Code has **not** implemented client support (`anthropics/claude-code#18617`).
  claudish already tracks this for channel migration.

## Remedies, in order

1. **Emit `notifications/progress` from long-running tools** — the real fix. Requires
   un-parking the ROADMAP item on new grounds: not a UI feature, a keepalive. The
   transport-kill regression that originally made this dangerous was verified fixed on
   2.1.220; N-concurrent emission across simultaneous children remains unproven and is
   the one risk worth a dedicated test.
2. **Per-server `timeout` (ms) in `.mcp.json`** — from v2.1.203 a value ≥1000 acts as a
   floor on the idle timeout for that server only. Config-side, no code change.
3. **`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`** — disables the check globally. Blunt; it
   also removes the protection for genuinely hung servers.

## Open questions

- Does N-concurrent `progressToken` emission (one per child in a `team` run) still
  destabilize stdio? Untested; this probe emitted from a single call.
- Does the floor sit between 5s and 30s, and is it documented anywhere?

## Sources

- <https://code.claude.com/docs/en/mcp> — idle timeout, backgrounding, per-server timeout
- <https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress>
- <https://github.com/anthropics/claude-code/issues/58687> — stale progressToken claim
- <https://github.com/anthropics/claude-code/issues/18617> — SEP-1686 client support
- <https://modelcontextprotocol.io/seps/1686-tasks>
