/**
 * Gemini Schema Utilities
 *
 * Shared utilities for converting JSON Schema to Gemini's API format.
 * Used by both the Gemini direct-API handler and the Antigravity handler (OAuth).
 */

import { log } from "../../logger.js";

/**
 * Sanitize a function name for Gemini API compatibility.
 *
 * Gemini requires function names to:
 * - Start with a letter or underscore
 * - Only contain alphanumeric chars (a-z, A-Z, 0-9), underscores (_), dots (.), colons (:), or dashes (-)
 * - Maximum length of 64 characters
 *
 * @param name The original function name
 * @returns Sanitized name that meets Gemini requirements, or null if name is invalid/empty
 */
export function sanitizeToolNameForGemini(name: string | undefined | null): string | null {
  // Handle undefined/null/empty names
  if (!name || typeof name !== "string" || name.trim() === "") {
    log(`[GeminiSchema] Skipping tool with invalid name: ${JSON.stringify(name)}`);
    return null;
  }

  // Replace invalid characters with underscores
  // Valid: a-z, A-Z, 0-9, _, ., :, -
  let sanitized = name.replace(/[^a-zA-Z0-9_.\-:]/g, "_");

  // Ensure name starts with a letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Truncate to max 64 characters
  if (sanitized.length > 64) {
    sanitized = sanitized.substring(0, 64);
  }

  // Log if name was changed
  if (sanitized !== name) {
    log(`[GeminiSchema] Sanitized tool name: "${name}" -> "${sanitized}"`);
  }

  return sanitized;
}

/**
 * Normalize type field - Gemini requires single string type, not arrays
 * JSON Schema allows: type: ["string", "null"] but Gemini needs: type: "string"
 */
export function normalizeType(type: any): string {
  if (!type) return "string";

  // Handle array types (e.g., ["string", "null"])
  if (Array.isArray(type)) {
    // Filter out "null" and take the first non-null type
    const nonNullTypes = type.filter((t: string) => t !== "null");
    return nonNullTypes[0] || "string";
  }

  return type;
}

/**
 * The scalar branches that stand in for a position constraining nothing.
 *
 * JSON Schema writes "any value here" as `{}`. Gemini has no any-type, and
 * `normalizeType(undefined)` answers "string", so an unconstrained position was
 * DECLARED a string. Naming the scalars instead makes the declaration true.
 *
 * Measured, so the claim stays honest: Gemini does not enforce element types, and
 * a live session on the string-declaring build still returned `500` as a JSON
 * number. The cost of the narrow declaration is not rejection — it is that the
 * declaration is the thing the model reads.
 */
const ANY_VALUE_BRANCHES: any[] = [{ type: "string" }, { type: "number" }, { type: "boolean" }];

/** Structural key with sorted keys, so identical union branches collapse to one. */
function canonicalKey(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}:${canonicalKey(value[key])}`)
    .join(",")}}`;
}

function dedupeBranches(branches: any[]): any[] {
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const branch of branches) {
    const key = canonicalKey(branch);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(branch);
  }
  return unique;
}

/** A position that constrains nothing: `{}`, or description-only. */
function describesNothing(entry: any): boolean {
  return (
    entry.type === undefined &&
    entry.enum === undefined &&
    entry.properties === undefined &&
    entry.items === undefined &&
    entry.prefixItems === undefined &&
    entry.anyOf === undefined &&
    entry.oneOf === undefined
  );
}

/** Sanitize union branches, drop the unusable ones, and collapse duplicates. */
function unionBranches(entries: any[]): any[] {
  const branches: any[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (describesNothing(entry)) branches.push(...ANY_VALUE_BRANCHES);
    else branches.push(sanitizeSchemaForGemini(entry));
  }
  return dedupeBranches(branches);
}

/**
 * The element schema for a tuple.
 *
 * Gemini validates EVERY element against one `items` schema, so a tuple's
 * positional binding is inexpressible. The closest TRUE statement is the union
 * of what the positions allow: wider than the tuple, and it never rejects a
 * valid call. Collapsing to a single type instead — which claudish did until
 * this was measured — is not wider, it is FALSE: it tells the model the other
 * positions are strings when they are not.
 *
 * `anyOf` is accepted by the live backend; measured 2026-09-03, see
 * `ai-docs/reports/gemini-tool-schema-support-20260903.md`. No sibling `type` is
 * emitted next to it: the backend takes both, and a narrower sibling type risks
 * being the one it enforces.
 */
function tupleElementSchema(entries: any[]): any {
  const branches = unionBranches(entries);
  if (branches.length === 0) return { type: "string" };
  if (branches.length === 1) return branches[0];
  return { anyOf: branches };
}

/**
 * Say the arity, order and per-position values in prose, since the schema cannot.
 *
 * This is the half of a tuple Gemini cannot hold. A union permits every
 * position's schema at every position, so an operator enum stops being a
 * CONSTRAINT — measured live 2026-09-03, the model answered a `[field, op,
 * value]` tuple with `">"` and `"=="` while the enum said `gt` and `eq`, and the
 * request was valid because a free string is one of the branches.
 *
 * The description is the only place the positional facts can live. It is
 * free-form, so it guides the model without being able to reject anything.
 */
function describeTuple(entries: any[]): string {
  const shape = entries
    .map((entry) => {
      if (!entry || typeof entry !== "object" || describesNothing(entry)) return "any";

      const type = normalizeType(entry.type);
      const values = Array.isArray(entry.enum)
        ? entry.enum.filter((v: any) => typeof v === "string" || typeof v === "number")
        : [];

      if (values.length === 0) return type;
      return `${type} (one of: ${values.map((v: any) => JSON.stringify(v)).join(", ")})`;
    })
    .join(", ");
  return `Ordered ${entries.length}-element array: [${shape}].`;
}

