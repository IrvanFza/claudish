/** @jsxImportSource @opentui/react */
import { spawnSync } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.js";

/**
 * Start the config TUI. Re-entrant: if App requests an OAuth login,
 * we tear down the renderer, spawn `claudish login {slug}` as a CHILD
 * process (clean stdio so the OAuth callback server doesn't fight with
 * OpenTUI's lifecycle), wait for it to exit, then start a fresh TUI.
 *
 * Child-process isolation avoids the ERR_CONNECTION_REFUSED issue that
 * the previous in-process attempt hit — the child gets a clean Node
 * runtime with no OpenTUI residue, and the parent doesn't need to
 * restart anything until the child cleanly exits.
 *
 * Cursor/tab state is NOT preserved across the boundary. After login,
 * the user lands back on the default tab. Acceptable because login is
 * rare and the state machine is small.
 */
export async function startConfigTui(): Promise<void> {
  const loginRequest: { slug: "gemini" | "codex" | "kimi" | null } = { slug: null };

  const requestLogin = (slug: "gemini" | "codex" | "kimi"): void => {
    loginRequest.slug = slug;
  };

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // Core shortcut handler
  });

  // When the renderer destroys (either via q/Ctrl-C or App calling
  // renderer.destroy() after setting loginRequest), control returns
  // here. If a login was requested, run it as a child process then
  // restart the TUI.
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve());
    createRoot(renderer).render(<App requestLogin={requestLogin} />);
  });

  if (loginRequest.slug !== null) {
    const slug = loginRequest.slug;
    console.log(`\nLaunching: claudish login ${slug}\n`);
    // Spawn the same runtime + script with `login {slug}`. stdio: "inherit"
    // gives the child our terminal so inquirer prompts and the OAuth
    // callback server work normally.
    const result = spawnSync(process.argv[0], [process.argv[1], "login", slug], {
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`\n❌ Failed to spawn login: ${result.error.message}\n`);
    } else if (result.status !== 0) {
      console.error(`\n❌ Login exited with status ${result.status}\n`);
    }
    // Re-enter the TUI regardless of login outcome — failed login should
    // still let the user retry or set an API key instead.
    console.log("\nReturning to config…\n");
    await startConfigTui();
  }
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  startConfigTui().catch((err) => {
    console.error("TUI error:", err);
    process.exit(1);
  });
}
