import { describe, expect, test } from "bun:test";
import { AnthropicAPIFormat, hoistInlineSystem, mergeSystem } from "./anthropic-api-format.js";

describe("hoistInlineSystem", () => {
  test("returns the original array when there are no system entries", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const result = hoistInlineSystem(messages);

    expect(result.messages).toBe(messages);
    expect(result.hoisted).toEqual([]);
  });

  test("removes one string system entry and preserves surviving message order", () => {
    const user = { role: "user", content: "Before" };
    const assistant = { role: "assistant", content: "After" };
    const messages = [user, { role: "system", content: "Remember this" }, assistant];

    const result = hoistInlineSystem(messages);

    expect(result.messages).toEqual([user, assistant]);
    expect(result.hoisted).toEqual(["Remember this"]);
  });

  test("joins text from an array-content system entry with newlines", () => {
    const result = hoistInlineSystem([
      {
        role: "system",
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    ]);

    expect(result.messages).toEqual([]);
    expect(result.hoisted).toEqual(["A\nB"]);
  });

  test("removes and hoists several system entries in order", () => {
    const user = { role: "user", content: "Question" };
    const assistant = { role: "assistant", content: "Answer" };
    const result = hoistInlineSystem([
      { role: "system", content: "First" },
      user,
      { role: "system", content: [{ type: "text", text: "Second" }] },
      assistant,
      { role: "system", content: "Third" },
    ]);

    expect(result.messages).toEqual([user, assistant]);
    expect(result.hoisted).toEqual(["First", "Second", "Third"]);
  });

  test("drops a textless system entry without adding it to hoisted", () => {
    const user = { role: "user", content: "Keep me" };
    const result = hoistInlineSystem([user, { role: "system", content: [{ type: "image" }] }]);

    expect(result.messages).toEqual([user]);
    // Hoisting "" would append a blank paragraph and change the cached system
    // prefix even though no usable context was added.
    expect(result.hoisted).toEqual([]);
  });

  test("handles non-array input without throwing", () => {
    const call = () => hoistInlineSystem(undefined as any);

    expect(call).not.toThrow();
    expect(call().hoisted).toEqual([]);
  });
});

describe("mergeSystem", () => {
  test("returns an existing array by identity when hoisted is empty", () => {
    const existing = [{ type: "text", text: "System" }];

    expect(mergeSystem(existing, [])).toBe(existing);
  });

  test("returns hoisted text when existing is undefined", () => {
    expect(mergeSystem(undefined, ["Reminder"])).toBe("Reminder");
  });

  test("appends hoisted text to an existing string", () => {
    expect(mergeSystem("Existing", ["Hoisted"])).toBe("Existing\n\nHoisted");
  });

  test("appends one text block without mutating an existing array", () => {
    const first = { type: "text", text: "First" };
    const second = { type: "text", text: "Second" };
    const existing = [first, second];

    const merged = mergeSystem(existing, ["Reminder"]) as any[];

    expect(Array.isArray(merged)).toBe(true);
    expect(existing).toHaveLength(2);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(first);
    expect(merged[1]).toBe(second);
    expect(merged[2]).toEqual({ type: "text", text: "Reminder" });
  });

  test("preserves cache_control on existing system blocks", () => {
    const existing = [
      {
        type: "text",
        text: "sys",
        cache_control: { type: "ephemeral" },
      },
    ];

    const merged = mergeSystem(existing, ["Reminder"]) as any[];

    // Claude Code puts cache breakpoints on system blocks. Flattening the array
    // to a string would silently turn the HTTP 400 fix into a prefix-cache cost
    // regression by discarding those breakpoints.
    expect(merged[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("joins multiple hoisted strings with blank lines", () => {
    expect(mergeSystem(undefined, ["First", "Second", "Third"])).toBe("First\n\nSecond\n\nThird");
  });
});

describe("AnthropicAPIFormat.buildPayload end-to-end", () => {
  const format = new AnthropicAPIFormat("glm-5.2", "zai");

  test("hoists inline system text while preserving cached system blocks", () => {
    const system = [
      {
        type: "text",
        text: "You are helpful.",
        cache_control: { type: "ephemeral" },
      },
    ];
    const messages = [
      { role: "user", content: "Question" },
      { role: "system", content: "Use the latest context." },
      { role: "assistant", content: "Answer" },
    ];

    const payload = format.buildPayload({ system }, messages, []);

    expect(payload.messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
    expect(payload.system).toHaveLength(2);
    expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(payload.system[1]).toEqual({ type: "text", text: "Use the latest context." });
  });

  test("keeps system and message count unchanged when no inline system is present", () => {
    const system = [{ type: "text", text: "You are helpful." }];
    const messages = [
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ];

    const payload = format.buildPayload({ system }, messages, []);

    expect(payload.system).toEqual(system);
    expect(payload.messages).toHaveLength(messages.length);
  });

  test("uses the hoisted string when the request has no top-level system", () => {
    const payload = format.buildPayload(
      {},
      [
        { role: "user", content: "Question" },
        { role: "system", content: "Inline reminder" },
      ],
      []
    );

    expect(payload.system).toBe("Inline reminder");
  });

  test("omits system when neither top-level nor inline system is present", () => {
    const payload = format.buildPayload({}, [{ role: "user", content: "Question" }], []);

    expect("system" in payload).toBe(false);
  });
});
