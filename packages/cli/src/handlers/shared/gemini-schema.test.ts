/**
 * Pins Gemini array-schema conversion, including nested tuple forms, because
 * Gemini rejects every array node whose request schema omits `items`.
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

  test("falls back to string for a mixed prefixItems tuple", () => {
    expect(
      sanitizeSchemaForGemini({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      }).items
    ).toEqual({ type: "string" });
  });

  test("does not preserve a position-specific enum while collapsing a tuple", () => {
    const items = sanitizeSchemaForGemini({
      type: "array",
      prefixItems: [{ type: "string", enum: ["a", "b"] }, { type: "string" }],
    }).items;

    expect(items).toEqual({ type: "string" });
    expect(items).not.toHaveProperty("enum");
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
