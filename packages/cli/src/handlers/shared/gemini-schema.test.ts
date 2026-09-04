/**
 * Pins Gemini array-schema conversion, including tuple unions and nested tuple
 * forms, because Gemini rejects every array node whose request schema omits `items`.
 */

import { describe, expect, test } from "bun:test";
import { convertToolsToGemini, sanitizeSchemaForGemini } from "./gemini-schema.js";

const ARTIFACT_QUERY_SCHEMA = {
  type: "object",
  properties: {
    cursor: { maxLength: 4096, type: "string" },
    limit: { maximum: 1000, minimum: 1, type: "integer" },
    where: {
      items: {
        prefixItems: [
          { type: "string" },
          {
            enum: ["eq", "ne", "in", "not-in", "lt", "lte", "gt", "gte", "array-contains"],
            type: "string",
          },
          {},
        ],
        type: "array",
      },
      maxItems: 10,
      type: "array",
    },
  },
};

function collectArraysWithoutItems(node: unknown, path = "$", missing: string[] = []): string[] {
  if (!node || typeof node !== "object") return missing;

  if (Array.isArray(node)) {
    node.forEach((value, index) => collectArraysWithoutItems(value, `${path}[${index}]`, missing));
    return missing;
  }

  const schema = node as Record<string, unknown>;
  if (schema.type === "array" && schema.items === undefined) missing.push(path);

  for (const [key, value] of Object.entries(schema)) {
    collectArraysWithoutItems(value, `${path}.${key}`, missing);
  }
  return missing;
}

describe("Gemini array schema conversion", () => {
  test("fills items at the exact nested Artifact request path", () => {
    const converted = convertToolsToGemini([
      { name: "First", input_schema: { type: "object", properties: {} } },
      {
        name: "Artifact",
        input_schema: {
          type: "object",
          properties: { query: ARTIFACT_QUERY_SCHEMA },
        },
      },
    ]);

    expect(
      converted[0].functionDeclarations[1].parameters.properties.query.properties.where.items.items
    ).toBeDefined();
    expect(collectArraysWithoutItems(converted[0].functionDeclarations[1].parameters)).toEqual([]);
  });

  test("adds items to a bare array", () => {
    const sanitized = sanitizeSchemaForGemini({
      type: "object",
      properties: { values: { type: "array" } },
    });

    expect(sanitized.properties.values.items).toEqual({ type: "string" });
  });

  test("collapses a uniform prefixItems tuple to its shared type", () => {
    expect(
      sanitizeSchemaForGemini({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
      }).items
    ).toEqual({ type: "number" });
  });

  test("converts a mixed prefixItems tuple to an ordered union", () => {
    expect(
      sanitizeSchemaForGemini({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      }).items
    ).toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });
  });

  test("preserves a position-specific enum as a union branch", () => {
    const items = sanitizeSchemaForGemini({
      type: "array",
      prefixItems: [{ type: "string", enum: ["a", "b"] }, { type: "string" }],
    }).items;

    expect(items.anyOf[0]).toEqual({ type: "string", enum: ["a", "b"] });
  });

  test("keeps unconstrained Artifact values numeric and describes tuple positions", () => {
    const where = sanitizeSchemaForGemini(ARTIFACT_QUERY_SCHEMA).properties.where;

    expect(where.items.items.anyOf).toContainEqual({ type: "number" });
    expect(where.items.description).toMatch(/Ordered 3-element array/);
    expect(where.items.description).toContain('"eq"');
  });

  test("preserves array length constraints", () => {
    const where = sanitizeSchemaForGemini(ARTIFACT_QUERY_SCHEMA).properties.where;
    const bounded = sanitizeSchemaForGemini({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 2,
    });

    expect(where.maxItems).toBe(10);
    expect(bounded.minItems).toBe(1);
    expect(bounded.maxItems).toBe(2);
  });

  test("passes anyOf through without adding a sibling type", () => {
    const sanitized = sanitizeSchemaForGemini({
      anyOf: [{ type: "number" }, { type: "string" }],
    });

    expect(sanitized).toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });
    expect(sanitized).not.toHaveProperty("type");
  });

  test("converts oneOf to anyOf without adding a sibling type", () => {
    const sanitized = sanitizeSchemaForGemini({
      oneOf: [{ type: "boolean" }, { type: "string" }],
    });

    expect(sanitized).toEqual({ anyOf: [{ type: "boolean" }, { type: "string" }] });
    expect(sanitized).not.toHaveProperty("type");
  });

  test("collapses a legacy draft-07 tuple", () => {
    expect(
      sanitizeSchemaForGemini({
        type: "array",
        items: [{ type: "boolean" }, { type: "boolean" }],
      }).items
    ).toEqual({ type: "boolean" });
  });

  test("leaves an ordinary items schema unchanged", () => {
    expect(
      sanitizeSchemaForGemini({
        type: "array",
        items: { type: "string" },
      })
    ).toEqual({ type: "array", items: { type: "string" } });
  });
});
