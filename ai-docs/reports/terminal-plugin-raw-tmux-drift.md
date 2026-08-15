# Report: raw-tmux drift while using the `terminal` plugin

**Reporter:** Claude Code session, on behalf of Jack Rudenko
**Date:** 2026-08-11
**Plugin:** `terminal` v4.1.4 (MadAppGang)
**Skill loaded:** `terminal:terminal-interaction`
**Loaded from:** `~/.claude/plugins/cache/magus/terminal/4.1.4/skills/terminal-interaction/SKILL.md`
**Source of truth:** `/Users/jack/mag/magus/magus-src/plugins/terminal/skills/terminal-interaction/SKILL.md`
**MCP server:** `github.com/MadAppGang/tmux-mcp@v1.6.3`
**Client:** Claude Code 2.1.226, macOS darwin 25.6.0, arm64

**Scope note:** this document contains **no suggested fixes and no instructions**, by request. It records what the agent did wrong and what was observed to be wrong in the plugin. Every design decision that follows from it belongs to the plugin owner.

---

## Part 1 — What the agent did wrong

The user's instruction was: *"use your terminal skill and tmux-mcp to spawn a split pane in this window."* The task never got as far as a split pane.

| # | Call | Surface | Verdict |
|---|---|---|---|
| 1 | `list-sessions` | tmux-mcp | Wrong purpose — enumerated all 16 sessions trying to locate the agent's own pane |
| 2 | `Skill(terminal:terminal-interaction)` | — | Correct, but only after being corrected twice |
| 3 | `printenv TMUX_PANE` → `%74` | Bash | Defensible — env read, no MCP equivalent exists |
| 4 | `tmux display-message -t %74 -p '#{window_id}'` | **raw tmux** | Wrong — shelled out to tmux in order to feed an MCP tool |

Four faults, three of them the agent's alone:

1. **Acted before loading the skill.** Call 1 happened with no skill context. The skill's §1b explicitly forbids exactly that call for that purpose: *"Never call `list-sessions`/`list-windows`/`list-panes` just to find your own pane."*

2. **Shelled out to tmux to enable an MCP call.** Call 4 existed only because MCP `list-panes` requires a `windowId` the agent did not have. Using raw tmux as an adapter for tmux-mcp inverts the entire point of the server.

3. **Solved a problem the server already solves.** The goal behind calls 1 and 4 was "check whether a reusable helper pane exists." §1c states `split-pane` already performs idle-shell-sibling reuse server-side and reports `"reused": true`. After `printenv TMUX_PANE` returned `%74`, a single `split-pane({paneId: "%74", direction: "horizontal"})` was sufficient. Two round-trips were spent defending against a solved problem.

4. **Read the skill as a script rather than as context.** The agent executed the skill's worked example line by line — including its Bash lines — instead of treating §4's tool table as the contract and the examples as illustration. This is the fault that connects to Part 2: the example being executable-looking Bash is what made literal execution feel correct.

Net result: two wasted round-trips, one raw-tmux call, zero progress, and two user interruptions.

---

## Part 2 — What is wrong in the plugin

All line numbers refer to the **source** file (`magus-src/.../terminal-interaction/SKILL.md`). Each observation was verified in this session; commands and outputs are in Part 3.

### O1 — The skill's worked examples are written in raw tmux

The skill whose purpose is to route terminal work to `tmux-mcp` prescribes raw `tmux` in Bash at nine points:

```
159:  Bash: tmux select-layout -t {window_id} main-vertical
162:  Bash: tmux set-option -t {window_id} pane-border-status top
165:  Bash: tmux select-pane -t {pane_id}  -T "Dev Server"
166:  Bash: tmux select-pane -t {pane_id2} -T "Test Watcher"
167:  Bash: tmux select-pane -t {pane_id3} -T "App Logs"
187:  Bash: echo "$TMUX_PANE"
188:  Bash: tmux list-panes -F '#{pane_id} #{pane_title}' | grep claude-helper
191:  Bash: tmux select-pane -t %66 -T "claude-helper"
549:  Bash: echo "$TMUX_PANE"
552:  Bash: tmux list-panes -F '#{pane_id} #{pane_title}' | grep claude-helper
563:  Bash: tmux select-pane -t %66 -T "claude-helper"
```

Both of the skill's two "how to split a pane" walkthroughs — the §1b quick example and Example F, the canonical one — open with two raw-tmux steps before the first MCP call.

### O2 — Two capabilities the examples depend on have no MCP tool

The Bash in O1 is not stylistic; it is load-bearing. The 20-tool table in §4 contains no tool for:

- **pane self-location** — reading `$TMUX_PANE`, which §1b names as the *only* race-free way to answer "which pane am I in", backed by two documented real-world failures
- **pane labeling** — `select-pane -T`, on which the entire `claude-helper` ownership convention depends

