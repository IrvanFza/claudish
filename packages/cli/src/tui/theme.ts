/** @jsxImportSource @opentui/react */
import { createTextAttributes } from "@opentui/core";

/**
 * btop-inspired color palette — true black base, vivid neon colors.
 *
 * 3 text tiers: white (primary) → gray (secondary) → dark-gray (tertiary)
 * Bluish selection highlight like btop.
 */
export const C = {
  bg: "#000000",
  bgAlt: "#111111",
  bgHighlight: "#1e3a5f",
  bgError: "#3a0a14", // faint red-tinted band for failed test rows

  fg: "#ffffff",
  fgMuted: "#a0a0a0",
  dim: "#555555",

  border: "#333333",
  focusBorder: "#57a5ff",

  green: "#39ff14",
  brightGreen: "#55ff55",
  red: "#ff003c",
  yellow: "#fce94f",
  cyan: "#00ffff",
  blue: "#0088ff",
  magenta: "#ff00ff",
  orange: "#ff8800",
  white: "#ffffff",
  black: "#000000",

  // Unified tab theme based on blue
  tabActiveBg: "#0088ff",
  tabInactiveBg: "#001a33",
  tabActiveFg: "#ffffff",
  tabInactiveFg: "#0088ff",

  // Muted pill backgrounds for AUTH column tags. The standard `green` / `cyan`
  // are neon-bright and cause eye strain when used as a solid fill. These
  // are lower-saturation forest/teal versions, contrast-tuned for white text.
  pillKeyBg: "#2d6e3e", // forest green; white text reads cleanly
  pillOauthBg: "#1f6d75", // muted teal; white text reads cleanly
} as const;

const bold = createTextAttributes({ bold: true });

export const A = {
  bold,
  boldIf: (enabled: boolean): number | undefined => (enabled ? bold : undefined),
} as const;
