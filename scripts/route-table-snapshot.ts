#!/usr/bin/env bun
/**
 * The routing gate: pin the route of every catalog model, then prove a change moved
 * only what it meant to move.
 *
 * The routing redesign replaces a hand-written table with candidates gathered from
 * the cloud models catalog. That changes EVERY bare-name route at once, so the only
 * honest gate is the whole table, read twice. A passing test suite cannot show this:
 * the suite asserts the routes someone thought to write down, and the ones nobody
 * wrote down are exactly where a silent removal hides.
 *
 * Capture BEFORE the change, capture again after, then diff:
 *
 *   bun run scripts/route-table-snapshot.ts capture before.json
 *   # ... make the change ...
 *   bun run scripts/route-table-snapshot.ts capture after.json
 *   bun run scripts/route-table-snapshot.ts diff before.json after.json
 *
 * The diff classifies every difference. `lost` is the one that must be empty unless
 * the design names that removal: a provider that used to serve a model and no longer
 * appears is a user whose key stopped working, with no error to read.
 *
 * Environment-dependent by design. It calls the real `route()`, so it sees this
 * machine's credentials and `defaultProvider`. Both snapshots must come from the
 * same machine with the same configuration, which is why each file records them.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/cli/src/profile-config.js";
import { readAllModelsCache } from "../packages/cli/src/providers/all-models-cache.js";
import { route } from "../packages/cli/src/providers/routing-rules.js";

/** One model's resolved chain, flattened to the strings a request would carry. */
interface RouteRow {
  modelId: string;
  kind: "ok" | "no-route";
  /** `provider@model` per hop, primary first. Empty for `no-route`. */
  chain: string[];
  /** Why there is no route, verbatim. Only for `no-route`. */
  reason?: string;
}

interface Snapshot {
  capturedAt: string;
  catalogGenerationId: string;
  /** Recorded because the chain is credential-filtered: a different machine gives a different table. */
  defaultProvider: string | undefined;
  entryCount: number;
  rows: RouteRow[];
}

/** How many routes to resolve at once. `route()` can touch discovery, so it is not free. */
const CONCURRENCY = 8;

