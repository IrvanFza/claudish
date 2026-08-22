> One detected theme for every surface, and the module-load palette-snapshot bug class it keeps producing.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Light/Dark Theme (auto-detected)

Every screen and every colored CLI line resolves through ONE detected terminal
theme. `theme/theme-mode.ts` is the sole authority — dependency-free (never
pulls OpenTUI into a plain CLI path) — with sources in precedence order:
`CLAUDISH_THEME=light|dark` (override; also the deterministic lever for tests
and screenshot harnesses) → `COLORFGBG` → a bounded OSC 11 query (only when
stdin AND stdout are OUR TTYs, so a piped/proxied claudish never writes escapes
into another program's stream). The three OpenTUI boots (config TUI, probe TUI,
resume picker) instead feed `renderer.waitForThemeMode(250)` into the same
state via `theme/renderer-theme.ts`, pre-first-paint.

**Unknown resolves to DARK — the status quo, never a guess.** Every dark value
is byte-identical to what claudish always shipped (pinned by
`tui/theme-contrast.test.ts` snapshot equality); only a POSITIVE "light"
detection changes anything. That contract is why detection failing silently is
safe: it looks like yesterday's claudish, not like white-on-white.

**The palette is MUTABLE and everything derived must refresh.** `tui/theme.ts`
reassigns `C` in place on every mode change; derived palettes register via
`registerPaletteRefresher` (viz `tokens`/`ramps` re-snapshot there; `STAGE_BG`,
`STAGE_FG`, `STAGE_BG_ANSI`, latency buckets refresh in `applyTuiTheme`). The
recurring bug class this creates: **a module-level `const X = C.foo` (or
`tokens.foo`) snapshots the DARK value before detection completes** — command
modules are imported before detection runs. Found SIX times during the build
(resume-picker's `MUTED`/`SCROLLBAR`/calendar scale, session-summary's
`TOOL_COLORS`, conversation-reader's `BAR_COLOR`, and `STAGE_FG`, the last one
only visible in a live screenshot). The rule: read `C.*`/`tokens.*` at RENDER
time, or convert the constant to a function; plain CLI files call `cliAnsi()`
(`theme/ansi.ts`) INSIDE the command function, never at module load.

Token semantics that make one component tree serve both palettes: `C.ink` is
always white — ink on fills claudish paints that stay mid/dark in BOTH themes
(pills, latency chips, active tab); `C.strong` is emphasized text on the page
or on the light theme's selection WASH (`#bfdbfe`) — white on dark, near-black
on light. Never use `C.white` for page text. Light accents are deep and
saturated (all ≥4.5:1 on white, enforced by `theme-contrast.test.ts`, with the
same WCAG math as `resume-picker-contrast.test.ts`, which grades both chip
palettes).

CLI escapes: dark/unknown emits the CLASSIC 16-color codes (byte-identical to
the old hand-rolled blocks); light emits deep truecolor; `NO_COLOR` empties
everything — it was advertised as global in `--help` and is now actually
honored globally. The status-line scripts CANNOT self-detect (they run later
inside Claude Code), so `createTempSettingsFile`/`createStatusLineScript` bake
the detected mode at generation time. `team-grid.ts` banners are deliberately
theme-independent (self-contained mid-dark fill + bright-white ink pairs).

Testing gotcha: `setThemeMode` flips a process-global palette and Bun runs
sibling test files in one process — always restore (`resetThemeModeForTests()`
re-publishes `null`; it deliberately does NOT clear the listener registry,
which would freeze the palette for every later test file).
