import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupSession,
  runModels,
  judgeResponses,
  getStatus,
  validateSessionPath,
  type TeamStatus,
} from "./team-orchestrator.js";

// ─── Arg Parsing Helpers ─────────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function printStatus(status: TeamStatus): void {
  const modelIds = Object.keys(status.models).sort();
  console.log(`\nTeam Status (started: ${status.startedAt})`);
  console.log("─".repeat(60));
  for (const id of modelIds) {
    const m = status.models[id];
    const duration =
      m.startedAt && m.completedAt
        ? `${Math.round((new Date(m.completedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)}s`
        : m.startedAt
          ? "running"
          : "pending";
    const size = m.outputSize > 0 ? ` (${m.outputSize} bytes)` : "";
    console.log(`  ${id}  ${m.state.padEnd(10)}  ${duration}${size}`);
  }
  console.log("");
}

function printHelp(): void {
  console.log(`
Usage: claudish team <subcommand> [options]

Subcommands:
  run             Run multiple models on a task in parallel
  judge           Blind-judge existing model outputs
  run-and-judge   Run models then judge their outputs
  status          Show current session status

Options (run / run-and-judge):
  --path <dir>        Session directory (default: .)
  --models <a,b,...>  Comma-separated model IDs to run
  --input <text>      Task prompt (or create input.md in --path beforehand)
  --timeout <secs>    Timeout per model in seconds (default: 300)
  --grid              Show all models in an mtm grid with live output + status bar

Options (judge / run-and-judge):
  --judges <a,b,...>  Comma-separated judge model IDs (default: same as runners)

Options (status):
  --path <dir>        Session directory (default: .)

Examples:
  claudish team run --path ./review --models minimax-m2.5,kimi-k2.5 --input "Review this code"
  claudish team run --grid --models kimi-k2.5,gpt-5.4,gemini-3.1-pro --input "Solve this"
  claudish team judge --path ./review
  claudish team run-and-judge --path ./review --models gpt-5.4,gemini-3.1-pro-preview --input "Evaluate this design"
  claudish team status --path ./review
`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export async function teamCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printHelp();
    process.exit(0);
  }

  const rawSessionPath = getFlag(args, "--path") ?? ".";
  let sessionPath: string;
  try {
    sessionPath = validateSessionPath(rawSessionPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const modelsRaw = getFlag(args, "--models");
  const judgesRaw = getFlag(args, "--judges");
  const input = getFlag(args, "--input");
  const timeoutStr = getFlag(args, "--timeout");
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 300;

  const models = modelsRaw
    ? modelsRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : [];
  const judges = judgesRaw
    ? judgesRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : undefined;

  switch (subcommand) {
    case "run": {
      if (models.length === 0) {
        console.error("Error: --models is required for 'run'");
        process.exit(1);
      }
      if (hasFlag(args, "--grid")) {
        const { runWithGrid } = await import("./team-grid.js");
        const gridStatus = await runWithGrid(sessionPath, models, input ?? "", { timeout });
        printStatus(gridStatus);
      } else {
        setupSession(sessionPath, models, input);
        const runStatus = await runModels(sessionPath, {
          timeout,
          onStatusChange: (id, s) => {
            process.stderr.write(`[team] ${id}: ${s.state}\n`);
          },
        });
        printStatus(runStatus);
      }
      break;
    }

    case "judge": {
      const verdict = await judgeResponses(sessionPath, { judges });
      console.log(readFileSync(join(sessionPath, "verdict.md"), "utf-8"));
      break;
    }

    case "run-and-judge": {
      if (models.length === 0) {
        console.error("Error: --models is required for 'run-and-judge'");
        process.exit(1);
      }
      setupSession(sessionPath, models, input);
      const status = await runModels(sessionPath, {
        timeout,
        onStatusChange: (id, s) => {
          process.stderr.write(`[team] ${id}: ${s.state}\n`);
        },
      });
      printStatus(status);
      await judgeResponses(sessionPath, { judges });
      console.log(readFileSync(join(sessionPath, "verdict.md"), "utf-8"));
      break;
    }

    case "status": {
      const status = getStatus(sessionPath);
      printStatus(status);
      break;
    }

    default: {
      console.error(`Unknown team subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
    }
  }
}
