/** @jsxImportSource @opentui/react */
/**
 * Bootstrapping helper for the probe TUI. Creates an OpenTUI renderer,
 * mounts the React tree, and exposes the external store plus a shutdown
 * function. All output goes to process.stderr so stdout stays clean for
 * --json piping.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { ProbeApp, ProbeStore, type ProbeAppState } from "./probe-tui-app.js";

export interface ProbeRuntime {
  store: ProbeStore;
  shutdown: () => Promise<void>;
}

export async function startProbeTui(
  initial: ProbeAppState,
): Promise<ProbeRuntime> {
  const renderer = await createCliRenderer({
    // Route rendering to stderr so --json piping on stdout stays clean.
    stdout: process.stderr as unknown as NodeJS.WriteStream,
    // Inline rendering — do NOT take over the full screen. This lets the
    // final probe results persist in the scrollback after shutdown.
    useAlternateScreen: false,
    useMouse: false,
    exitOnCtrlC: true,
  });

  const store = new ProbeStore(initial);
  const root: Root = createRoot(renderer);
  root.render(<ProbeApp store={store} />);

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

  return { store, shutdown };
}
