import { afterEach, describe, expect, it } from "bun:test";
import {
  _debug_getTrackedAdvisorIds,
  _debug_resetTrackedAdvisorIds,
  loadAdvisorSwapConfig,
  recordAdvisorEventsFromChunk,
  rewriteAdvisorToolResults,
  stripAdvisorBeta,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";

afterEach(() => {
  _debug_resetTrackedAdvisorIds();
});

describe("swapAdvisorToolInBody", () => {
  it("replaces advisor_20260301 with a regular tool of the same name", () => {
    const body = {
      tools: [
        { name: "Bash", input_schema: {} },
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6" },
        { name: "Read", input_schema: {} },
      ],
    };
    const info = swapAdvisorToolInBody(body);
    expect(info).not.toBeNull();
    expect(body.tools).toHaveLength(3);
    // Bash and Read untouched
    expect((body.tools[0] as any).name).toBe("Bash");
    expect((body.tools[2] as any).name).toBe("Read");
    // Advisor replaced with regular tool
    const replaced = body.tools[1] as any;
    expect(replaced.name).toBe("advisor");
    expect(replaced.type).toBeUndefined();
    expect(replaced.input_schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(typeof replaced.description).toBe("string");
    expect(replaced.description.length).toBeGreaterThan(50);
  });

  it("returns null when no advisor tool is present", () => {
    const body = { tools: [{ name: "Bash", input_schema: {} }] };
    expect(swapAdvisorToolInBody(body)).toBeNull();
  });

  it("returns null when tools is missing or not an array", () => {
    expect(swapAdvisorToolInBody({})).toBeNull();
    expect(swapAdvisorToolInBody({ tools: null as any })).toBeNull();
    expect(swapAdvisorToolInBody({ tools: "nope" as any })).toBeNull();
  });
});

describe("stripAdvisorBeta", () => {
  it("removes advisor-tool-2026-03-01 from a comma list", () => {
    const { stripped, changed } = stripAdvisorBeta(
      "claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24",
    );
    expect(changed).toBe(true);
    expect(stripped).toBe("claude-code-20250219,effort-2025-11-24");
  });

  it("returns changed=false when advisor beta is absent", () => {
    const { stripped, changed } = stripAdvisorBeta("claude-code-20250219");
    expect(changed).toBe(false);
    expect(stripped).toBe("claude-code-20250219");
  });

  it("handles whitespace around entries", () => {
    const { stripped, changed } = stripAdvisorBeta(
      "claude-code-20250219, advisor-tool-2026-03-01 , effort-2025-11-24",
    );
    expect(changed).toBe(true);
    expect(stripped).toBe("claude-code-20250219,effort-2025-11-24");
  });

  it("returns undefined when the only entry was the advisor beta", () => {
    const { stripped, changed } = stripAdvisorBeta("advisor-tool-2026-03-01");
    expect(changed).toBe(true);
    expect(stripped).toBeUndefined();
  });

  it("is a no-op for missing header", () => {
    const { stripped, changed } = stripAdvisorBeta(undefined);
    expect(changed).toBe(false);
    expect(stripped).toBeUndefined();
  });
});

describe("extractAdvisorToolUseIds (via recordAdvisorEventsFromChunk)", () => {
  const cfg = { enabled: true, logPath: undefined };

  it("captures toolu_* ids from a content_block_start with name=advisor", () => {
    const chunk =
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
      '"content_block":{"type":"tool_use","id":"toolu_01ABCxyz","name":"advisor","input":{}}}\n\n';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).toContain("toolu_01ABCxyz");
  });

  it("captures ids when name comes before id (alternate field order)", () => {
    const chunk =
      '"content_block":{"name":"advisor","type":"tool_use","id":"toolu_alt123","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).toContain("toolu_alt123");
  });

  it("does not capture ids for non-advisor tools", () => {
    const chunk =
      '"content_block":{"type":"tool_use","id":"toolu_99bash","name":"Bash","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    expect(_debug_getTrackedAdvisorIds()).not.toContain("toolu_99bash");
  });

  it("deduplicates repeated observations of the same id", () => {
    const chunk =
      '"content_block":{"type":"tool_use","id":"toolu_dup","name":"advisor","input":{}}';
    recordAdvisorEventsFromChunk(cfg, chunk);
    recordAdvisorEventsFromChunk(cfg, chunk);
    const ids = _debug_getTrackedAdvisorIds();
    expect(ids.filter((x) => x === "toolu_dup")).toHaveLength(1);
  });
});

describe("rewriteAdvisorToolResults", () => {
  it("rewrites an error tool_result for a known advisor id", () => {
    // First seed the tracker so rewrite recognises the id
    recordAdvisorEventsFromChunk(
      { enabled: true, logPath: undefined },
      '"content_block":{"type":"tool_use","id":"toolu_known","name":"advisor","input":{}}',
    );

    const body = {
      messages: [
        { role: "user", content: "build a rate limiter" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_known", name: "advisor", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_known",
              is_error: true,
              content:
                "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual(["toolu_known"]);

    const resultBlock = (body.messages[2] as any).content[0];
    expect(resultBlock.is_error).toBe(false);
    expect(Array.isArray(resultBlock.content)).toBe(true);
    expect(resultBlock.content[0].type).toBe("text");
    expect(resultBlock.content[0].text).toContain("CLAUDISH_ADVISOR_STUB_toolu_known");
  });

  it("ignores tool_result blocks with unknown ids", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_never_seen",
              is_error: true,
              content: "<tool_use_error>...</tool_use_error>",
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual([]);
    expect((body.messages[0] as any).content[0].is_error).toBe(true);
  });

  it("leaves non-advisor tool_results untouched even when ids exist in tracker", () => {
    recordAdvisorEventsFromChunk(
      { enabled: true, logPath: undefined },
      '"content_block":{"type":"tool_use","id":"toolu_adv","name":"advisor","input":{}}',
    );
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_some_other_tool",
              is_error: false,
              content: [{ type: "text", text: "output of Bash" }],
            },
          ],
        },
      ],
    };
    const rewritten = rewriteAdvisorToolResults(body, stubAdvisorAdvice);
    expect(rewritten).toEqual([]);
    // Unchanged
    const blk = (body.messages[0] as any).content[0];
    expect(blk.is_error).toBe(false);
    expect(blk.content[0].text).toBe("output of Bash");
  });

  it("is a no-op when messages is missing or content isn't a block array", () => {
    expect(rewriteAdvisorToolResults({}, stubAdvisorAdvice)).toEqual([]);
    expect(
      rewriteAdvisorToolResults(
        { messages: [{ role: "user", content: "plain text" }] },
        stubAdvisorAdvice,
      ),
    ).toEqual([]);
  });
});

describe("loadAdvisorSwapConfig", () => {
  const orig = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, orig);
  });

  it("reads CLAUDISH_SWAP_ADVISOR and log paths from env", () => {
    process.env.CLAUDISH_SWAP_ADVISOR = "1";
    process.env.CLAUDISH_SWAP_ADVISOR_LOG = "/tmp/foo.ndjson";
    process.env.CLAUDISH_SWAP_ADVISOR_DUMP = "1";
    const cfg = loadAdvisorSwapConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.logPath).toBe("/tmp/foo.ndjson");
    expect(cfg.dumpBodies).toBe(true);
  });

  it("is disabled when CLAUDISH_SWAP_ADVISOR is unset", () => {
    delete process.env.CLAUDISH_SWAP_ADVISOR;
    const cfg = loadAdvisorSwapConfig();
    expect(cfg.enabled).toBe(false);
  });
});
