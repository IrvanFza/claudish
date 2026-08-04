/**
 * `claudish behavior` — inspect the Layer 4 behavior compatibility layer.
 *
 * Two actions, both read-only by default:
 *
 *   claudish behavior rules            what is active, and at what severity
 *   claudish behavior corpus [--write] replay recorded transcripts for divergences
 *
 * `rules` exists because the layer is otherwise invisible: a user who edits
 * `behavior.rules` in config has no way to tell whether their glob matched, or
 * whether a rule is off because it is gated to foreign models. `corpus` exists
 * because the divergence data is what any NEW rule should be written from —
 * without a way to run it, "look at the evidence first" is not actionable advice.
 */

import {
  BUILTIN_RULES,
  buildCorpus,
  parseBehaviorConfig,
  resolveSeverity,
} from "./behavior/index.js";
import { loadConfig } from "./profile-config.js";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function severityColor(sev: string): string {
  if (sev === "fix") return green(sev);
  if (sev === "warn") return yellow(sev);
  return dim(sev);
}

function showRules(json: boolean): void {
  const config = parseBehaviorConfig(loadConfig().behavior);
  const rows = BUILTIN_RULES.map((rule) => ({
    id: rule.id,
    severity: resolveSeverity(rule.id, rule.defaultSeverity, config),
    defaultSeverity: rule.defaultSeverity,
    intercepts: rule.interceptsTools ?? [],
    description: rule.description,
  }));

  if (json) {
    console.log(JSON.stringify({ rules: rows, observer: config.observer ?? null }, null, 2));
    return;
  }

  console.log(bold("\nBehavior rules\n"));
  for (const r of rows) {
    const overridden =
      r.severity !== r.defaultSeverity ? dim(` (default ${r.defaultSeverity})`) : "";
    console.log(`  ${severityColor(r.severity).padEnd(18)} ${r.id}${overridden}`);
    console.log(`  ${dim(r.description)}`);
    if (r.intercepts.length > 0) {
      console.log(`  ${dim(`repairs: ${r.intercepts.join(", ")}`)}`);
    }
    console.log();
  }

  // Rules only run for foreign models — say so, or an all-Claude user will
  // reasonably conclude the layer is broken when nothing ever fires.
  console.log(dim("  Rules are inactive for native Claude models by design.\n"));

  const obs = config.observer;
  const obsState = obs?.enabled ? (obs.mode ?? "suggest") : "off";
  console.log(`  observer: ${obsState === "off" ? dim("off") : green(obsState)}`);
  if (obs?.model) console.log(`  ${dim(`observer model: ${obs.model}`)}`);
  console.log();
}

/** Per-model breakdown — the actionable part: it says WHICH models need a rule. */
function printByModel(records: { model?: string; outcome: string }[]): void {
  const byModel = new Map<string, { ok: number; degraded: number }>();
  for (const r of records) {
    const m = r.model ?? "unknown";
    const e = byModel.get(m) ?? { ok: 0, degraded: 0 };
    if (r.outcome === "degraded") e.degraded++;
    else e.ok++;
    byModel.set(m, e);
  }
  if (byModel.size === 0) return;

  console.log(bold("  by model (degraded / ok)\n"));
  const ranked = [...byModel.entries()].sort(
    (a, b) => b[1].degraded - a[1].degraded || b[1].ok - a[1].ok
  );
  for (const [model, v] of ranked) {
    const flag = v.degraded > 0 ? yellow(String(v.degraded)) : dim(String(v.degraded));
    console.log(`    ${model.padEnd(26)} ${flag} / ${v.ok}`);
  }
  console.log();
}

function showCorpus(write: boolean, json: boolean): void {
  const result = buildCorpus({ write });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const degraded = result.records.filter((r) => r.outcome === "degraded");
  const ok = result.records.filter((r) => r.outcome === "ok");
  const catchable = degraded.filter((r) => r.observedPaths.length > 0);

  console.log(bold("\nBehavior divergence corpus\n"));
  console.log(`  transcripts scanned : ${result.scanned}`);
  console.log(`  plan-exit records   : ${result.records.length}`);
  console.log(`  ${green("plan found")}          : ${ok.length}`);
  console.log(`  ${yellow("degraded (no plan)")}  : ${degraded.length}`);
  console.log(`  of those, a rule would have fired on ${catchable.length}\n`);

  printByModel(result.records);

  if (result.outputPath) {
    console.log(dim(`  appended to ${result.outputPath}\n`));
  } else if (write) {
    console.log(dim("  nothing to write (no records found)\n"));
  } else {
    console.log(dim("  pass --write to append these records to the divergence log\n"));
  }
}

export async function behaviorCommand(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const write = argv.includes("--write");
  const action = argv.find((a) => !a.startsWith("-")) ?? "rules";

  switch (action) {
    case "rules":
      showRules(json);
      return;
    case "corpus":
      showCorpus(write, json);
      return;
    default:
      console.error(`Unknown action "${action}".

Usage:
  claudish behavior rules  [--json]
  claudish behavior corpus [--write] [--json]
`);
      process.exit(1);
  }
}
