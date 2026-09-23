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
 * `diff --strict` is the gate for a change meant to move NOTHING, such as a refactor.
 * The plain diff fails only on removals: a gained hop, a new order and a different
 * catalog generation are printed for review, and a no-route row whose reason changed is
 * not compared at all. Under `--strict` any difference fails the run, including those,
 * a kind change, a changed header field and a column a later capture adds. A generation
 * mismatch is an error there, not a warning, because a diff across two generations
 * cannot tell the code change from the catalog change.
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
        "Refresh it first — an empty catalog captures an empty table, which would make any diff look clean."
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
      })
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
    `Wrote ${outPath}: ${rows.length} models, ${routed} routed, ${rows.length - routed} with no route, generation ${snapshot.catalogGenerationId}.`
  );
}

function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf-8")) as Snapshot;
}

/** Every difference between two tables, one list per class. */
interface TableDiff {
  /** A provider that used to serve this model no longer appears. */
  lost: string[];
  /** A new provider appears. */
  gained: string[];
  /** Same providers, different order. */
  reordered: string[];
  becameNoRoute: string[];
  becameRouted: string[];
  /** The model is absent from the after snapshot. */
  disappeared: string[];
  appeared: string[];
  /** Still no-route, but it tells the user something different. Read by `--strict` only. */
  noRouteTextChanged: string[];
  /** Any other column, including one a later capture adds. Read by `--strict` only. */
  otherFieldChanged: string[];
}

/** Header keys that describe the capture run, not the table. `rows` is compared row by row. */
const HEADER_KEYS_NOT_COMPARED = new Set(["capturedAt", "rows"]);

/**
 * What a no-route row tells the user. `capture` records only `reason` today; `hint` is
 * compared whenever a snapshot carries it.
 */
const NO_ROUTE_TEXT_KEYS = new Set(["reason", "hint"]);

/** Two JSON values compared by content. `undefined` stands for a key the file does not carry. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function showValue(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/** Each key either object carries, `include` permitting, whose value differs: `key: before => after`. */
function changedFields(before: object, after: object, include: (key: string) => boolean): string[] {
  const beforeFields = Object.fromEntries(Object.entries(before));
  const afterFields = Object.fromEntries(Object.entries(after));
  const keys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  return [...keys]
    .filter((key) => include(key) && !sameValue(beforeFields[key], afterFields[key]))
    .map((key) => `${key}: ${showValue(beforeFields[key])} => ${showValue(afterFields[key])}`);
}

function compareChains(
  modelId: string,
  beforeChain: string[],
  afterChain: string[],
  result: TableDiff
): void {
  const beforeSet = new Set(beforeChain);
  const afterSet = new Set(afterChain);
  const missing = beforeChain.filter((hop) => !afterSet.has(hop));
  const extra = afterChain.filter((hop) => !beforeSet.has(hop));
  if (missing.length > 0) {
    result.lost.push(`${modelId}: lost ${missing.join(", ")}  (was ${beforeChain.join(" -> ")})`);
  }
  if (extra.length > 0) {
    result.gained.push(`${modelId}: gained ${extra.join(", ")}`);
  }
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    beforeChain.join("|") !== afterChain.join("|")
  ) {
    result.reordered.push(
      `${modelId}: ${beforeChain.join(" -> ")}  =>  ${afterChain.join(" -> ")}`
    );
  }
}

/** Records the kind, chain and no-route text classes; returns the row keys they account for. */
function classifyRow(
  modelId: string,
  beforeRow: RouteRow,
  afterRow: RouteRow,
  result: TableDiff
): Set<string> {
  // A kind flip changes the chain, reason and hint by definition; its class line says so.
  const flipKeys = ["modelId", "kind", "chain", ...NO_ROUTE_TEXT_KEYS];
  if (beforeRow.kind === "ok" && afterRow.kind === "no-route") {
    result.becameNoRoute.push(
      `${modelId}: had ${beforeRow.chain.join(" -> ")}; now ${afterRow.reason ?? "no reason"}`
    );
    return new Set(flipKeys);
  }
  if (beforeRow.kind === "no-route" && afterRow.kind === "ok") {
    result.becameRouted.push(`${modelId}: now ${afterRow.chain.join(" -> ")}`);
    return new Set(flipKeys);
  }
  compareChains(modelId, beforeRow.chain, afterRow.chain, result);
  if (beforeRow.kind !== "no-route" || afterRow.kind !== "no-route") {
    // `kind` stays unclassified, so a kind other than `ok`/`no-route` still shows as a change.
    return new Set(["modelId", "chain"]);
  }
  const text = changedFields(beforeRow, afterRow, (key) => NO_ROUTE_TEXT_KEYS.has(key));
  result.noRouteTextChanged.push(...text.map((field) => `${modelId}: ${field}`));
  return new Set(["modelId", "chain", ...NO_ROUTE_TEXT_KEYS]);
}

function compareRow(
  modelId: string,
  beforeRow: RouteRow,
  afterRow: RouteRow,
  result: TableDiff
): void {
  const classified = classifyRow(modelId, beforeRow, afterRow, result);
  // Every key no class accounts for, so a column a later capture adds is compared too.
  const other = changedFields(beforeRow, afterRow, (key) => !classified.has(key));
  result.otherFieldChanged.push(...other.map((field) => `${modelId}: ${field}`));
}

