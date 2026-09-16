/**
 * A minimal JSON Schema reader for TOOL schemas.
 *
 * Scope is deliberate, and recorded in this session's `decisions.md` (ruling 1):
 * the keywords a Claude Code tool `input_schema` actually uses — `type`,
 * `properties`, `required`, `enum`, `items`, `default` — and nothing else. It is
 * not a general-purpose validator and must not grow into one. The trigger to
 * replace it with a real library (`ajv`) is a tool schema in the wild that it
 * mis-validates; until then a published CLI with a `--compile` binary target
 * (`packages/cli/package.json` `build:binary`) carries no new runtime dependency
 * for this.
 *
 * The one rule that matters more than any other lives in {@link missingRequired}:
 * **presence is key presence, never truthiness.** The hand-written filter this
 * replaces tested `parsedArgs[param] === ""` and so declared a legitimately empty
 * string missing. A live `gk@grok-4.6` turn emitted
 * `Edit{…,"new_string":""}` — a deletion, the whole point of the call — and
 * claudish rejected it as "missing required parameters: new_string". The file was
 * left unchanged and the model was told its own correct call was malformed. See
 * `test-fixtures/sse-responses/grok-4.6-openai-edit-empty-new-string.sse`.
 */

/** The slice of JSON Schema this module reads. Anything else is ignored. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode | undefined>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchemaNode;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * Which of the schema's `required` keys are genuinely absent from `args`?
 *
 * Present means **the key exists and its value is neither `undefined` nor
 * `null`**. `""`, `0`, `false`, `[]` and `{}` are all present values a model may
 * legitimately mean: an empty replacement string, a zero offset, a disabled flag,
 * an empty list.
 *
 * `null` counts as absent rather than present because JSON's `null` is how a
 * model spells "I have no value for this", and no Claude Code tool declares a
 * nullable required parameter.
 */
export function missingRequired(
  schema: JsonSchemaNode | undefined,
  args: Record<string, unknown> | undefined
): string[] {
  const required = schema?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const supplied = args ?? {};
  return required.filter((key) => {
    if (typeof key !== "string") return false;
    if (!Object.hasOwn(supplied, key)) return true;
    const value = supplied[key];
    return value === undefined || value === null;
  });
}
