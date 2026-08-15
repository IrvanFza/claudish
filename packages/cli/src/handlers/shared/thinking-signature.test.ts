import { describe, expect, test } from "bun:test";
import { stripUnsignedThinkingBlocks } from "./thinking-signature.js";

const ANTHROPIC_STYLE_SIGNATURE =
  "EqQBCgIYAhIM1p3g5rRkW9Q2x0sEGiAq7mJ4v8N6cY1bT5uH3dF9kL2wP0zX" +
  "nC8sV4aR7eU1qG6jM9hB3yD5fK0tW2pL8xZ4cN7vS1gQ6mJ9rH3bY5dF0kP" +
  "2wT8uA4eR7iO1qG6jM9hB3yD5fK0tW2pL8xZ4cN7vS1gQ6mJ9rH3bY5d" +
  "F0kP2wT8uA4eR7iO1qG6jM9hB3yD5fK0tW2pL8xZ4cN7vS1gQ6mJ9rH3";

describe("stripUnsignedThinkingBlocks", () => {
  test("removes an empty-signature thinking block without disturbing sibling text", () => {
    const text = { type: "text", text: "The useful answer" };
    const messages = [
      {
        role: "assistant",
        content: [text, { type: "thinking", thinking: "Foreign reasoning", signature: "" }],
      },
    ];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(1);
    expect(messages[0].content).toEqual([text]);
    expect(messages[0].content[0]).toBe(text);
  });

  test("removes a thinking block with no signature key", () => {
    const messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "Unsigned" }] }];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(1);
    expect(messages[0].content).toEqual([]);
  });

  test("removes a thinking block whose signature is null", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Unsigned", signature: null }],
      },
    ];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(1);
    expect(messages[0].content).toEqual([]);
  });

  test("preserves a realistic non-empty Anthropic-style signature", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Native extended thinking",
            signature: ANTHROPIC_STYLE_SIGNATURE,
          },
        ],
      },
    ];
    const expected = structuredClone(messages);

    expect(stripUnsignedThinkingBlocks(messages)).toBe(0);
    expect(messages).toEqual(expected);
  });

  test("preserves the documented foreign 64-hex signature gap", () => {
    const minimaxSignature = "7caa0d3cc2a449ac1cc68507504693f566245c7b5db3558f6041585e15a848f8";
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "MiniMax reasoning", signature: minimaxSignature }],
      },
    ];

    // A non-empty signature is preserved: this removes only blocks known not to be Anthropic-signed.
    // This 64-hex value is a real MiniMax signature retained as a realistic non-empty fixture. In practice,
    // it never arrives here because Anthropic-wire emission strips thinking via shouldFilterThinking() →
    // createAnthropicPassthroughStream(). If filtering were narrowed to a model list, foreign signatures
    // would reach the client and this filter would be insufficient; the implicit coupling is the wire format.
    expect(stripUnsignedThinkingBlocks(messages)).toBe(0);
    expect(messages[0].content[0].signature).toBe(minimaxSignature);
  });

  test("removes multiple unsigned blocks across several messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First", signature: "" },
          { type: "text", text: "First answer" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Continue" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Second" },
          { type: "thinking", thinking: "Third", signature: null },
          { type: "text", text: "Second answer" },
        ],
      },
    ];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(3);
    expect(messages[0].content).toEqual([{ type: "text", text: "First answer" }]);
    expect(messages[1].content).toEqual([{ type: "text", text: "Continue" }]);
    expect(messages[2].content).toEqual([{ type: "text", text: "Second answer" }]);
  });

  test("never touches non-thinking block types, even when they carry an empty signature", () => {
    const content = [
      { type: "text", text: "Answer", signature: "" },
      { type: "tool_use", id: "tool-1", name: "lookup", input: {}, signature: "" },
      { type: "tool_result", tool_use_id: "tool-1", content: "Result", signature: "" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ];
    const messages = [{ role: "assistant", content }];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(0);
    expect(messages[0].content).toBe(content);
    expect(messages[0].content).toEqual(content);
  });

  test("keeps a message when removing its only content block", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Only block", signature: "" }],
      },
    ];

    // Removing the message would renumber the conversation.
    expect(stripUnsignedThinkingBlocks(messages)).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([]);
  });

  test("mutates the original messages array in place", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Remove me", signature: "" },
          { type: "text", text: "Keep me" },
        ],
      },
    ];
    const payload = { messages };

    expect(stripUnsignedThinkingBlocks(payload.messages)).toBe(1);
    expect(payload.messages).toBe(messages);
    expect(messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Keep me" }] }]);
  });

  test("returns zero without throwing for degenerate inputs", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      "nope",
      [],
      [null],
      [{}],
      [{ content: "a string" }],
      [{ content: null }],
    ];

    for (const input of inputs) {
      let result: number | undefined;
      expect(() => {
        result = stripUnsignedThinkingBlocks(input);
      }).not.toThrow();
      expect(result).toBe(0);
    }
  });

  test("does not rewrite a content array when there is nothing to remove", () => {
    const content = [
      { type: "text", text: "Already safe" },
      {
        type: "thinking",
        thinking: "Native extended thinking",
        signature: ANTHROPIC_STYLE_SIGNATURE,
      },
    ];
    const messages = [{ role: "assistant", content }];

    expect(stripUnsignedThinkingBlocks(messages)).toBe(0);
    expect(messages[0].content).toBe(content);
  });
});
