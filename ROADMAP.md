# Roadmap

Planned-but-unimplemented work for Claudish. Items here are deliberately scoped, with explicit **trigger conditions** — what needs to be true upstream or in our codebase before each item moves to active development. If a trigger condition isn't met, leave the item parked.

For shipped features and current architecture, see `CLAUDE.md`. For ad-hoc research and validation sessions, see `ai-docs/sessions/`.

---

## Channel notifications

### Phase 1 — SEP-1686 forward-compat fields ✅ Shipped

Status: complete (this branch).

The channel bridge now emits `task_id`, `status` (5-value SEP-1686 enum), `created_at`, `last_updated_at` alongside our existing fields. Wire format pinned by `channel-wire-format.test.ts` (8 tests, perturbation-verified). No consumer behavior change.

See: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md`

### Phase 2 — `notifications/tasks/status` behind a flag

Status: blocked on upstream. Not started.

When ready, we add a `CLAUDISH_NOTIFY_VIA_TASKS=1` env var. When set, the bridge emits `notifications/tasks/status` with a restructured payload (flatten `meta.task_id → params.taskId`, etc.) alongside the existing `notifications/claude/channel`. Add a parallel test fixture pinning the new wire format.

**Trigger conditions** (all must hold):
- Claude Code ships a release whose CHANGELOG mentions SEP-1686 / `notifications/tasks/status` receiver support, AND the new method surfaces task notifications into the **agent's context** (not just CLI UI).
- The TypeScript MCP SDK ships a server-side helper for emitting `notifications/tasks/status`. Reference impl is `modelcontextprotocol/typescript-sdk#1041` (currently OPEN as of 2026-05).
- We've manually verified per-child completion notifications surface in the orchestrator agent's context during a `team` run.

**Effort**: small. Most work is already done in Phase 1 (the data is in `meta`); Phase 2 is mainly a payload-reshape function + new test fixture + env-var gate.

Reference: same migration schema doc as Phase 1.

### Phase 3 — Flip default + drop the legacy method

Status: blocked on Phase 2.

Default to `notifications/tasks/status`. Keep emitting `notifications/claude/channel` for one major version as a fallback for users still on older Claude Code versions. Then remove.

**Trigger condition**: 6+ months after Phase 2 ships AND > ~80% of Claudish users are on Claude Code versions with Tasks receiver support (heuristic — measure via `--probe` telemetry if we ever add it, otherwise judgment call).

---

## ~~Optional: `notifications/progress` as a secondary CLI-UI signal~~ — Parked

Status: **investigated, decisively parked, with a corrected rationale**. Not implementing.

We considered emitting `notifications/progress` from `team`'s child-completion callback as a richer terminal UI signal. Two issues, one of which we initially got wrong:

