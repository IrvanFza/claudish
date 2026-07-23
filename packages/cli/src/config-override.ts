/**
 * Process-wide config-file override — the single authority behind
 * `--config <file>` / `CLAUDISH_CONFIG`.
 *
 * When set, `<file>` TOTALLY replaces BOTH the machine global
 * (`~/.claudish/config.json`) and the project (`./.claudish.json`) config for
 * the whole run, in EVERY config reader:
 *   - profile-config's `loadConfig()` (global) + `loadLocalConfig()` (→ null).
 *   - op-source's `hasOpSources()` sniff + `readConfigRaw()`.
 *   - onepassword-config's `readAllOnepasswordEnvironments` /
 *     `listOnepasswordImports` / `readOnepasswordAccount`, via the
 *     override-aware `defaultOpConfigPaths`.
 *
 * WHY THIS IS FUNDAMENTAL — NOT A "disable 1Password" HACK. The override does
 * not SUPPRESS 1Password; it makes the override file the ONLY config. A test/QA
 * file that names no `op://` source means `hasOpSources()` returns false on its
 * own, so the lazy 1Password gate never opens and the SDK is never touched — no
 * auth prompt. Conversely, if a user DID put an `op://` ref in the override
 * file, it would resolve normally (on demand), because the mechanism is faithful
 * substitution, not selective disabling. This is the same on-demand model that
 * already lets `--version`/`help`/`update` run without a 1Password prompt.
 *
 * Zero-dependency ON PURPOSE: profile-config, op-source, onepassword-config, and
 * index all import this without any risk of an import cycle — it depends on
 * nothing but its own module-level state.
 */

/**
 * A global/project config-path pair. Structurally identical to
 * onepassword-config's `OpConfigPaths` (kept local here so this module stays
 * dependency-free); the two are mutually assignable.
 */
export interface ConfigPathPair {
  global: () => string;
  project: () => string;
}

/**
 * The project path used when an override is active: a path that never exists,
 * so `existsSync()` is false (no project overlay under an override) and any
 * accidental write fails loudly instead of landing in a junk file. Empty string
 * is portable — Node/Bun `existsSync("")` is false on every platform, and
 * `writeFileSync("")` throws ENOENT.
 */
const SUPPRESSED_PROJECT_CONFIG = "";

let overridePath: string | null = null;

/** Set (absolute path) or clear (null) the per-run config-file override. */
export function setConfigFileOverride(path: string | null): void {
  overridePath = path;
}

/** The raw override path, or null when no `--config`/`CLAUDISH_CONFIG` is active. */
export function getConfigFileOverride(): string | null {
  return overridePath;
}

/** The global config file to read: the override when set, else `realGlobal`. */
export function activeGlobalConfigFile(realGlobal: string): string {
  return overridePath ?? realGlobal;
}

/**
 * Wrap a real global/project path pair so both scopes honor an active override:
 * global → the override file; project → suppressed (no overlay). With no
 * override active, `defaults` is returned unchanged, so behavior is byte-for-
 * byte identical to before for every normal run.
 */
export function activeOpConfigPaths(defaults: ConfigPathPair): ConfigPathPair {
  if (overridePath === null) return defaults;
  const file = overridePath;
  return {
    global: () => file,
    project: () => SUPPRESSED_PROJECT_CONFIG,
  };
}