/**
 * Recursively sanitize schema for Gemini API compatibility
 *
 * Gemini's API is strict about schema format:
 * - type must be a single string, not an array
 * - Every `type: "array"` MUST carry `items`; an absent one is a missing proto
 *   field, not an omitted optional
 * - No additionalProperties, $schema, $ref, $id, $defs, definitions
 * - No allOf (an intersection has no Gemini equivalent)
 * - No format (the per-type allowlist is narrow; `format: "uri"` is a 400 risk)
 * - No default, const, examples
 * - Properties inside objects must be sanitized recursively
 *
 * `anyOf`, `oneOf`, `minItems`, `maxItems`, `enum` and `nullable` ARE supported,
 * measured against the live backend 2026-09-03
 * (`ai-docs/reports/gemini-tool-schema-support-20260903.md`). They were stripped
 * for years under a stale comment, which silently retyped every union property to
 * a bare string. Re-measure before removing anything from this list.
 */
export function sanitizeSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // Handle arrays (shouldn't be at top level, but handle anyway)
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }

  // A union is emitted as `anyOf` ALONE, with no sibling `type`, so this returns
  // before the type/properties/items handling below. Stripping it (the old
  // behaviour) left `normalizeType(undefined)` to answer "string", retyping a
  // union property to a bare string and telling the model to quote its numbers.
  const unionSource = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;

  if (unionSource) {
    const branches = unionBranches(unionSource);
    if (branches.length > 0) {
      const union: any = branches.length === 1 ? branches[0] : { anyOf: branches };
      if (typeof schema.description === "string" && !union.description) {
        union.description = schema.description;
      }
      return union;
    }
  }

  const result: any = {};

  // Normalize and set type (MUST be single string)
  const normalizedType = normalizeType(schema.type);
  result.type = normalizedType;

  // Copy allowed properties
  if (schema.description && typeof schema.description === "string") {
    result.description = schema.description;
  }

  // Handle enum (must be array of strings/numbers)
  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.filter(
      (v: any) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    );
  }

  // Handle required array
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((r: any) => typeof r === "string");
  }

  // Handle properties (for objects)
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      if (value && typeof value === "object") {
        result.properties[key] = sanitizeSchemaForGemini(value);
      }
    }
  }

  // Length constraints survive: measured accepted 2026-09-03. Dropping them let
  // the model emit arrays the tool would reject after the round-trip.
  if (typeof schema.minItems === "number") result.minItems = schema.minItems;
  if (typeof schema.maxItems === "number") result.maxItems = schema.maxItems;

  // Handle items (for arrays)
  // JSON Schema spells a tuple two ways: draft-07 puts an array in `items`,
  // 2020-12 uses `prefixItems`. Gemini has neither, and does not reject them
  // either — it IGNORES the keyword and then reports `items` as missing, which
  // is why the 400 names a field the caller never wrote.
  const tupleEntries = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : null;

  if (tupleEntries) {
    result.items = tupleElementSchema(tupleEntries);

    const note = describeTuple(tupleEntries);
    result.description = result.description ? `${result.description} ${note}` : note;

    // `items: false` is the 2020-12 spelling of "nothing beyond the prefix" —
    // the only case where the arity is a stated constraint rather than a
    // default. Inventing one otherwise would reject arrays the tool accepts.
    if (schema.items === false && result.maxItems === undefined) {
      result.maxItems = tupleEntries.length;
    }
  } else if (schema.items && typeof schema.items === "object") {
    result.items = sanitizeSchemaForGemini(schema.items);
  }

  // Gemini's proto requires `items` on EVERY array. A schema that describes its
  // elements only through prefixItems, or does not describe them at all, reaches
  // here without one and the whole request fails with
  //   ...parameters.properties[query].properties[where].items.items: missing field
  // naming a field the caller never wrote. Guarantee one at every depth.
  if (result.type === "array" && !result.items) {
    result.items = { type: "string" };
  }

  // Handle nullable - Gemini doesn't support nullable directly
  // We just use the base type (already handled by normalizeType)

  // IMPORTANT: Do NOT copy these unsupported fields:
  // - additionalProperties (causes "Proto field is not repeating" error)
  // - $schema, $ref, $id, $defs, definitions
  // - allOf (an intersection has no Gemini equivalent)
  // - format (accepted for `int32`, but the per-type allowlist is narrow and a
  //   tool shipping `format: "uri"` would 400 — not worth the round-trip)
  // - default, const, examples
  // - minimum, maximum, minLength, maxLength, pattern
  //
  // anyOf/oneOf and minItems/maxItems ARE handled above — they are supported.

  return result;
}

/**
 * Convert Claude/Anthropic tools to Gemini function declarations format
 *
 * Filters out tools with invalid names and sanitizes remaining names
 * to meet Gemini's function naming requirements.
 */
export function convertToolsToGemini(tools: any[] | undefined): any {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations: any[] = [];

  for (const tool of tools) {
    const sanitizedName = sanitizeToolNameForGemini(tool.name);

    // Skip tools with invalid names that can't be sanitized
    if (!sanitizedName) {
      log(`[GeminiSchema] Skipping tool without valid name: ${JSON.stringify(tool)}`);
      continue;
    }

    functionDeclarations.push({
      name: sanitizedName,
      description: tool.description || "",
      parameters: sanitizeSchemaForGemini(tool.input_schema),
    });
  }

  if (functionDeclarations.length === 0) {
    return undefined;
  }

  return [{ functionDeclarations }];
}
