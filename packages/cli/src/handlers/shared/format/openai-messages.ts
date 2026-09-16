/**
 * OpenAI message format conversion utilities.
 *
 * Converts Claude/Anthropic message format to OpenAI message format.
 */

import { log } from "../../../logger.js";

/**
 * Convert Claude/Anthropic messages to OpenAI format
 * @param simpleFormat - If true, use simple string content only (for MLX and other basic providers)
 */
export function convertMessagesToOpenAI(
  req: any,
  modelId: string,
  filterIdentityFn?: (s: string) => string,
  simpleFormat = false
): any[] {
  const messages: any[] = [];

  if (req.system) {
    let content = Array.isArray(req.system)
      ? req.system.map((i: any) => i.text || i).join("\n\n")
      : req.system;
    if (filterIdentityFn) content = filterIdentityFn(content);
    messages.push({ role: "system", content });
  }

  // Add instruction for Grok models to use proper tool format
  if (modelId.includes("grok") || modelId.includes("x-ai")) {
    const msg =
      "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content += `\n\n${msg}`;
    } else {
      messages.unshift({ role: "system", content: msg });
    }
  }

  if (req.messages) {
    for (const msg of req.messages) {
      if (msg.role === "user") processUserMessage(msg, messages, simpleFormat);
      else if (msg.role === "assistant") processAssistantMessage(msg, messages, simpleFormat);
    }
  }

  return normalizeMessageSequence(messages);
}

/**
 * Merge two adjacent `user` contents, or return `undefined` for "do not merge".
 *
 * Two shapes reach here: a plain string (a Claude turn whose content was not a
 * block array) and an array of OpenAI content parts. A string pair stays a
 * string — keeping the simple shape matters for providers that only accept one.
 * A mixed pair is lifted to parts. Anything else (a null content, an object) is
 * left alone rather than guessed at.
 */
function mergeUserContent(a: any, b: any): any | undefined {
  if (typeof a === "string" && typeof b === "string") {
    if (!a) return b;
    if (!b) return a;
    return `${a}\n\n${b}`;
  }
  const toParts = (c: any): any[] | undefined => {
    if (typeof c === "string") return c ? [{ type: "text", text: c }] : [];
    if (Array.isArray(c)) return c;
    return undefined;
  };
  const pa = toParts(a);
  const pb = toParts(b);
  if (!pa || !pb) return undefined;
  return [...pa, ...pb];
}

/** Push a `user` message, merging it into the preceding one when there is one. */
function pushUserMessage(out: any[], msg: any) {
  const prev = out[out.length - 1];
  if (prev?.role === "user") {
    const merged = mergeUserContent(prev.content, msg.content);
    if (merged !== undefined) {
      prev.content = merged;
      return;
    }
  }
  out.push(msg);
}

/**
 * Post-pass over the converted message list, fixing two sequence-level defects
 * that are only visible AFTER conversion.
 *
 * It has to be a post-pass rather than an edit inside `processUserMessage`,
 * because the converter itself emits up to three messages for a single Claude
 * user turn (the tool results, the images lifted out of them, and the turn's own
 * content). The adjacency is created here, so it can only be seen from here.
 *
 * 1. **Adjacent `user` messages merge.** Chat Completions does not require
 *    strict alternation, but several relays and local runtimes do, and a
 *    provider that silently keeps only the last of a run drops the user's words.
 *
 * 2. **A `tool` message must answer an open tool round** — it must follow either
 *    an `assistant` carrying `tool_calls` or another `tool` message in the same
 *    round. An orphan (the assistant turn was compacted out of history, or the
 *    client replayed a result alone) is rejected by OpenAI with
 *    `messages with role 'tool' must be a response to a preceding message with
 *    tool_calls`, which reaches the user as an opaque 400. It is re-emitted as a
 *    `user` message prefixed `[Tool Result]:` — the same degradation
 *    `simpleFormat` already applies — so the content survives.
 *
 * FCC additionally inserts a synthetic `assistant: " "` between a tool round and
 * a following user turn. That is NOT done here, per the design's ruling: the
 * synthetic turn is itself a fidelity cost (it enters history as words the
 * assistant never said, and is replayed on every later turn), and
 * `assistant(tool_calls) → tool → user` is legal OpenAI on its own. What
 * "closing the round" means here is rule 2 — a tool message outside a round
 * stops being one.
 *
 * No message is ever moved or dropped by this pass.
 */
