> The SSE-replay format-translation harness and how to add a regression test.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Test Infrastructure

## Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.
