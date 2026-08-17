/**
 * Drive the team orchestrator directly, bypassing the MCP server.
 *
 * Exists because `claudish team` is orphaned (`teamCommand` is exported from
 * team-cli.ts but imported nowhere), so the only production entry point is the
 * MCP tool — and that path was blocked on a 1Password DesktopAuth dialog.
 * Children still spawn the globally-installed claudish 7.48.0 from PATH, which
 * is the build the bug was reported against.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runModels, setupSession } from "../../../../packages/cli/src/team-orchestrator.js";

const sessionPath = import.meta.dir;
const models = (process.argv[2] ?? "glm-5.2,kimi-k3").split(",");

// setupSession refuses to overwrite an existing manifest. The blocked MCP run
// already wrote one for these same two models, so reuse it rather than forcing
// a fresh directory — the input.md and slot ids stay identical either way.
if (!existsSync(join(sessionPath, "manifest.json"))) {
  setupSession(sessionPath, models);
}

console.log(`session : ${sessionPath}`);
console.log(`models  : ${models.join(", ")}`);
console.log(`op      : ${process.env.CLAUDISH_DISABLE_OP === "1" ? "DISABLED" : "enabled"}`);
console.log("");

const status = await runModels(sessionPath, {
  timeout: 600,
  onStatusChange: (id, s) => {
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${id} -> ${s.state}` +
        ` (exit=${s.exitCode}, ${s.outputSize} B)` +
        (s.error ? ` reason=${s.error.reason}` : "")
    );
  },
});

console.log("\n=== final ===");
for (const [id, m] of Object.entries(status.models).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`${id}  ${m.state.padEnd(10)} ${String(m.outputSize).padStart(7)} B`);
}
