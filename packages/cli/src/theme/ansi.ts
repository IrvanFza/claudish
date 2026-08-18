/**
 * ansi.ts — theme-aware ANSI escapes for PLAIN CLI output (help, config,
 * profiles, quota, update, behavior…). The raw-ANSI counterpart of the TUI's
 * dual palette; imports only `theme-mode.ts`, never OpenTUI.
 *
 * The contract mirrors the TUI's: an UNKNOWN theme behaves exactly like
 * yesterday's claudish — the classic 16-color escapes, which every terminal
 * maps through its own palette and which read acceptably on both pages. Only a
 * POSITIVE "light" detection switches to deep truecolor accents (all >= 4.5:1
 * on a white page), because the classic codes' worst offenders (white 37,
 * bright-black 90, the bright 9x row) are exactly the ones light terminals
 * render illegibly.
 *
 * Call `cliAnsi()` INSIDE your command function, never at module load: command
 * modules are imported before theme detection runs at CLI startup, so a
 * module-level snapshot would always capture the pre-detection state.
 *
 * NO_COLOR empties every escape (https://no-color.org) — previously honored
 * only by `--help` while advertised as global; this makes the advertisement
 * true for every surface that adopts this module.
 */

import { getThemeMode } from "./theme-mode.js";

export interface CliAnsi {
  RESET: string;
  BOLD: string;
  DIM: string;
  ITALIC: string;
  GREEN: string;
  BRIGHT_GREEN: string;
  RED: string;
  YELLOW: string;
  CYAN: string;
  BLUE: string;
  MAGENTA: string;
  /** De-emphasis gray. Classic 90 on dark/unknown; a mid gray on light. */
  GRAY: string;
  /** Emphasized text — classic white (37) on dark/unknown, near-black on light.
   *  The replacement for hardcoded `\x1b[37m`, which vanishes on a light page. */
  STRONG: string;
}

/** Truecolor foreground escape for a `#rrggbb` hex. */
export function fgHex(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Truecolor background escape for a `#rrggbb` hex. */
export function bgHex(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const CLASSIC: CliAnsi = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  GREEN: "\x1b[32m",
  BRIGHT_GREEN: "\x1b[92m",
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  GRAY: "\x1b[90m",
  STRONG: "\x1b[37m",
};

/** Deep vivid accents for a light page — the same hexes the TUI's LIGHT
 *  palette uses, so CLI output and TUI screens read as one program. */
const LIGHT: CliAnsi = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  GREEN: fgHex("#15803d"),
  BRIGHT_GREEN: fgHex("#166534"),
  RED: fgHex("#dc2626"),
  YELLOW: fgHex("#a16207"),
  CYAN: fgHex("#0e7490"),
  BLUE: fgHex("#1d4ed8"),
  MAGENTA: fgHex("#9333ea"),
  GRAY: fgHex("#6b7280"),
  STRONG: fgHex("#111827"),
};

const NONE: CliAnsi = {
  RESET: "",
  BOLD: "",
  DIM: "",
  ITALIC: "",
  GREEN: "",
  BRIGHT_GREEN: "",
  RED: "",
  YELLOW: "",
  CYAN: "",
  BLUE: "",
  MAGENTA: "",
  GRAY: "",
  STRONG: "",
};

/** The escape set for the CURRENT detected theme. Resolve at call time. */
export function cliAnsi(): CliAnsi {
  if (process.env.NO_COLOR) return NONE;
  return getThemeMode() === "light" ? LIGHT : CLASSIC;
}
