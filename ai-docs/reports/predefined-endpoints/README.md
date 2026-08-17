# Predefined endpoints — measurement evidence

Provenance for the 25-vendor bundled catalog shipped in v7.51.0
(`packages/cli/src/providers/predefined-catalog.ts`). Cited from CLAUDE.md's
"Predefined Endpoints" section.

Tracked deliberately. These started life in `ai-docs/sessions/`, which is
gitignored and does not survive `git worktree remove` — the exact way three
earlier write-ups CLAUDE.md cites were lost. A session directory is where you
work; this is where the conclusion goes.

| File | What it establishes |
|---|---|
| `vendor-measurements.md` | The probe method and the per-vendor result table. 30 candidates tested, 25 ship, 5 excluded with named reasons. |
| `probes/probe-results.json` | Raw pass-1 responses for all 30 candidates. |
| `probes/probe-v2-results.json` | Pass-2 re-probe of the 9 pass-1 casualties, using the sibling-path comparison. |
| `live-run.md` | The end-to-end live verification (C1): a real turn through a real vendor with a real key, with the outbound URL from the debug log. |
| `error-shape-probe.md` | What claudish's classifier does with the two non-OpenAI error shapes (`parasail`, `writer`). |
| `compiled-run.md` | The R8 proof: the catalog survives `bun build --compile`, verified from a foreign cwd with a scrubbed env. |

## What this evidence does and does not establish

**Does**: that each shipped `baseUrl + apiPath` reaches a live endpoint which
authenticates, and that the configured path is the vendor's real one rather than a
catch-all. The sibling-path comparison is what buys that — a bogus sibling path
answering differently proves the route resolved.

**Does not**: anything about a vendor's streaming dialect. A 401 says nothing
about SSE chunking, tool-call encoding, `finish_reason` vocabulary, or error-body
shape on a successful turn. **All 25 rows are `tier: "probe"`. None is
`tier: "live"`**, because no credential is held for any of them.

The LAYER is verified live end to end (`live-run.md`); the DIALECT of each vendor
is not.

## Re-running the probe

The probe is worth re-running before a release: a vendor that moves its API path
should be caught by us rather than by a user. The method is described in
`vendor-measurements.md` § Method. A `GET /v1/models` result is never accepted as
evidence — Alibaba's `coding-intl` returns its full roster to a bogus key and to
no key at all.
