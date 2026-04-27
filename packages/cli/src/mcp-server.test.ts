/**
 * Regression tests for mcp-server.ts.
 *
 * Run: bun test packages/cli/src/mcp-server.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_SOURCE = readFileSync(join(__dirname, "mcp-server.ts"), "utf-8");

describe("list_models MCP handler — source-level regression guard", () => {
  // Guards against reintroducing the stale-model-list bug.
  // The handler must await the async resolver, which runs the 4-tier
  // in-memory → fresh-disk → Firebase → bundled resolution.
  // The sync variant skips Firebase and has no freshness check on the disk
  // cache, so it silently served stale data.
  test("awaits getRecommendedModels (async resolver)", () => {
    expect(MCP_SERVER_SOURCE).toContain("await getRecommendedModels(");
  });

  test("does not call getRecommendedModelsSync (stale-by-design)", () => {
    expect(MCP_SERVER_SOURCE).not.toContain("getRecommendedModelsSync(");
  });
});
