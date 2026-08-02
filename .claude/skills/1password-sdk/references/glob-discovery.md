# Discovering item fields (glob / bulk import) with `@1password/sdk` (JS/TS)

The pattern: pull MANY fields from a single 1Password item — typically an item
whose fields are each named after the env var they should become
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). The SDK has no `op://vault/item/*`
wildcard, so you discover the fields, filter them, and resolve the survivors.

Assumes an initialized `client` (see SKILL.md → Authenticate).

## Why three calls

`client.items.get()` takes **vault ID + item ID**, not the human names a user
types. So to go from "vault Jack / item API keys" → the field list:

```ts
// 1. vault NAME → vault ID  (list all, match by title)
const vaults = await client.vaults.list();
const vault = [...vaults].find(v => v.title === "Jack");
if (!vault) throw new Error("vault 'Jack' not found");

// 2. item NAME → item ID    (list vault's items, match by title)
const items = await client.items.list(vault.id);
const item = items.find(i => i.title === "AI LLM keys");
if (!item) throw new Error("item not found");

// 3. fetch the full item → fields + sections
const full = await client.items.get(vault.id, item.id);
```

> `vaults.list()` may return an async iterator — spread it (`[...vaults]`) or
> `for await` it. `items.list(vaultId)` returns an array of overviews
> (`{ id, title, category, state, vaultId }`) and only **active** items by default.

## The field + section shapes

```ts
interface Item {
  id: string;
  title: string;
  vaultId: string;
  fields: ItemField[];
  sections: ItemSection[];   // [{ id, title }]
}
interface ItemField {
  id: string;
  title: string;            // the field LABEL → use as the env var name
  sectionId?: string;       // ID only; join to Item.sections[].title for the label
  fieldType: ItemFieldType; // "Concealed" | "Text" | ...
  value: string;            // ALWAYS the decrypted value (see note below)
}
interface ItemSection { id: string; title: string; }
```

## Build the env-var map (glob + section + name handling)

```ts
function sectionLabel(item: Item, sectionId?: string): string | null {
  if (!sectionId) return null; // top-level (sectionless) field
  return item.sections.find(s => s.id === sectionId)?.title ?? null;
}

// glob → regexp: only `*` is special (any chars), anchor the whole segment.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, m => m === "*" ? ".*" : "\\" + m);
  return new RegExp(`^${escaped}$`);
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function collectFields(
  item: Item,
  sectionGlob: string | null,   // null = top-level fields only
  fieldGlob: string,            // e.g. "*_API_KEY"
): Record<string, string> {
  const fieldRe = globToRegExp(fieldGlob);
  const sectionRe = sectionGlob === null ? null : globToRegExp(sectionGlob);
  const out: Record<string, string> = {};

  for (const f of item.fields) {
    const section = sectionLabel(item, f.sectionId);
    // scope: null sectionGlob → only sectionless fields; else section must match
    if (sectionGlob === null ? section !== null : !(section && sectionRe!.test(section))) continue;

    const name = f.title.trim();           // trim — labels sometimes have stray spaces
    if (!fieldRe.test(name)) continue;
    if (!ENV_NAME.test(name)) {             // skip labels that aren't valid env names
      console.warn(`skipped field '${f.title}' (not a valid env var name)`);
      continue;
    }
    out[name] = f.value;                    // value already present from items.get
  }
  return out;
}
```

`collectFields(full, "*", "*_API_KEY")` → every `*_API_KEY` field across all
sections, keyed by field label. `collectFields(full, null, "*")` → all top-level
fields. `collectFields(full, "Moonshot Kimi", "*")` → that section's fields.

## Building `op://` references instead

If you'd rather resolve via `secrets.resolveAll` (e.g. to reuse the resolution
path) instead of reading `f.value` directly, construct references from the names:

```ts
const section = sectionLabel(full, f.sectionId);
const ref = section
  ? `op://${vault.title}/${full.title}/${section}/${f.title}`
  : `op://${vault.title}/${full.title}/${f.title}`;
```

## Important: discovery decrypts all values

`items.get()` returns `value` for **every** field — there is no metadata-only /
names-without-values mode (`items.list()` overviews carry no fields). This is the
**same** as the `op` CLI's `op item get --format json`, which also returns all
values. Both decrypt in memory; neither writes to disk. So reading values during
discovery is not a regression — just don't persist fields you filtered out.