export function normalizeMessageSequence(messages: any[]): any[] {
  const out: any[] = [];
  // True while the last non-tool message was an assistant carrying tool_calls.
  let toolRoundOpen = false;

  for (const msg of messages) {
    if (msg.role === "tool") {
      if (toolRoundOpen) {
        out.push(msg);
        continue;
      }
      log(
        `[OpenAIMessages] error — tool result ${msg.tool_call_id} answers no open tool round; ` +
          "re-emitted as a user message"
      );
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      pushUserMessage(out, { role: "user", content: `[Tool Result]: ${text}` });
      continue;
    }

    toolRoundOpen =
      msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    if (msg.role === "user") pushUserMessage(out, msg);
    else out.push(msg);
  }

  return out;
}

/**
 * Convert one Claude `image` block to an OpenAI `image_url` part.
 *
 * Claude carries an image in one of two source shapes, and only ONE of them is
 * base64:
 *
 *   { type: "base64", media_type: "image/png", data: "<b64>" }
 *   { type: "url",    url: "https://…" }
 *
 * This function used to build a data URL unconditionally, so a `url` source
 * produced the literal string `data:undefined;base64,undefined` — a syntactically
 * valid data URL carrying the word "undefined", which no provider rejects loudly.
 * It is decoded as garbage bytes or ignored, and the user sees a model that
 * cannot see the image it was sent.
 *
 * Returns `null` for a source this converter cannot express, so the caller drops
 * the part rather than forwarding a broken one. Every caller MUST skip `null`;
 * in particular the tool_result path counts the forwarded images to decide
 * whether to emit its "[image returned…]" marker.
 *
 * The media type is validated for SHAPE (a non-empty string), not against a list
 * of accepted image types. An allowlist here would be a second roster to keep
 * current, and a media type this converter has not heard of is the upstream
 * provider's judgement to make, not ours.
 */
function imageBlockToUrlPart(block: any): any | null {
  const source = block?.source;
  if (!source || typeof source !== "object") {
    log("[OpenAIMessages] Dropping image block: error — no source object");
    return null;
  }

  const url = typeof source.url === "string" ? source.url : "";
  const data = typeof source.data === "string" ? source.data : "";
  // `source.type` is the declaration; the payload present is the fallback, for
  // an older client that omits the discriminator on a base64 source.
  const kind = source.type || (url ? "url" : data ? "base64" : "");

  if (kind === "url") {
    if (!url) {
      log("[OpenAIMessages] Dropping image block: error — url source carries no url");
      return null;
    }
    // Forwarded verbatim. OpenAI-shaped providers fetch the URL themselves; a
    // data: URL handed to us as a url source is equally valid here.
    return { type: "image_url", image_url: { url } };
  }

  if (kind === "base64") {
    if (!data) {
      log("[OpenAIMessages] Dropping image block: error — base64 source carries no data");
      return null;
    }
    const mediaType = typeof source.media_type === "string" ? source.media_type : "";
    if (!mediaType) {
      log("[OpenAIMessages] Dropping image block: error — base64 source carries no media_type");
      return null;
    }
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
  }

  log(`[OpenAIMessages] Dropping image block: error — unsupported source type ${kind || "(none)"}`);
  return null;
}

function processUserMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    const contentParts: any[] = [];
    const toolResults: any[] = [];
    // Images pulled out of tool_result content. OpenAI tool/function messages
    // cannot carry images, so we forward them as a following user message —
    // NOT JSON.stringify'd into the tool output (a screenshot's base64 there
    // becomes ~100k text tokens per image and blows the context window).
    const toolResultImages: any[] = [];
    const seen = new Set<string>();

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        if (!simpleFormat) {
          contentParts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (!simpleFormat) {
          const part = imageBlockToUrlPart(block);
          if (part) contentParts.push(part);
        }
        // Skip images in simple format - MLX doesn't support vision
      } else if (block.type === "tool_result") {
        if (seen.has(block.tool_use_id)) continue;
        seen.add(block.tool_use_id);

        // Split tool_result content into text (stays in the tool message) and
        // images (forwarded as a user message). String content passes through.
        let resultText: string;
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          const texts: string[] = [];
          const others: any[] = [];
          let droppedImages = 0;
          for (const inner of block.content) {
            if (inner.type === "text") {
              texts.push(inner.text);
            } else if (inner.type === "image" && inner.source) {
              // A dropped image must NOT be counted: `toolResultImages.length`
              // below decides whether the tool message points at a following
              // image message that would not exist.
              if (!simpleFormat) {
                const part = imageBlockToUrlPart(inner);
                if (part) toolResultImages.push(part);
                else droppedImages++;
              }
            } else {
              others.push(inner);
            }
          }
          resultText = texts.join("\n");
          if (others.length) resultText += (resultText ? "\n" : "") + JSON.stringify(others);
          // Tool/function messages must be non-empty; point at the forwarded image.
          // An image whose source could not be expressed leaves nothing to point
          // at, so the omission is named instead — otherwise a tool_result whose
          // only block was that image becomes an empty tool message.
          if (!resultText) {
            if (toolResultImages.length) resultText = "[image returned; see following message]";
            else if (droppedImages)
              resultText = "[image returned, but its source could not be forwarded]";
            else resultText = "";
          }
        } else {
          resultText = JSON.stringify(block.content);
        }

        if (simpleFormat) {
          // In simple format, include tool results as text in user message
          textParts.push(`[Tool Result]: ${resultText}`);
        } else {
          toolResults.push({
            role: "tool",
            content: resultText,
            tool_call_id: block.tool_use_id,
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just concatenate all text
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
    } else {
      if (toolResults.length) messages.push(...toolResults);
      // Images from tool results ride in their own user message, after the tool
      // outputs they came from (OpenAI requires tool messages to directly follow
      // the assistant tool_calls; a user image message may follow).
      if (toolResultImages.length) messages.push({ role: "user", content: toolResultImages });
      if (contentParts.length) messages.push({ role: "user", content: contentParts });
    }
  } else {
    messages.push({ role: "user", content: msg.content });
  }
}

function processAssistantMessage(msg: any, messages: any[], simpleFormat = false) {
  if (Array.isArray(msg.content)) {
    const strings: string[] = [];
    const toolCalls: any[] = [];
    const seen = new Set<string>();
    let reasoningContent = "";
    let hasThinking = false;

    for (const block of msg.content) {
      if (block.type === "text") {
        strings.push(block.text);
      } else if (block.type === "thinking") {
        // Accumulate thinking content to send back as reasoning_content.
        // Track presence regardless of content — Kimi K2.5 requires the field
        // even when the thinking text is empty.
        // Skip in simpleFormat (same as tool calls).
        if (!simpleFormat) {
          hasThinking = true;
          reasoningContent += block.thinking || "";
        }
      } else if (block.type === "tool_use") {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (simpleFormat) {
          // In simple format, include tool calls as text
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
    }

    if (simpleFormat) {
      // Simple format: just string content, no tool_calls
      if (strings.length) {
        messages.push({ role: "assistant", content: strings.join("\n") });
      }
    } else {
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      // Include reasoning_content whenever ANY thinking block was present,
      // even if the concatenated text is empty — Kimi K2.5 rejects turn 2+
      // with HTTP 400 if the field is missing after thinking was active.
      if (hasThinking) m.reasoning_content = reasoningContent;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    }
  } else {
    messages.push({ role: "assistant", content: msg.content });
  }
}
