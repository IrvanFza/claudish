import { describe, expect, it } from "bun:test";
import { convertToolsToOpenAI } from "./openai-tools.js";

function serializedParameters(inputSchema: unknown, summarize: boolean): unknown {
  const tool: Record<string, unknown> = {
    name: "test_tool",
    description: "A test tool.",
  };
  if (inputSchema !== undefined) {
    tool.input_schema = inputSchema;
  }

  const serialized = JSON.stringify(convertToolsToOpenAI({ tools: [tool] }, summarize));
  expect(serialized).toContain('"parameters":');

  const parsed = JSON.parse(serialized);
  expect(Object.hasOwn(parsed[0].function, "parameters")).toBe(true);
  return parsed[0].function.parameters;
}

describe("convertToolsToOpenAI", () => {
  it.each([
    { name: "missing", inputSchema: undefined },
    { name: "null", inputSchema: null },
    { name: "non-object", inputSchema: "not-a-schema" },
  ])("serializes object parameters for a $name input_schema", ({ inputSchema }) => {
    const parameters = serializedParameters(inputSchema, false);

    expect(parameters).toEqual({ type: "object", properties: {} });
  });

  it.each([
    { name: "missing", inputSchema: undefined },
    { name: "null", inputSchema: null },
    { name: "non-object", inputSchema: 42 },
  ])("serializes object parameters for a $name input_schema when summarized", ({ inputSchema }) => {
    const parameters = serializedParameters(inputSchema, true);

    expect(parameters).toEqual({ type: "object", properties: {} });
  });

  it("round-trips a normal object schema unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "integer" },
      },
      required: ["query"],
    };

    expect(serializedParameters(schema, false)).toEqual(schema);
  });
});