async function capture(outPath: string, limit?: number): Promise<void> {
  const cache = readAllModelsCache();
  if (!cache || cache.entries.length === 0) {
    console.error(
      `No cloud models catalog cache at ${join(homedir(), ".claudish", "cloud-models-catalog-v3.json")}.\n` +
        "Refresh it first — an empty catalog captures an empty table, which would make any diff look clean.",
    );
    process.exit(1);
  }

  const modelIds = cache.entries.map((entry) => entry.modelId);
  const ids = limit ? modelIds.slice(0, limit) : modelIds;
  const rows: RouteRow[] = [];
  let done = 0;

  for (let start = 0; start < ids.length; start += CONCURRENCY) {
    const batch = ids.slice(start, start + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (modelId): Promise<RouteRow> => {
        try {
          const plan = await route(modelId);
          if (plan.kind === "ok") {
            return {
              modelId,
              kind: "ok",
              chain: [plan.primary, ...plan.fallbacks].map((hop) => hop.modelSpec),
            };
          }
          return { modelId, kind: "no-route", chain: [], reason: plan.reason };
        } catch (error) {
          // A throw is itself a finding: record it rather than losing the row.
          return {
            modelId,
            kind: "no-route",
            chain: [],
            reason: `threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    );
    rows.push(...settled);
    done += batch.length;
    if (done % 200 === 0 || done === ids.length) {
      process.stderr.write(`  resolved ${done}/${ids.length}\n`);
    }
  }

  const snapshot: Snapshot = {
    capturedAt: new Date().toISOString(),
    catalogGenerationId: cache.catalogGenerationId,
    defaultProvider: loadConfig().defaultProvider,
    entryCount: cache.entries.length,
    rows,
  };
  await Bun.write(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const routed = rows.filter((row) => row.kind === "ok").length;
  console.log(
    `Wrote ${outPath}: ${rows.length} models, ${routed} routed, ${rows.length - routed} with no route, generation ${snapshot.catalogGenerationId}.`,
  );
}

function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf-8")) as Snapshot;
}

function diff(beforePath: string, afterPath: string): void {
  const before = loadSnapshot(beforePath);
  const after = loadSnapshot(afterPath);

  if (before.catalogGenerationId !== after.catalogGenerationId) {
    console.warn(
      `WARNING: different catalog generations (${before.catalogGenerationId} vs ${after.catalogGenerationId}).\n` +
        "Differences below mix the code change with a catalog change and cannot be attributed to either.\n",
    );
  }
  if (before.defaultProvider !== after.defaultProvider) {
    console.warn(
      `WARNING: defaultProvider differs (${before.defaultProvider ?? "(none)"} vs ${after.defaultProvider ?? "(none)"}). The fallback hop will differ for every model.\n`,
    );
  }

  const beforeRows = new Map(before.rows.map((row) => [row.modelId, row]));
  const afterRows = new Map(after.rows.map((row) => [row.modelId, row]));

  const lost: string[] = []; // a provider that used to serve this model no longer appears
  const gained: string[] = []; // a new provider appears
  const reordered: string[] = []; // same providers, different order
  const becameNoRoute: string[] = [];
  const becameRouted: string[] = [];
  const disappeared: string[] = []; // model absent from the after snapshot
  const appeared: string[] = [];

  for (const [modelId, beforeRow] of beforeRows) {
    const afterRow = afterRows.get(modelId);
    if (!afterRow) {
      disappeared.push(modelId);
      continue;
    }
    if (beforeRow.kind === "ok" && afterRow.kind === "no-route") {
      becameNoRoute.push(`${modelId}: had ${beforeRow.chain.join(" -> ")}; now ${afterRow.reason ?? "no reason"}`);
      continue;
    }
    if (beforeRow.kind === "no-route" && afterRow.kind === "ok") {
      becameRouted.push(`${modelId}: now ${afterRow.chain.join(" -> ")}`);
      continue;
    }
    const beforeSet = new Set(beforeRow.chain);
    const afterSet = new Set(afterRow.chain);
    const missing = beforeRow.chain.filter((hop) => !afterSet.has(hop));
    const extra = afterRow.chain.filter((hop) => !beforeSet.has(hop));
    if (missing.length > 0) {
      lost.push(`${modelId}: lost ${missing.join(", ")}  (was ${beforeRow.chain.join(" -> ")})`);
    }
    if (extra.length > 0) {
      gained.push(`${modelId}: gained ${extra.join(", ")}`);
    }
    if (missing.length === 0 && extra.length === 0 && beforeRow.chain.join("|") !== afterRow.chain.join("|")) {
      reordered.push(`${modelId}: ${beforeRow.chain.join(" -> ")}  =>  ${afterRow.chain.join(" -> ")}`);
    }
  }
  for (const modelId of afterRows.keys()) {
    if (!beforeRows.has(modelId)) appeared.push(modelId);
  }

  const section = (title: string, lines: string[], verdict: "must-be-empty" | "review"): void => {
    const mark = lines.length === 0 ? "none" : `${lines.length}`;
    console.log(`\n## ${title} — ${mark}${verdict === "must-be-empty" && lines.length > 0 ? "  <-- MUST be named by the design" : ""}`);
    for (const line of lines.slice(0, 40)) console.log(`  ${line}`);
    if (lines.length > 40) console.log(`  … ${lines.length - 40} more`);
  };

  console.log(
    `Route table: ${before.rows.length} models before, ${after.rows.length} after, generation ${after.catalogGenerationId}.`,
  );
  section("Routes LOST", lost, "must-be-empty");
  section("Became no-route", becameNoRoute, "must-be-empty");
  section("Models disappeared from the table", disappeared, "must-be-empty");
  section("Routes GAINED", gained, "review");
  section("Became routed", becameRouted, "review");
  section("Order changed, same providers", reordered, "review");
  section("Models appeared in the table", appeared, "review");

  const blocking = lost.length + becameNoRoute.length + disappeared.length;
  console.log(
    `\nVerdict: ${blocking === 0 ? "no route was removed" : `${blocking} removals to justify or fix`}.`,
  );
  process.exit(blocking === 0 ? 0 : 1);
}

const [command, a, b] = process.argv.slice(2);
if (command === "capture" && a) {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  await capture(a, limitArg ? Number(limitArg.split("=")[1]) : undefined);
} else if (command === "diff" && a && b) {
  diff(a, b);
} else {
  console.error(
    "usage:\n" +
      "  bun run scripts/route-table-snapshot.ts capture <out.json> [--limit=N]\n" +
      "  bun run scripts/route-table-snapshot.ts diff <before.json> <after.json>",
  );
  process.exit(2);
}