An agent that follows §1b's own reasoning therefore *cannot* stay on MCP. The skill's rule and the server's surface do not cover the same ground.

### O3 — The safety guard protects the surface the skill tells you to avoid, not the one it tells you to prefer

`hooks/hooks.json` registers the guard with matcher `^Bash$` only:

> "block tmux kill-server and raw tmux send-keys/kill-pane/split-window into panes whose foreground is not a shell (e.g. a sibling claude session or a REPL)"

§1b states the resulting asymmetry plainly:

> "`mcp__tmux__send-keys` and `mcp__tmux__kill-pane` have **no occupancy guard** — they write to / kill exactly the `paneId` you pass, with no foreground check."

So raw Bash tmux is machine-enforced against writing into a sibling `claude` session, while the MCP path the skill directs you toward is protected only by the agent remembering to call `pane-state` first. The plugin manifest's own description — *"refuses to send keys into a pane that already has a process in the foreground"* — is true of the Bash path and not of the MCP path.

### O4 — The self-location prohibition and the `list-panes` signature pull in opposite directions

§1b forbids `list-panes` for self-location. But `list-panes` requires a `windowId`, and no MCP tool produces one from a `paneId`. An agent that wants to inspect pane titles in its own window has no MCP route to the required argument, and the nearest available route is raw `tmux display-message`. This is the exact path the agent took in call 4.

### O5 — Example F still prescribes the manual check that §1c makes redundant

§1c documents that `split-pane` reuses idle shell siblings server-side and returns `"reused": true`, and notes the two mechanisms "cooperate". Example F nonetheless retains the manual `claude-helper` scan as step 2 — and that step is one of the raw-tmux calls from O1. The redundant step is the one that costs the MCP-purity guarantee.

### O6 — Two of the five Layer-2 tools are documented as non-functional on the primary client

§1's decision table names `start-and-watch` or `watch-pane` as the primary tool for three of its eight rows. §3 then states:

> "**Known limitation (as of March 2026)**: Claude Code's MCP client does not yet support the MCP Tasks API. Calling `start-and-watch` or `watch-pane` returns error `-32601: requires task augmentation`."

The reader meets the recommendation in §1 and the retraction in §3.

**Measured 2026-08-11 against Claude Code 2.1.227: the documented limitation no longer reproduces.** A `watch-pane` call with `triggers` and `timeout: 300` was accepted, ran past the client's 120s foreground window, and was moved to a background task (`k37dh4aj7`) with a completion notification promised — the MCP Tasks path the note says is missing. No `-32601` was returned.

So §3's retraction is stale, and it is the more damaging direction of staleness: it steers readers away from the two tools §1 names as primary for three of its eight rows, toward manual `send-keys` + `capture-pane` polling loops that the Layer-2 tools exist to replace. The note carries its own "as of March 2026" hedge, which is the only reason a careful reader would think to re-test it.

### O7 — The cached skill carries a stale version stamp

The installed cache and the repo source both sit under version `4.1.4`, and their **bodies are byte-identical**. They differ only in frontmatter: the cached copy carries five extra fields that source has dropped, including:

```yaml
version: 3.0.0
updated: 2026-06-04
```

So the shipped `SKILL.md` self-declares `3.0.0` while the `plugin.json` shipped beside it declares `4.1.4`.

---

## Part 3 — Verification performed

| Claim | Command | Result |
|---|---|---|
| Skill is a plugin, not project-local | `cat .../terminal/4.1.4/plugin.json` | `terminal` v4.1.4, MadAppGang, ships `.mcp.json` + `hooks.json` |
| claudish has no terminal skills of its own | `ls .claude/skills` in claudish worktree | only `1password-sdk`, `pr-comment` |
| Raw-tmux prescriptions (O1) | `grep -n "Bash:" SKILL.md` on source | 11 hits, lines 159–563 |
| No MCP self-location / labeling tool (O2) | grep for MCP-prefixed `select-pane`/`TMUX_PANE`/`current-pane` | no matches |
| Bash-only guard (O3) | `cat hooks/hooks.json` | `"matcher": "^Bash$"` |
| Cache vs source (O7) | `diff` cache/source `SKILL.md` | one hunk, `4,8d3`, frontmatter only |
| Source version | `grep '"version"' magus-src/.../plugin.json` | `4.1.4` |
| O6 no longer reproduces | `watch-pane({paneId, triggers, timeout: 300})` on Claude Code 2.1.227 | accepted, backgrounded as task `k37dh4aj7`; no `-32601` |

Agent pane during the session: `%74`, window `@46`, session `claudish`.

---

## What is not in this report

- No proposed tool additions, no rewrites of §1b or Example F, no hook-matcher changes.
- The claudish `team` silent-dropout investigation that this session was actually doing is unrelated and is not covered here.
