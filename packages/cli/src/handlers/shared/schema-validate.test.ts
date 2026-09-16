/**
 * Unit contract for the minimal schema reader.
 *
 * These are assertions about OUR functions, not about any model: no case here
 * claims that some provider emitted some shape. The one behaviour that DOES rest
 * on a real model — an empty-string required argument — is gated separately by a
 * live capture, in `format-translation.test.ts` against
 * `sse-responses/grok-4.6-openai-edit-empty-new-string.sse`.
 */

import { describe, expect, test } from "bun:test";
import {
  applySchemaDefaults,
  coerceToSchema,
  missingRequired,
  renameToDeclaredKeys,
} from "./schema-validate.js";

describe("missingRequired: presence is key presence, not truthiness", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "boolean" },
      d: { type: "array" },
    },
    required: ["a", "b", "c", "d"],
  };

  test("falsy-but-supplied values are present", () => {
    expect(missingRequired(schema, { a: "", b: 0, c: false, d: [] })).toEqual([]);
  });

  test("an absent key is missing", () => {
    expect(missingRequired(schema, { b: 0, c: false, d: [] })).toEqual(["a"]);
  });

  test("undefined and null are missing; an explicit empty object is not", () => {
    expect(missingRequired({ ...schema, required: ["a"] }, { a: undefined })).toEqual(["a"]);
    expect(missingRequired({ ...schema, required: ["a"] }, { a: null })).toEqual(["a"]);
    expect(missingRequired({ ...schema, required: ["a"] }, { a: {} })).toEqual([]);
  });

  test("a schema with no required list demands nothing", () => {
    expect(missingRequired({ type: "object" }, {})).toEqual([]);
    expect(missingRequired(undefined, {})).toEqual([]);
  });
});

describe("coerceToSchema: declared types, and a failure keeps the value", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      name: { type: "string" },
    },
  };

  test("a full numeric string becomes a number", () => {
    expect(coerceToSchema(schema, { count: "5", ratio: "-1.5e2" }).args).toEqual({
      count: 5,
      ratio: -150,
    });
  });

  test('"3abc" is NOT 3 — a partial parse would invent an argument', () => {
    expect(coerceToSchema(schema, { count: "3abc" }).args).toEqual({ count: "3abc" });
  });

  test("a non-integer string is not forced into an integer field", () => {
    expect(coerceToSchema(schema, { count: "2.5" }).args).toEqual({ count: "2.5" });
  });

  test('only exactly "true"/"false" become booleans', () => {
    expect(coerceToSchema(schema, { flag: "true" }).args).toEqual({ flag: true });
    expect(coerceToSchema(schema, { flag: "False" }).args).toEqual({ flag: false });
    expect(coerceToSchema(schema, { flag: "yes" }).args).toEqual({ flag: "yes" });
  });

  test("a value already of the declared type is untouched", () => {
    const args = { count: 5, name: "x" };
    expect(coerceToSchema(schema, args).args).toBe(args);
  });

  test("an undeclared key is left exactly as it came", () => {
    expect(coerceToSchema(schema, { whatever: "7" }).args).toEqual({ whatever: "7" });
  });
});

describe("applySchemaDefaults: the schema's own value, for required keys only", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", default: 5 },
      verbose: { type: "boolean", default: false },
    },
    required: ["query", "max_results"],
  };

  test("an absent required key takes its declared default", () => {
    const { args, applied } = applySchemaDefaults(schema, { query: "x" });
    expect(args).toEqual({ query: "x", max_results: 5 });
    expect(applied).toEqual(["max_results"]);
  });

  test("a supplied value always wins, including a falsy one", () => {
    expect(applySchemaDefaults(schema, { query: "x", max_results: 0 }).args.max_results).toBe(0);
  });

  test("an OPTIONAL key's default is not applied", () => {
    // Deliberate: it would flip `repaired` on calls that were already valid, and
    // `repaired` supersedes an already-streamed tool block in openai-sse.ts.
    expect(applySchemaDefaults(schema, { query: "x" }).args).not.toHaveProperty("verbose");
  });
});

describe("renameToDeclaredKeys: moves a supplied value, never invents one", () => {
  const schema = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  test("an undeclared synonym moves onto the declared required key", () => {
    const { args, renamed } = renameToDeclaredKeys(schema, { cmd: "ls -la" });
    expect(args).toEqual({ command: "ls -la" });
    expect(renamed).toEqual(["cmd→command"]);
  });

  test("a supplied target is never overwritten", () => {
    expect(renameToDeclaredKeys(schema, { command: "real", cmd: "other" }).args).toEqual({
      command: "real",
      cmd: "other",
    });
  });

  test("an empty string counts as supplied and blocks the rename", () => {
    expect(renameToDeclaredKeys(schema, { command: "", cmd: "other" }).args.command).toBe("");
  });

  test("a synonym the schema ALSO declares means something else and never moves", () => {
    const declaresBoth = {
      type: "object",
      properties: { command: { type: "string" }, script: { type: "string" } },
      required: ["command"],
    };
    expect(renameToDeclaredKeys(declaresBoth, { script: "x" }).args).toEqual({ script: "x" });
  });

  test("nothing is invented when no synonym was supplied", () => {
    expect(renameToDeclaredKeys(schema, {}).args).toEqual({});
    expect(missingRequired(schema, renameToDeclaredKeys(schema, {}).args)).toEqual(["command"]);
  });

  test("a non-required declared key is not a rename target", () => {
    const optional = {
      type: "object",
      properties: { command: { type: "string" } },
      required: [],
    };
    expect(renameToDeclaredKeys(optional, { cmd: "ls" }).args).toEqual({ cmd: "ls" });
  });
});
