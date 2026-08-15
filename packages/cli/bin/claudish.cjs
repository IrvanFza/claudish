#!/usr/bin/env node

// Launcher script: checks for Bun runtime before starting claudish.
// Claudish uses Bun-specific APIs (bun:ffi for TUI, Bun.spawn, etc.)
// so it cannot run under Node.js directly.

const { execFileSync, execSync } = require("node:child_process");
const { resolve } = require("node:path");

/**
 * The shell command that asks PATH where bun is.
 *
 * `which` does not exist in cmd or PowerShell — it throws "'which' is not
 * recognized...", so Windows fell straight through to a list of POSIX-only
 * paths and reported Bun missing even when it was sitting on PATH.
 */
function lookupCommand(platform) {
  return platform === "win32" ? "where bun" : "which bun";
}

/**
 * Fallback install locations, in probe order.
 *
 * HOME is usually unset on Windows, which would interpolate the literal string
 * "undefined\.bun\..." — so the home directory is resolved per-platform rather
 * than assumed to exist.
 */
function bunCandidates(platform, env) {
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "win32") {
    return [`${home}\\.bun\\bin\\bun.exe`, `${env.LOCALAPPDATA || ""}\\bun\\bun.exe`];
  }
  return [`${home}/.bun/bin/bun`, "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
}

/** The install one-liner, in the shell the user is actually standing in. */
function installHint(platform) {
  return platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
}

function findBun(platform = process.platform, env = process.env) {
  try {
    const out = execSync(lookupCommand(platform), {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `where` prints EVERY match, one per line. Take the first.
    const path = out.split(/\r?\n/)[0].trim();
    if (path) return path;
  } catch {}

  for (const c of bunCandidates(platform, env)) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

function main() {
  const bun = findBun();
  if (!bun) {
    console.error(`claudish requires the Bun runtime but it was not found.

Install Bun (one command):
  ${installHint(process.platform)}

Then retry:
  claudish --version

Learn more: https://bun.sh`);
    process.exit(1);
  }

  // Exec into bun with the real entry point
  const entry = resolve(__dirname, "..", "dist", "index.js");
  try {
    const result = require("node:child_process").spawnSync(bun, [entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    process.exit(result.status ?? 1);
  } catch (err) {
    console.error("Failed to start claudish:", err.message);
    process.exit(1);
  }
}

// Running it as a program launches. Requiring it exposes the helpers so the
// platform branches can be tested from macOS, which is how the Windows bug
// stayed alive: nothing here was reachable without actually being on Windows.
if (require.main === module) {
  main();
} else {
  module.exports = { findBun, lookupCommand, bunCandidates, installHint };
}
