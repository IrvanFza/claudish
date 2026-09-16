import { describe, expect, it } from "bun:test";

import {
  extractToolCallsFromText,
  hasExtractableFunctionTag,
  parseFunctionTagEnvelope,
} from "./tool-call-recovery.js";

describe("extractToolCallsFromText tool-name validation", () => {
  it("rejects a swallowed argument value without breaking Qwen-style recovery", () => {
    const malformed =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]>';

    expect(extractToolCallsFromText(malformed)).toEqual([]);

    const recovered = extractToolCallsFromText('<function=web_search><parameter=query_list>["x"]');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      name: "web_search",
      arguments: { query_list: '["x"]' },
    });
  });

  it("drops well-shaped unadvertised names only when an allowlist is supplied", () => {
    const text = "<function=Unadvertised><parameter=value>x";

    expect(extractToolCallsFromText(text, ["Read"])).toEqual([]);
    expect(extractToolCallsFromText(text)).toEqual([
      {
        name: "Unadvertised",
        arguments: { value: "x" },
        source: "xml_text",
      },
    ]);
  });

  it("canonicalizes an advertised tool name case-insensitively", () => {
    expect(extractToolCallsFromText("<function=read>", ["Read"])).toEqual([
      {
        name: "Read",
        arguments: {},
        source: "xml_text",
      },
    ]);
  });

  it("rejects tool names longer than 64 characters", () => {
    const tooLong = `A${"a".repeat(64)}`;

    expect(extractToolCallsFromText(`<function=${tooLong}>`)).toEqual([]);
  });

  it("detects exactly the function tags that Pattern 0 can extract", () => {
    const valid = "<function=Read>";
    const invalid = "<function=not a name!>";

    expect(hasExtractableFunctionTag(valid)).toBe(true);
    expect(extractToolCallsFromText(valid)).toHaveLength(1);
    expect(hasExtractableFunctionTag(invalid)).toBe(false);
    expect(extractToolCallsFromText(invalid)).toEqual([]);
  });
});

/**
 * The envelope parser runs BEFORE the six loose regex patterns and
 * short-circuits on success, so its strictness is the only thing keeping that
 * safe. Every case below is about what it REFUSES.
 *
 * No case here claims a model emitted anything — these are the parser's own
 * contract. The positive cases are the existing Qwen recovery cases above, which
 * now flow through this path.
 */
describe("parseFunctionTagEnvelope strictness", () => {
  it("refuses text that merely describes the format", () => {
    expect(parseFunctionTagEnvelope("Use the <function=NAME> format to call a tool.")).toBeNull();
    expect(parseFunctionTagEnvelope("I'll use the Read tool to read the file.")).toBeNull();
    expect(parseFunctionTagEnvelope("")).toBeNull();
  });

  it("refuses an envelope with anything in front of it", () => {
    expect(parseFunctionTagEnvelope("Let me read it: <function=Read><parameter=file_path>/a")).toBe(
      null
    );
  });

  it("refuses a name that is not an identifier, exactly as the shape gate does", () => {
    expect(parseFunctionTagEnvelope("<function=not a name!><parameter=x>1")).toBeNull();
  });

  it("parses two blocks as two calls, each with its own parameters", () => {
    expect(
      parseFunctionTagEnvelope(
        "<function=Read><parameter=file_path>/a\n<function=Bash><parameter=command>ls"
      )
    ).toEqual([
      { name: "Read", arguments: { file_path: "/a" }, source: "xml_text" },
      { name: "Bash", arguments: { command: "ls" }, source: "xml_text" },
    ]);
  });

  it("honours explicit closing tags rather than swallowing them into the value", () => {
    expect(
      parseFunctionTagEnvelope("<function=Read><parameter=file_path>/a</parameter></function>")?.[0]
        ?.arguments
    ).toEqual({ file_path: "/a" });
  });

  it("keeps a multi-line value whole", () => {
    expect(
      parseFunctionTagEnvelope("<function=Write><parameter=file_path>/a\n<parameter=content>x\ny")
    ).toEqual([
      { name: "Write", arguments: { file_path: "/a", content: "x\ny" }, source: "xml_text" },
    ]);
  });

  it("still applies the advertised-tool allowlist through the extractor", () => {
    const envelope = "<function=Unadvertised><parameter=value>x";
    expect(parseFunctionTagEnvelope(envelope)).not.toBeNull();
    expect(extractToolCallsFromText(envelope, ["Read"])).toEqual([]);
  });
});
