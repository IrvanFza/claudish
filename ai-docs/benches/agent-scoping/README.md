# agent-scoping — does `--agent` reach the child?

```bash
madbench preflight ai-docs/benches/agent-scoping/madbench.yaml   # can it run
madbench check     ai-docs/benches/agent-scoping/madbench.yaml   # does it grade anything
madbench           ai-docs/benches/agent-scoping/madbench.yaml   # the real run
```

## Status

| gate | result |
|---|---|
| `list` | passes |
| `preflight` | **BLOCKED** — no `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` |
| `check` (negative control) | **holds** — 3/3 cells failed as required, 0 errored, 0 wrongly passed |
| real run | **not yet run** — blocked on the credential above |

To unblock the real run: `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN`
(bills the subscription) or `ANTHROPIC_API_KEY` (bills the API). Either also works
from `./.env`.

## Why these settings

- **`sandbox: workspace`, not `home`.** `home` replaces HOME, which hides the
  claude.ai login in `~/.claude`. `workspace` still isolates the working tree, so
  the agent cannot touch the real repo.
- **`--agent Explore`, a BUILT-IN.** Plugin agents (`dev:reviewer`,
  `dev:architect`) live in `~/.claude/plugins` and vanish at sandbox levels that
  replace HOME, so they would fail as `not found` — a harness error, not a graded
  result. The built-in roster is `claude, Explore, general-purpose, Plan,
  statusline-setup`.
- **No `cost` / `latency` checks yet.** Both ERROR when the harness reports no
  metrics, so they break the negative control (measured: 3/5 failed, 2 errored).
  Add them after 2-3 real runs, tuned to ~1.5-2x the observed max.

## What this does NOT cover, and where that lives instead

madbench grades what an AGENT did, and `madbench check` enforces it: a cell that
passes under the mock harness is grading nothing. These claudish-internal
behaviours are therefore not honestly expressible here:

| behaviour | covered by |
|---|---|
| native slot resolves `internal` -> `opus` tier | `cli-native-model-normalization.test.ts` + measured e2e |
| `require_pattern` reports a non-voting slot FAILED | `team-orchestrator.test.ts`, and a measured `EMPTY`/`shape_mismatch` run |
| unknown agent rejected before spawn | `agent-availability.test.ts` (10 tests) |
| `rate_limit_event` kept out of the captured answer | `team-stream-capture.test.ts` (3 tests) + a measured 191 B -> 3 B run |

Full evidence: `ai-docs/reports/native-team-slots.md`.
