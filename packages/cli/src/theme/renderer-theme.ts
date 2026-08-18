/**
 * renderer-theme.ts — theme detection for the OpenTUI surfaces.
 *
 * The three renderer boots (config TUI, probe TUI, resume picker) each call
 * this right after `createCliRenderer` and BEFORE first render. OpenTUI runs
 * its own OSC 10/11 handshake with the terminal; `waitForThemeMode` is the
 * bounded wait on that answer — a terminal that never replies must not delay
 * first paint, and `null` resolves to the dark palette (the status quo), never
 * a guess.
 *
 * Structurally typed (no @opentui/core import) so `theme-mode.ts` stays the
 * only theme module plain CLI code touches; this file is imported exclusively
 * by files that already import OpenTUI.
 */

import { getThemeMode, setThemeMode, themeModeOverride } from "./theme-mode.js";

interface ThemeModeRenderer {
  waitForThemeMode(timeoutMs?: number): Promise<"dark" | "light" | null>;
}

/** Bounded wait — chosen to match claudeup's measured-safe 250ms. */
const THEME_MODE_WAIT_MS = 250;

export async function applyRendererThemeMode(renderer: ThemeModeRenderer): Promise<void> {
  // Explicit override wins and skips the handshake wait entirely.
  const override = themeModeOverride();
  if (override) {
    setThemeMode(override);
    return;
  }
  const mode = await renderer.waitForThemeMode(THEME_MODE_WAIT_MS).catch(() => null);
  // A silent terminal must not ERASE an answer a cheaper source (COLORFGBG,
  // an earlier CLI-side OSC query) already provided.
  setThemeMode(mode ?? getThemeMode());
}
