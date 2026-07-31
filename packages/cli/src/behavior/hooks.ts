/**
 * User hook loading for the behavior layer.
 *
 * A hook is a plain module that exports one or more BehaviorRule objects. It
 * gets the same engine, the same action vocabulary, and the same per-rule
 * try/catch isolation as a built-in rule — the only difference is where it came
 * from and that its id is namespaced.
 *
 * Everything here is non-fatal by design. A hook that fails to import, exports
 * the wrong shape, or throws on load produces a warning and is skipped. This
 * matches the established posture for op:// sources and startup glob failures:
 * a broken optional extension must never stop claudish from starting, least of
 * all when the user is trying to start it in order to fix that extension.
 */

import { isAbsolute, resolve } from "node:path";
import { logStderr } from "../logger.js";
import type { BehaviorRule } from "./types.js";

/** Structural check — a hook module is untrusted input, not a typed import. */
function isBehaviorRule(value: any): value is BehaviorRule {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.appliesTo === "function" &&
    (value.onRequest === undefined || typeof value.onRequest === "function") &&
    (value.onToolCall === undefined || typeof value.onToolCall === "function")
  );
}

/** Accept `default`, `rules`, or any named export that structurally matches. */
function collectRules(mod: any): BehaviorRule[] {
  const found: BehaviorRule[] = [];
  const consider = (v: any) => {
    if (Array.isArray(v)) v.forEach(consider);
    else if (isBehaviorRule(v)) found.push(v);
  };
  consider(mod?.default);
  consider(mod?.rules);
  for (const [key, value] of Object.entries(mod ?? {})) {
    if (key === "default" || key === "rules") continue;
    consider(value);
  }
  // Same rule object can be reachable via two exports; keep one of each.
  return [...new Set(found)];
}

function shortName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[cm]?[jt]s$/, "");
}

/**
 * Load rules from the configured hook paths.
 *
 * @param paths  Hook module paths. Relative paths resolve against `cwd`.
 * @param cwd    Base for relative resolution (the project directory).
 */
export async function loadHookRules(
  paths: string[] | undefined,
  cwd: string = process.cwd()
): Promise<BehaviorRule[]> {
  if (!paths?.length) return [];

  const loaded: BehaviorRule[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const rules = await importHook(abs, raw);
    for (const rule of rules) namespaceInto(rule, abs, seen, loaded);
  }

  if (loaded.length > 0) {
    logStderr(
      `[behavior] Loaded ${loaded.length} hook rule(s): ${loaded.map((r) => r.id).join(", ")}`
    );
  }
  return loaded;
}

/** Import one hook module. Any failure warns and yields no rules. */
async function importHook(abs: string, raw: string): Promise<BehaviorRule[]> {
  let mod: any;
  try {
    mod = await import(abs);
  } catch (err) {
    logStderr(`[behavior] Skipping hook ${raw}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  const rules = collectRules(mod);
  if (rules.length === 0) {
    logStderr(`[behavior] Hook ${raw} exported no valid BehaviorRule — skipped`);
  }
  return rules;
}

function namespaceInto(
  rule: BehaviorRule,
  abs: string,
  seen: Set<string>,
  out: BehaviorRule[]
): void {
  // Namespaced so a hook can never silently shadow a built-in rule id, and so
  // `behavior.rules` config can target hook rules unambiguously.
  const namespaced = `hook:${shortName(abs)}/${rule.id}`;
  if (seen.has(namespaced)) {
    logStderr(`[behavior] Duplicate hook rule ${namespaced} — keeping the first`);
    return;
  }
  seen.add(namespaced);
  out.push({
    ...rule,
    id: namespaced,
    // A hook author who omits severity gets "warn": user code that silently
    // rewrites tool calls on first install is a bad default. Opt in via config.
    defaultSeverity: rule.defaultSeverity ?? "warn",
  });
}