- ❌ **Claude Code does not render progress notifications anywhere observable.** Verified 2026-05-09 against Claude Code 2.1.133 with `progress-regression-mock.ts`'s `slow_with_many_progress` tool emitting 5 distinct progress messages over ~10s. Mid-flight pane capture showed no terminal-UI rendering. The agent reported verbatim: *"I did not observe any progress messages during the call... nothing was surfaced to the agent context."* Matches the Anthropic-attributed comment on `anthropics/claude-code#4157`: *"Claude Code doesn't currently have a generic UI for displaying real-time progress from custom MCP servers."*
- ❌ **The transport-kill regression is NOT fixed in 2.1.133 — earlier note that it was, was wrong.** A first test on 2026-05-09 (`progress-regression-mock.ts`'s `slow_ping_with_progress` + `simple_ping`) reported the regression resolved. **That test was insufficient.** It used sequential `await` ordering, putting all progress notifications strictly *before* the tool response, which avoids the race. The actual trigger documented in `GLips/Figma-Context-MCP#362` is **concurrent or quick-succession tool calls** where a progress notification arrives at the client *after* its `progressToken` cleanup has run. The MCP SDK then treats it as a protocol violation (`"Connection error: Received a progress notification for an unknown token"`) and tears down stdio. This bug is documented as still affecting Claude Code 2.1.x in the field. **The `team` use case (N concurrent child sessions, each with its own `progressToken`) is the exact pattern that triggers the bug.**

So implementing this not only adds code that fires into a void — it would actively destabilize `team`. Two independent reasons not to do it.

### Re-measured 2026-07-29 against Claude Code **2.1.220** — one blocker is gone, one is confirmed harder

Probes: `packages/cli/src/channel/test-helpers/capability-probe.ts` (agent context, `-p`) and
`progress-regression-mock.ts` driven through an interactive tmux session (terminal UI).
Full findings: `ai-docs/sessions/dev-arch-20260729-171308-1dad34b5/capability-findings.md`.

- ✅ **Blocker 2 (transport kill) is FIXED.** Emitting 3 progress notifications no longer tears down
  stdio: the immediately-following `probe_ping` call returned `pong`, with no `STDIN_END` and no emit
  errors. The stated reason for parking — that `team`'s concurrent `progressToken`s would destabilize
  the transport — no longer holds. **Caveat:** the probe emitted from ONE tool call; true N-concurrent
  emission across simultaneous children is still unproven.
- ❌ **Blocker 1 (no rendering) CONFIRMED, now on both surfaces.** Previously only agent context was
  tested. Now both:
  - *Agent context* (`-p`): agent answered **NO** to seeing any of `PROBE-STEP-1/2/3` while the server
    log shows all 3 emitted.
  - *Interactive terminal UI*: sampled the screen every 1.2 s for 31 s, spanning the full 7.5 s
    emission window of `slow_with_many_progress`. The tool row rendered as a static
    `⏺ pmock - slow_with_many_progress (MCP)` across 20 consecutive samples. **Not one** of the five
    messages ("scanning files", "parsing AST", "running checks", "aggregating results",
    "writing output") ever appeared.

This matches `anthropics/claude-code#51713` — MCP tool calls are unconditionally collapsed, showing
only the server/tool name with no streaming output. Per that issue, progress DID render up to
**2.1.101** and regressed by **2.1.116**; our original 2.1.133 measurement therefore landed inside the
regression window. **#51713 is closed, but the regression is still live in 2.1.220.**

Note `notifications/progress` is not entirely inert — it still resets the client's request timeout.
It simply has no display.

**Superseded by**: `team` now reports live per-model stats over `notifications/claude/channel`
(measured working) plus a `status.txt` in the session directory. See "Live team progress" below.

**Trigger condition for un-parking** (only #2 remains):
1. ~~Claude Code's MCP SDK fixes the strict-token-validation bug~~ — **met 2026-07-29** (verified on 2.1.220).
2. Claude Code ships UI/agent rendering for progress notifications from custom MCP servers
   (`anthropics/claude-code#4157`, `#51713`). Re-run both probes on each client upgrade to detect it.

**References**:
- Original empirical session: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/`
- Community-research session that surfaced the corrected understanding: `ai-docs/sessions/dev-research-mcp-progress-community-20260509-213410-c058a909/`
- Re-measurement against 2.1.220: `ai-docs/sessions/dev-arch-20260729-171308-1dad34b5/capability-findings.md`
- Test artifacts: `packages/cli/src/channel/test-helpers/progress-regression-mock.ts`, `capability-probe.ts`, `capability-probe-2.ts`
- Field evidence of the still-active bug: <https://github.com/GLips/Figma-Context-MCP/issues/362>

---

## Live team progress — shipped

`team` runs take minutes and, in `--quiet` print mode, children emit nothing until they finish. There
was previously no signal at all between "started" and "done". Two transports now carry live per-model
stats, chosen because they are the two that actually reach a reader:

| Transport | Reaches | Requires |
|---|---|---|
| `notifications/claude/channel` | the agent's context (renders as a `<channel>` block) | the channel gating in CLAUDE.md — `--channels`, interactive, `.mcp.json` |
| `<session>/status.txt` | a human, via `tail -f` | nothing; works headless and in CI |

`notifications/progress` was NOT used — measured to render nowhere on 2.1.220 (see above).

**How per-model attribution works.** `token-tracker.ts` writes tokens/cost to
`~/.claudish/tokens-<port>.json`, keyed to a port each child picks for itself, so an orchestrator
spawning N children could not tell which file belonged to which model. `CLAUDISH_TOKEN_FILE` now
overrides that path, and `runModels` points each child at `<session>/stats/<id>.json`.

**Format** — plain ASCII, no ANSI (channel frames render escapes literally):

```
team: 2 models, 2 done, 7s, 102.9k tok, $0.104
  01 or@gemini-3.6-fla… done    160B    48.1k/234  $0.049
  02 grok-4.5           done    118B     54.6k/19  $0.055
```

**Knobs**: `onProgress` (callback) and `progressIntervalSeconds` (default 5) on `TeamRunOptions`.

**Implementation**: `packages/cli/src/team-stats.ts`, wired in `team-orchestrator.ts` (ticker +
child env) and `mcp-server.ts` (`ChannelNotifier` passed into `defineTools`).

---

## Optional: submit `code-analysis` plugin to Anthropic's channel allowlist

Status: not started. Anthropic-gated.

Today, Claudish-via-`code-analysis@magus` requires users to launch with `--dangerously-load-development-channels plugin:code-analysis@magus` for channel notifications to work. Each session shows a confirmation prompt. The friction is small but real.

Anthropic's [official plugin marketplace](https://github.com/anthropics/claude-plugins-official) accepts plugin submissions for inclusion in the global channel allowlist. Once accepted, users can switch to plain `--channels plugin:code-analysis@magus` (no dev flag, no confirmation).

**Trigger condition**: a user explicitly asks for the friction to go away, OR Claudish becomes used widely enough outside MadAppGang that the per-session prompt becomes a meaningful onboarding cost.

**Counter-consideration**: submitting to Anthropic's allowlist invites security review and ties our release cadence partially to theirs. Not worth doing for a small team's internal use.

Reference: research findings under `ai-docs/sessions/dev-research-channel-config-alternatives-20260508-233443-3f43f254/` confirm this is the only documented path to remove the dev flag for individual users.

---

## Gemini Code Assist: use `fetchAvailableModels` for the served set

**Status**: not started

`getServedCodeAssistModels()` in `auth/gemini-oauth.ts` infers which models a
tier serves by reading the bucket list from `retrieveUserQuota`. That is an
inference, not an answer: it only reports models that have a quota bucket, and it
costs a quota round-trip on the auth path.

The backend exposes a purpose-built endpoint, `v1internal:fetchAvailableModels`.
Probing on 2026-08-01 confirmed it exists on both `cloudcode-pa.googleapis.com`
and `daily-cloudcode-pa.googleapis.com` — both answered HTTP 400 *"Unknown name
metadata: Cannot find field"* rather than 404, so the method is real and only its
request shape is unknown. Antigravity's logs show it in normal use.

**Trigger condition**: the quota-bucket inference produces a wrong served set in
practice (a served model missing from the list, or a listed model that 404s), OR
someone captures the correct `fetchAvailableModels` request shape.

**Effort estimate**: small once the payload shape is known — one function swap
behind the existing `getServedCodeAssistModels()` seam, with the quota-bucket
path kept as the fallback.

---

## Gemini Code Assist: individuals/Ultra tier needs an Antigravity-issued token

**Status**: SHIPPED — the `antigravity` provider (`ag@`) reuses the Antigravity
CLI's own token. See CLAUDE.md → "Antigravity Provider (ag@)".

The finding that unblocked it: the two backend checks are independent —
`loadCodeAssist` gates on request IDENTITY (`User-Agent` + `metadata.ideType`),
but `streamGenerateContent` gates on the TOKEN'S OAuth CLIENT (headers can't fake
it — 403 PERMISSION_DENIED for a gemini-cli token no matter the identity). So
claudish does NOT spoof its way in; it **reuses the user's own Antigravity token**
(the same one the `agy` CLI mints) from the shared macOS keychain store, and
self-refreshes with client creds extracted at runtime from the user's local `agy`
binary — never shipped. Verified end-to-end on Google AI Ultra with
`gemini-3.6-flash-high`.

**Remaining follow-ups** (own items when triggered): Linux/Windows keyring
backends (macOS `security` only today); a `claudish login antigravity` that does
its own OAuth so Antigravity need not be installed.

---

## Adding a new roadmap item

Each item should follow the structure above:
- **Status**: `not started` / `blocked on upstream` / `in progress` / `shipped`
- **Trigger condition**: explicit and falsifiable. *"When X happens"* > *"Someday"*. If you can't write a trigger condition, the item probably isn't ready to be on the roadmap yet.
- **Reference**: pointer to the research session, issue, or design doc with detail. Do not duplicate that detail here.
- **Effort estimate** (optional): rough sizing if the item moves toward action.

If a trigger condition has been met, move the item to *In Progress* and create the implementation tasks. If a trigger condition becomes irrelevant or wrong, delete the item rather than leave it stale.
