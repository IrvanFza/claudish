#!/usr/bin/env bun
/**
 * Fake claudish child for the MCP team shape-contract test.
 *
 * The real flags (`--model`, `-y`, `--stdin`, `--quiet`) are intentionally
 * ignored. The child drains stdin, then reproduces the measured 250-byte final
 * message from a run whose real answer was displaced by a background-task turn.
 */

export {};

const DROPOUT_EPILOGUE =
  'The background agent finished: it counted **99** `.ts` files under `packages/cli/src/` containing "timeout" (case-insensitive; 77 for strict-lowercase). ' +
  "That was step 1's parallel task — the review and vote above are complete and unaffected by it.";

async function main() {
  for await (const chunk of process.stdin) {
    void chunk;
  }

  process.stdout.write(`${DROPOUT_EPILOGUE}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
