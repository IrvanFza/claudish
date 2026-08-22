> The SSE-replay format-translation harness and how to add a regression test.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Test Infrastructure

## Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## A gate must not also gate its own diagnostic

`e2e-channel.test.ts` Group 2 spawns a real `claude -p`, so it needs a working credential.
It gates on a genuine probe — one tiny headless prompt, treating a login/credential error as
"not usable" — which is the right design. But the probe itself lived inside
`if (!SKIP_LIVE_E2E) { … }`.

So running with `CLAUDISH_SKIP_LIVE_E2E=1` — which is the normal, recommended way to run this
suite — meant the probe never executed, `claudeUsable` stayed `false`, and Group 2 reported:

```
[e2e-channel] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated
```

**That message is a claim about the environment that the environment was never asked.** It is
indistinguishable from the same message on a machine with genuinely no credential, and it was
repeated in status reports for hours as "environment-gated" when the real answer was "not
asked". Removing the flag ran the probe and recovered the tests; with a credential present,
all 15 in the file pass with zero skips.

**The general form: a mechanism that reports state must not be disabled by the same switch
that disables the work.** Where a skip is conditional, its REASON must be computed
unconditionally, or the skip message must say "not checked" rather than naming a cause. A
diagnostic that is silenced along with the feature cannot tell you why the feature is off —
it can only repeat its default.

Same shape as `team`'s exit 0 (`team-capture.md`): a status whose failure mode is to look
like a confident answer. Prefer "unknown" to a plausible guess in any automated report.
