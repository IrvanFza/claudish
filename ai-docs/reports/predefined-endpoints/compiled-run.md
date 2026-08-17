# R8 compile proof — recorded run

**Date**: 2026-08-14
**Script**: `validation/compile-proof.ts` (throwaway validation, deliberately outside the repo source tree)
**Command**: `bun run ai-docs/sessions/dev-feature-predefined-endpoints-20260814-000000-a1b2/validation/compile-proof.ts`
**Bun**: 1.3.10

## What it does

1. Writes a two-line entry module importing `PREDEFINED_ENDPOINTS` from
   `packages/cli/src/providers/predefined-catalog.ts` and printing `{count, firstBaseUrl, firstName}`.
2. `bun build --compile`s it into a single-file executable in a temp dir.
3. Executes that binary **from an unrelated temp working directory** with a **scrubbed env**
   (`PATH=/usr/bin:/bin` only), so nothing can resolve relative to the repo and nothing can be
   supplied from outside.
4. Compares the binary's output against the source array read in-process.

## Actual output (verbatim)

```
--- bun build --compile ---
[4ms]  bundle  2 modules
  [69ms] compile  /var/folders/ch/50hwlbxs7k588shf059gzzph0000gn/T/claudish-compile-proof-N3BLhh/catalog-probe
--- compiled binary, scrubbed env, unrelated cwd ---
cwd:    /var/folders/ch/50hwlbxs7k588shf059gzzph0000gn/T/claudish-compile-run-HLLFHz
stdout: {"count":1,"firstBaseUrl":"https://api.groq.com/openai","firstName":"groq"}
--- comparison ---
expected (source array): {"count":1,"firstBaseUrl":"https://api.groq.com/openai","firstName":"groq"}
actual   (compiled bin): {"count":1,"firstBaseUrl":"https://api.groq.com/openai","firstName":"groq"}
PASS: catalog survives --compile
```

Exit code `0`.

## Verdict

**PASS.** The catalog array is embedded in the executable. There is no run-time lookup, so there is
nothing that can fail to resolve on a Homebrew install (a bare executable with no sidecar files) —
which is exactly what R8 requires and what the rejected `readFileSync(import.meta.dir, …)` form
cannot provide.

`architecture.md` §3's file-format decision therefore stands, and the two reviewers who asked for
this proof to move into Phase 1 got their answer before anything was built on top of it.

## One incidental fact worth recording

`bundle 2 modules` — the entry plus `predefined-catalog.ts`. `predefined-endpoint-schema.ts` does
**not** appear, because the catalog imports it with `import type` and the type is erased. So the
shipped-data module carries no Zod dependency into the binary; validation of the rows is a
build/CI-time concern, as intended. If a later phase makes the catalog import the schema VALUE
(to self-validate at load), this count becomes 3+ and the binary grows — a deliberate trade to make
knowingly, not by accident.
