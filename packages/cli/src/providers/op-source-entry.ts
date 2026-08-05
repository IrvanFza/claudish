/**
 * One 1Password source, and which account it lives in.
 *
 * Config accepts two shapes per entry, and both readers share this parser:
 *
 *   "7ywa7mohd…"                                    bare      (account undeclared)
 *   { "id": "7ywa7mohd…", "account": "a.1password.com" }      environments
 *   { "ref": "op://V/I/**", "account": "b.1password.com" }    imports
 *
 * WHY the account belongs on the ENTRY rather than in a global setting:
 *
 * A global `onepasswordAccount` cannot express "these keys live in account A,
 * those in account B", so a user with sources in two accounts could not
 * configure claudish at all. It also only ever existed as a leak from the TUI
 * add-wizard's own bootstrap — the wizard MUST resolve an account before it can
 * call `listVaults`, then discarded that choice into a global instead of
 * recording it on the entry it was creating. Writing it on the entry is strictly
 * lossless and removes the prompt.
 *
 * The alternative — inferring the account — was tried and removed. `op` has no
 * default account: `op account get` reports `system_auth_latest_signin`, the
 * account most recently AUTHENTICATED with, so the binding silently moved
 * whenever the user signed into another account for unrelated work. A credential
 * source must not drift as a side effect of something done elsewhere.
 */

/** A parsed source entry: the value plus the account it was declared against. */
export interface OpSourceEntry {
  /** The environment id, or the op:// ref / glob. */
  value: string;
  /** Declared account URL. Undefined means "fall back to the ambient rules". */
  account?: string;
}

/** Which key carries the value for this list — `id` for environments, `ref` for imports. */
export type OpEntryValueKey = "id" | "ref";

function trimmed(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse one raw config entry. Returns undefined for anything unusable, so a
 * malformed entry is SKIPPED rather than throwing — consistent with the rest of
 * the op config surface, where a broken import must never lock the user out of
 * claudish (notably out of `claudish config`, where they would go to fix it).
 */
export function parseOpSourceEntry(
  raw: unknown,
  valueKey: OpEntryValueKey
): OpSourceEntry | undefined {
  const bare = trimmed(raw);
  if (bare) return { value: bare };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const value = trimmed(obj[valueKey]);
  if (!value) return undefined;

  const account = trimmed(obj.account);
  return account ? { value, account } : { value };
}

/** Parse a whole config list, dropping unusable entries. */
export function parseOpSourceEntries(raw: unknown, valueKey: OpEntryValueKey): OpSourceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: OpSourceEntry[] = [];
  for (const item of raw) {
    const parsed = parseOpSourceEntry(item, valueKey);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Serialize back to the config shape: bare string when no account is declared,
 * object form when there is one.
 *
 * Keeping the bare form for undeclared entries matters for diffs — adding this
 * feature must not rewrite every existing user's config into a noisier shape
 * the first time something touches it.
 */
export function serializeOpSourceEntry(
  entry: OpSourceEntry,
  valueKey: OpEntryValueKey
): string | Record<string, string> {
  if (!entry.account) return entry.value;
  return { [valueKey]: entry.value, account: entry.account };
}

/** Dedupe by value, first occurrence winning (project scope is read before global). */
export function dedupeOpSourceEntries(entries: OpSourceEntry[]): OpSourceEntry[] {
  const seen = new Set<string>();
  const out: OpSourceEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.value)) continue;
    seen.add(e.value);
    out.push(e);
  }
  return out;
}

/**
 * Group entries by the account they resolve to, so each DISTINCT account is
 * handshaked once. `resolveAccount` returns undefined when the entry has no
 * declared account and the ambient rules cannot supply one either; those are
 * returned under the `undeclared` bucket for the caller to report.
 *
 * Map iteration order is insertion order, so the account of the first-listed
 * source is authorized first — deterministic, and it means the account the user
 * put at the top of their config is the first dialog they see.
 */
export function groupEntriesByAccount(
  entries: OpSourceEntry[],
  resolveAccount: (entry: OpSourceEntry) => string | undefined
): { byAccount: Map<string, OpSourceEntry[]>; undeclared: OpSourceEntry[] } {
  const byAccount = new Map<string, OpSourceEntry[]>();
  const undeclared: OpSourceEntry[] = [];
  for (const entry of entries) {
    const account = resolveAccount(entry);
    if (!account) {
      undeclared.push(entry);
      continue;
    }
    const bucket = byAccount.get(account);
    if (bucket) bucket.push(entry);
    else byAccount.set(account, [entry]);
  }
  return { byAccount, undeclared };
}
