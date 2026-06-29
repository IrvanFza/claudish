/** @jsxImportSource @opentui/react */
/**
 * Bootstrapping helper for the probe TUI. Creates an OpenTUI renderer,
 * mounts the React tree, and exposes the external store plus a shutdown
 * function. All output goes to process.stderr so stdout stays clean for
 * --json piping.
 *
 * The TUI now STAYS ALIVE after probing completes (the "done" phase): cli.ts
 * flips the store to the interactive tabbed view and awaits `waitForQuit()`,
 * which resolves when the user presses q / Esc inside the app. cli.ts then
 * prints the leaderboard to scrollback and calls `shutdown()`.
 */

import { createCliRenderer } from "@opentui/core";
import { type Root, createRoot } from "@opentui/react";
import { ProbeApp, type ProbeAppState, ProbeStore } from "./probe-tui-app.js";

export interface ProbeRuntime {
  store: ProbeStore;
  /** Resolves when the user quits the interactive "done" phase (q / Esc). */
  waitForQuit: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export async function startProbeTui(initial: ProbeAppState): Promise<ProbeRuntime> {
  const renderer = await createCliRenderer({
    // Route rendering to stderr so --json piping on stdout stays clean.
    stdout: process.stderr as unknown as NodeJS.WriteStream,
    // Inline rendering — do NOT take over the full screen. This lets the
    // final probe results persist in the scrollback after shutdown.
    useAlternateScreen: false,
    // Mouse tracking ON so the scroll wheel drives the model-list scrollbox.
    // The scrollbox (focused) consumes wheel MouseEvents via its built-in
    // onMouseEvent. Trade-off accepted: while the probe is LIVE, the wheel
    // scrolls the list instead of the terminal's native scrollback; once the
    // TUI exits and renderer.destroy() disables mouse reporting, native
    // scrollback is restored (the final static results stay in scrollback).
    useMouse: true,
    exitOnCtrlC: true,
  });

  const store = new ProbeStore(initial);

  // Quit promise — resolved by the in-app keyboard handler (q / Esc) via the
  // onQuit callback passed into ProbeApp. cli.ts awaits this before shutting
  // down + printing the leaderboard to scrollback.
  let resolveQuit!: () => void;
  const quitPromise = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });
  let quit = false;
  const onQuit = (): void => {
    if (quit) return;
    quit = true;
    resolveQuit();
  };

  const root: Root = createRoot(renderer);
  root.render(<ProbeApp store={store} onQuit={onQuit} />);

  let destroyed = false;
  const shutdown = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    try {
      renderer.destroy();
    } catch {
      /* ignore */
    }
  };

  return { store, waitForQuit: () => quitPromise, shutdown };
}
