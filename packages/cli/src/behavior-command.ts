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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BUILTIN_RULES,
  buildCorpus,
  outboxPath,
  parseBehaviorConfig,
  resolveSeverity,
} from "./behavior/index.js";
import { getConfigPath, loadConfig } from "./profile-config.js";
import { cliAnsi } from "./theme/ansi.js";

// Theme-aware color helpers. cliAnsi() is resolved inside each helper (i.e. at
// render time), never at module load — theme detection runs at CLI startup,
// after this module is imported.
const green = (s: string) => {
  const a = cliAnsi();
  return `${a.GREEN}${s}${a.RESET}`;
};
const yellow = (s: string) => {
  const a = cliAnsi();
  return `${a.YELLOW}${s}${a.RESET}`;
};
const dim = (s: string) => {
  const a = cliAnsi();
  return `${a.DIM}${s}${a.RESET}`;
};
const bold = (s: string) => {
  const a = cliAnsi();
  return `${a.BOLD}${s}${a.RESET}`;
};

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

/**
 * Flip `behavior.telemetry.enabled` in the global config, preserving every other
 * key byte-for-byte.
 *
 * Reads and writes the file directly rather than going through
 * `saveConfig(loadConfig())`: `loadConfig` merges through an ALLOW-LIST, so any
 * key it does not enumerate — a hand-added setting, a field from a newer
 * claudish — would be dropped on save. Toggling one boolean must not be able to
 * damage the rest of a user's config.
 */
function setTelemetryEnabled(value: boolean): void {
  const path = getConfigPath();
  let cfg: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Garbled file → start from empty rather than crash. Matches readRawConfig.
  }

  const behavior =
    cfg.behavior && typeof cfg.behavior === "object" && !Array.isArray(cfg.behavior)
      ? { ...(cfg.behavior as Record<string, unknown>) }
      : {};
  behavior.telemetry = { enabled: value };
  cfg.behavior = behavior;

  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

/**
 * Show — and change — the behaviour-telemetry opt-in.
 *
 * A consent flag reachable only by hand-editing config is not a consent flag, so
 * this is the surface that makes it one. It states the retention period and the
 * never-send list up front, because consent to something unstated is not consent.
 */
function showTelemetry(action: "status" | "enable" | "disable", json: boolean): void {
  if (action !== "status") {
    // RAW read-modify-write, deliberately NOT saveConfig(loadConfig()).
    // `loadConfig` is an allow-list that copies known keys and silently drops
    // everything else, so saving what it returns would delete any key it does
    // not know about. Same reasoning as onepassword-config.ts's mutateConfig.
    setTelemetryEnabled(action === "enable");
  }

  const config = parseBehaviorConfig(loadConfig().behavior);
  const on = config.telemetry?.enabled === true;

  // Reported so "I turned it on and nothing happened" has an answer. Reports are
  // spooled at exit and delivered by a LATER run, so a non-zero count here is
  // normal rather than a symptom.
  let pending = 0;
  try {
    const path = outboxPath();
    if (existsSync(path)) {
      pending = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    }
  } catch {
    // Unreadable outbox is not worth failing a status command over.
  }

  if (json) {
    console.log(JSON.stringify({ enabled: on, pendingReports: pending }, null, 2));
    return;
  }

  console.log(bold("\nBehavior telemetry\n"));
  console.log(`  status  : ${on ? green("enabled") : dim("disabled")}`);
  console.log(`  pending : ${pending} session report(s) awaiting delivery\n`);

  if (!on) {
    console.log("  Opting in shares which models violate Claude Code conventions,");
    console.log("  so rules can be written for models we cannot test ourselves.\n");
    console.log(dim("  Sent    : model, provider, rule id, tool name, decision counts,"));
    console.log(dim("            a coarse context bucket, and categorical path relations"));
    console.log(dim("  Never   : file paths, argument values, prompts, code, model output,"));
    console.log(dim("            credentials, or repo/branch/project names"));
    console.log(dim("  Session : identified by a salted hash, unlinkable across sessions"));
    console.log(dim("  Kept    : 12 months, then non-identifying weekly aggregates only\n"));
    console.log(`  Enable with ${bold("claudish behavior telemetry --enable")}\n`);
    return;
  }

  console.log(dim("  Local journalling is always on and unaffected by this setting.\n"));
  console.log(`  Disable with ${bold("claudish behavior telemetry --disable")}\n`);
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
    case "telemetry":
      showTelemetry(
        argv.includes("--enable") ? "enable" : argv.includes("--disable") ? "disable" : "status",
        json
      );
      return;
    default:
      console.error(`Unknown action "${action}".

Usage:
  claudish behavior rules     [--json]
  claudish behavior corpus    [--write] [--json]
  claudish behavior telemetry [--enable | --disable] [--json]
`);
      process.exit(1);
  }
}