function compareTables(before: Snapshot, after: Snapshot): TableDiff {
  const beforeRows = new Map(before.rows.map((row) => [row.modelId, row]));
  const afterRows = new Map(after.rows.map((row) => [row.modelId, row]));
  const result: TableDiff = {
    lost: [],
    gained: [],
    reordered: [],
    becameNoRoute: [],
    becameRouted: [],
    disappeared: [],
    appeared: [],
    noRouteTextChanged: [],
    otherFieldChanged: [],
  };

  for (const [modelId, beforeRow] of beforeRows) {
    const afterRow = afterRows.get(modelId);
    if (afterRow) compareRow(modelId, beforeRow, afterRow, result);
    else result.disappeared.push(modelId);
  }
  for (const modelId of afterRows.keys()) {
    if (!beforeRows.has(modelId)) result.appeared.push(modelId);
  }
  return result;
}

/** Model ids one snapshot lists twice. The row map keeps only the last, so the rest would go unread. */
function duplicateRows(label: string, snapshot: Snapshot): string[] {
  const counts = new Map<string, number>();
  for (const row of snapshot.rows) counts.set(row.modelId, (counts.get(row.modelId) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([modelId, count]) => `${label}: ${modelId} listed ${count} times`);
}

/** Plain: a warning to read past. Strict: an error, and the header section counts it. */
function reportSetupMismatch(before: Snapshot, after: Snapshot, strict: boolean): void {
  const report = (message: string): void => {
    if (strict) console.error(`ERROR: ${message}`);
    else console.warn(`WARNING: ${message}`);
  };
  if (before.catalogGenerationId !== after.catalogGenerationId) {
    report(
      `different catalog generations (${before.catalogGenerationId} vs ${after.catalogGenerationId}).\n` +
        "Differences below mix the code change with a catalog change and cannot be attributed to either.\n" +
        (strict ? "--strict fails on this alone: capture both snapshots on one generation.\n" : "")
    );
  }
  if (before.defaultProvider !== after.defaultProvider) {
    report(
      `defaultProvider differs (${before.defaultProvider ?? "(none)"} vs ${after.defaultProvider ?? "(none)"}). The fallback hop will differ for every model.\n`
    );
  }
}

function section(title: string, lines: string[], verdict: "must-be-empty" | "review"): void {
  const mark = lines.length === 0 ? "none" : `${lines.length}`;
  console.log(
    `\n## ${title} — ${mark}${verdict === "must-be-empty" && lines.length > 0 ? "  <-- MUST be named by the design" : ""}`
  );
  for (const line of lines.slice(0, 40)) console.log(`  ${line}`);
  if (lines.length > 40) console.log(`  … ${lines.length - 40} more`);
}

function diff(beforePath: string, afterPath: string, strict: boolean): void {
  const before = loadSnapshot(beforePath);
  const after = loadSnapshot(afterPath);
  reportSetupMismatch(before, after, strict);

  const table = compareTables(before, after);
  // Under --strict nothing is for review: the change was meant to move nothing.
  const review = strict ? "must-be-empty" : "review";
  const header = strict
    ? changedFields(before, after, (key) => !HEADER_KEYS_NOT_COMPARED.has(key))
    : [];
  const duplicates = strict
    ? [...duplicateRows("before", before), ...duplicateRows("after", after)]
    : [];

  console.log(
    `Route table: ${before.rows.length} models before, ${after.rows.length} after, generation ${after.catalogGenerationId}.`
  );
  if (strict) {
    section("Snapshot header changed", header, "must-be-empty");
    section("Model listed twice in one snapshot", duplicates, "must-be-empty");
  }
  section("Routes LOST", table.lost, "must-be-empty");
  section("Became no-route", table.becameNoRoute, "must-be-empty");
  section("Models disappeared from the table", table.disappeared, "must-be-empty");
  section("Routes GAINED", table.gained, review);
  section("Became routed", table.becameRouted, review);
  section("Order changed, same providers", table.reordered, review);
  section("Models appeared in the table", table.appeared, review);

  if (!strict) {
    const blocking = table.lost.length + table.becameNoRoute.length + table.disappeared.length;
    console.log(
      `\nVerdict: ${blocking === 0 ? "no route was removed" : `${blocking} removals to justify or fix`}.`
    );
    process.exit(blocking === 0 ? 0 : 1);
  }

  section("No-route reason or hint changed", table.noRouteTextChanged, "must-be-empty");
  section("Other row fields changed", table.otherFieldChanged, "must-be-empty");
  const differences =
    header.length +
    duplicates.length +
    Object.values(table).reduce((sum, lines) => sum + lines.length, 0);
  console.log(
    `\nVerdict (strict): ${differences === 0 ? "no difference" : `${differences} difference${differences === 1 ? "" : "s"}, each to be named by the design or fixed`}.`
  );
  process.exit(differences === 0 ? 0 : 1);
}

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const [command, a, b] = args.filter((arg) => !arg.startsWith("--"));
if (command === "capture" && a) {
  const limitArg = flags.find((arg) => arg.startsWith("--limit="));
  await capture(a, limitArg ? Number(limitArg.split("=")[1]) : undefined);
} else if (command === "diff" && a && b && flags.every((flag) => flag === "--strict")) {
  // An unknown flag is refused, not ignored: a mistyped --strict must not run the plain gate and pass.
  diff(a, b, flags.includes("--strict"));
} else {
  console.error(
    "usage:\n" +
      "  bun run scripts/route-table-snapshot.ts capture <out.json> [--limit=N]\n" +
      "  bun run scripts/route-table-snapshot.ts diff [--strict] <before.json> <after.json>"
  );
  process.exit(2);
}
