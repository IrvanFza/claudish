#!/usr/bin/env node

// Launcher script: checks for Bun runtime before starting claudish.
// Claudish uses Bun-specific APIs (bun:ffi for TUI, Bun.spawn, etc.)
// so it cannot run under Node.js directly.
//
// ── Why this is spawn() and not spawnSync() ──────────────────────────────────
//
// This process is a THIN WRAPPER around the real CLI, and it is the process
// every caller's signal actually lands on. It used to run the child with
// `spawnSync(bun, ..., { stdio: "inherit" })`, which made the whole tree
// unkillable in a way that looked like the child was ignoring signals:
//
//   · `spawnSync` blocks the event loop, so this process cannot forward
//     anything while the child runs.
//   · `stdio: "inherit"` gives the Bun child THIS process's fd 0/1/2. When a
//     caller pipes our stdout, the Bun child holds the write end of that pipe.
//   · So SIGTERM killed only this launcher. The Bun child was ORPHANED, not
//     killed — it kept running, kept billing, and kept the caller's pipe open,
//     writing into it long after the caller had given up.
//
// Measured 2026-08-15 with a repro of this exact topology: SIGTERM to the
// launcher pid leaked 330 B of post-kill output, and so did SIGKILL — because
// the problem is signalling the wrong process, not a stubborn one. It cost a
// real `team` run: a model declared TIMEOUT with 0 B wrote a complete 40,699 B
// answer into the response file 375 s later, and was scored as empty.
//
// Now: async spawn, forward the signals a supervisor actually sends, and exit
// with the child's own status. A caller that terminates `claudish` terminates
// claudish.
//
// This does NOT cover being SIGKILLed ourselves — nothing running in this
// process can. Callers that need a hard guarantee should spawn claudish
// `detached` and signal the process GROUP, which reaches the Bun child (and its
// own descendants) directly; `team-orchestrator.ts` does exactly that.

const { execFileSync, execSync, spawn } = require("node:child_process");
const { resolve } = require("node:path");

function findBun() {
  try {
    const path = execSync("which bun", { encoding: "utf-8" }).trim();
    if (path) return path;
  } catch {}
  // Common install locations
  const candidates = [
    `${process.env.HOME}/.bun/bin/bun`,
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

const bun = findBun();
if (!bun) {
  console.error(`claudish requires the Bun runtime but it was not found.

Install Bun (one command):
  curl -fsSL https://bun.sh/install | bash

Then retry:
  claudish --version

Learn more: https://bun.sh`);
  process.exit(1);
}

const entry = resolve(__dirname, "..", "dist", "index.js");

let child;
try {
  child = spawn(bun, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  console.error("Failed to start claudish:", err.message);
  process.exit(1);
}

// Forward the signals a supervisor, terminal, or parent process actually sends.
// SIGKILL is deliberately absent — it cannot be caught, which is the whole
// reason callers wanting a hard kill must target the process group instead.
//
// Handlers are installed only AFTER a successful spawn, so a signal arriving
// during startup keeps Node's default terminate-immediately behaviour rather
// than being swallowed by a forward to a child that does not exist yet.
const FORWARDED =
  process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of FORWARDED) {
  process.on(signal, () => {
    // Best-effort: the child may have exited between the signal and this line.
    try {
      if (!child.killed) child.kill(signal);
    } catch {}
    // Do NOT exit here. Waiting for the child's own "exit" keeps our status
    // honest and, more importantly, keeps this process alive as long as the
    // child is — a caller watching OUR pid must not see us disappear while the
    // real work is still running.
  });
}

child.on("error", (err) => {
  console.error("Failed to start claudish:", err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise the signal on ourselves so our parent observes the same cause of
    // death the child had, rather than a synthesised exit code. The handler is
    // removed first, or we would forward it straight back to a dead child.
    process.removeAllListeners(signal);
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      // Re-raise failed (unsupported signal on this platform) — fall back to
      // the shell convention for "died from signal N".
      const NUMBERS = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 };
      process.exit(128 + (NUMBERS[signal] ?? 0));
    }
  }
  process.exit(code ?? 1);
});
