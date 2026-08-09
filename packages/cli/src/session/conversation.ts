/**
 * conversation — the WHOLE main conversation of one transcript, streamed off disk.
 *
 * Everything else in `session-discovery.ts` is built on never reading a transcript in
 * full: the list comes from `stat` alone, and `hydrateSession` takes a 64 KB head and a
 * 128 KB tail with positioned reads so a 73 MB file costs the same as a 73 KB one. The
 * reader is the one surface that genuinely needs the middle, so it is the one place that
 * has to walk the file — and the scale that shaped those rules has not gone away.
 * MEASURED on this machine: 5,656 transcripts, 2.57 GB, the largest single file 73.5 MB.
 *
 * Four rules follow, and the whole module is shaped by them.
 *
 * 1. STREAM, NEVER SLURP. Fixed-size positioned reads into a REUSED buffer, decoded
 *    incrementally, split on newlines with the partial tail carried forward. Peak
 *    resident bytes from the file itself are one chunk (1 MB), not the file — MEASURED
 *    heap delta across the whole read of that 73.5 MB transcript: 15.5 MB, against the
 *    73.5 MB string a `readFileSync` would have had to hold before parsing anything.
 *
 * 2. PRE-FILTER BY SUBSTRING BEFORE `JSON.parse`. Prose is a small fraction of a
 *    transcript — tool results and file contents dominate — so parsing every line to
 *    throw nearly all of them away is the whole cost. MEASURED, same three transcripts,
 *    prefilter off → on:
 *
 *      73.5 MB   1,481 lines,   119 admitted (8.0%)   1,716 ms → 485 ms   (3.5x)
 *      68.1 MB   7,416 lines,    82 admitted (1.1%)   1,332 ms → 528 ms   (2.5x)
 *      47.1 MB   9,092 lines,   850 admitted (9.3%)     355 ms → 405 ms   (0.9x)
 *
 *    The third is the honest counter-example and worth keeping: at ~5 KB a line there is
 *    no giant tool result to skip, so the four substring scans cost slightly more than
 *    the parses they save. The prefilter is a large win where lines are huge and a rounding
 *    error where they are not, which is the right shape for a guard against the worst case.
 *    See `looksLikeTurn` for why the substring tests cannot produce a false positive on
 *    prose — verified exact against a parse-every-line reference over 60 transcripts >1 MB
 *    (10,567 turns, zero divergence in role, order or text).
 *
 * 3. BOUND WHAT IS RETAINED, AND SAY SO ON SCREEN. A transcript is unbounded; a reader's
 *    memory is not. Caps are applied per turn and in total, and both are REPORTED on the
 *    returned value so the UI can tell the user what it dropped instead of silently
 *    showing them a truncated conversation.
 *
 * 4. THE FILTER IS NOT REDEFINED HERE. What counts as a turn of the main conversation is
 *    `mainConversationTurn` in `session-discovery.ts`, shared with the picker's preview
 *    panel — so the reader and the preview can never disagree about whether a
 *    `<task-notification>` or a subagent turn is part of the conversation.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { displayWidth } from "../tui/viz/text.js";
import { mainConversationTurn } from "./session-discovery.js";

/** One turn, cleaned for display: paragraphs preserved, envelopes removed. */
export interface ReaderTurn {
  role: "user" | "assistant";
  text: string;
  /** True when this turn's own text hit `MAX_TURN_CHARS` and was elided. */
  elided: boolean;
}

/** The extracted conversation, plus what it cost and what it had to drop. */
export interface Conversation {
  turns: ReaderTurn[];
  /** Bytes of transcript walked. */
  bytes: number;
  /** Wall-clock milliseconds the extraction took. */
  elapsedMs: number;
  /** Characters of prose retained — the number the caps bound. */
  chars: number;
  /**
   * Turns dropped from the FRONT because the total cap was reached. Non-zero means the
   * reader is showing the tail of the conversation, and it must say so.
   */
  dropped: number;
  /** Whether any single turn was itself elided by `MAX_TURN_CHARS`. */
  anyElided: boolean;
}

/** Bytes read per positioned read. One of these is the module's peak file-derived cost. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * The per-turn character cap.
 *
 * A single turn is not usually large — but a user can paste a whole file into one, and an
 * assistant can emit a very long plan. 32 K characters is roughly 400 wrapped lines at 80
 * columns, which is already more than anyone scrolls through in one turn; past that the
 * turn is elided and SAYS it was, rather than quietly ending mid-sentence.
 */
export const MAX_TURN_CHARS = 32_000;

/**
 * The total retained-character cap, and WHICH END IT DROPS.
 *
 * MEASURED on the three largest transcripts on this machine, the extracted prose is
 * 0.04%, 0.30% and 0.93% of the file — the 73.5 MB one yields 32 KB, 112 turns — so this
 * cap is not reached by any real session here, and the promise "the turns are far smaller
 * than the file" is measured rather than assumed. It exists because "no real session
 * reaches it" is a property of today's corpus, not a guarantee, and an unbounded reader on
 * a file with no bound is a memory fault waiting for the transcript that finally hits it.
 *
 * When it IS reached the OLDEST turns go. The reader opens at the end of the conversation
 * — that is where a session you are deciding whether to resume actually is — and the
 * dropped count is rendered as a banner at the top of the transcript, so the truncation
 * is visible rather than inferred.
 */
export const MAX_TOTAL_CHARS = 8_000_000;

/**
 * Substring pre-filter: could this line possibly be a turn of the main conversation?
 *
 * FALSE POSITIVES ARE HARMLESS (the parse then rejects the record); FALSE NEGATIVES LOSE
 * A TURN. So every test below has to be safe against prose that merely talks about the
 * shape of a transcript — and this codebase's own transcripts do exactly that.
 *
 * The safety argument is JSON escaping, and it is exact: inside a JSON string every `"`
 * is written `\"`, so a RAW quote can only ever be structure. Every pattern here contains
 * raw quotes, therefore none of them can match text a human or a model wrote. `"a line
 * mentioning "isSidechain":true"` is impossible; the file would carry
 * `\"isSidechain\":true`.
 *
 * The four tests, in the order they pay for themselves:
 *
 *   - a turn is a `user` or an `assistant` record — nothing else is conversation;
 *   - `"isSidechain":true` is subagent traffic (the marker is written only when true);
 *   - `"isMeta":true` is a harness posting, likewise;
 *   - `"type":"tool_result"` is the harness answering the model. THIS IS THE BIG ONE:
 *     tool results carry file contents and command output, and they are most of the file.
 *
 * The last test is the one that pays for the assistant side: an assistant record with no
 * `"type":"text"` block holds only `tool_use` and/or `thinking`, so it carries no prose —
 * and a `Write` tool call embeds a whole file, which is why those lines are large. A
 * `user` record is exempt from it because a plain human prompt is a bare string
 * (`"content":"…"`) with no block types at all.
 */
function looksLikeTurn(line: string): boolean {
  const assistant = line.includes('"type":"assistant"');
  if (!assistant && !line.includes('"type":"user"')) return false;
  if (line.includes('"isSidechain":true')) return false;
  if (line.includes('"isMeta":true')) return false;
  if (line.includes('"type":"tool_result"')) return false;
  if (assistant && !line.includes('"type":"text"')) return false;
  return true;
}

/**
 * Envelopes that arrive INSIDE an otherwise real turn, rather than as a record of their
 * own — which is what `isHarnessNoise` already catches.
 *
 * Claude Code appends `<system-reminder>` blocks to the user's actual message on most
 * turns, and they are long: left in, they would be the majority of the text in the reader
 * and would dominate every search. Stripped as a BLOCK (open tag through close tag),
 * because the body is the part that has to go — the picker's `cleanPrompt` strips only
 * the tags and keeps the body, which is right for a one-line preview of a prompt and
 * wrong here.
 */
const INLINE_ENVELOPES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

/**
 * Clean a turn FOR READING — which is a different job from `cleanPrompt`.
 *
 * `cleanPrompt` collapses every run of whitespace to one space, because it feeds a
 * one-line preview. Here the paragraphs are the content: a plan, a numbered list and a
 * code block all become unreadable as one line. So newlines survive, runs of blank lines
 * collapse to one, trailing spaces go, and control characters are removed because a raw
 * `\t` or `\r` in a terminal cell moves the cursor rather than painting.
 */
export function cleanTurnText(raw: string): string {
  let t = raw;
  for (const re of INLINE_ENVELOPES) t = t.replace(re, "");
  // `<command-name>foo</command-name>` is the one envelope worth KEEPING the body of: it
  // is the slash command the user actually ran, which is the whole content of that turn.
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, "/$1");
  return t
    .replace(/\t/g, "  ")
    // Everything else in C0/C1: a raw ESC or \b in a terminal cell moves the cursor
    // instead of painting, which corrupts the frame rather than the line.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** How the caps are configured. Tests set them low; the app uses the defaults. */
export interface ReadOptions {
  maxTurnChars?: number;
  maxTotalChars?: number;
  chunkBytes?: number;
}

/**
 * Read every turn of the main conversation in `file`, oldest first.
 *
 * Never throws: an unreadable or vanished transcript comes back as an empty conversation,
 * which the reader renders as "no conversation recorded" — the same thing it shows for a
 * transcript that genuinely has none.
 */
export function readConversation(file: string, opts: ReadOptions = {}): Conversation {
  const maxTurn = opts.maxTurnChars ?? MAX_TURN_CHARS;
  const maxTotal = opts.maxTotalChars ?? MAX_TOTAL_CHARS;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const started = Date.now();

  const turns: ReaderTurn[] = [];
  let chars = 0;
  let dropped = 0;
  let anyElided = false;
  let bytes = 0;

  const take = (turn: ReaderTurn): void => {
    turns.push(turn);
    chars += turn.text.length;
    // Drop from the FRONT in one splice per overflow rather than one per turn: an
    // element-at-a-time `shift()` is O(n) each time and would turn the cap into a
    // quadratic cost exactly when the conversation is largest.
    if (chars <= maxTotal) return;
    let freed = 0;
    let n = 0;
    while (n < turns.length - 1 && chars - freed > maxTotal) {
      freed += turns[n]!.text.length;
      n++;
    }
    turns.splice(0, n);
    chars -= freed;
    dropped += n;
  };

  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(chunkBytes);
    const decoder = new StringDecoder("utf-8");
    let pending = "";
    let pos = 0;

    const consume = (line: string): void => {
      if (!line || !looksLikeTurn(line)) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // a truncated final line, or something that is not a record
      }
      if (!record || typeof record !== "object") return;
      const raw = mainConversationTurn(record);
      if (!raw) return;
      let text = cleanTurnText(raw.raw);
      if (!text) return;
      const elided = text.length > maxTurn;
      if (elided) {
        anyElided = true;
        text = `${text.slice(0, maxTurn)}\n\n… turn truncated at ${maxTurn.toLocaleString()} characters`;
      }
      take({ role: raw.role, text, elided });
    };

    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(chunkBytes, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      bytes += n;
      pending += decoder.write(buf.subarray(0, n));
      // Split here rather than accumulating: `pending` never holds more than one chunk
      // plus one partial line, which is the invariant that keeps this bounded.
      //
      // WALK WITH AN INDEX, AND RE-SLICE ONCE PER CHUNK. The obvious loop body
      // (`pending = pending.slice(nl + 1)`) copies the whole remaining chunk on every
      // line, which is quadratic in lines per chunk — MEASURED, it made the streamed
      // read SLOWER than parsing the entire file (4,640 ms against 3,496 ms over 60
      // transcripts). With the pointer the same set streams in 1,050 ms.
      let from = 0;
      let nl = pending.indexOf("\n", from);
      while (nl !== -1) {
        consume(pending.slice(from, nl));
        from = nl + 1;
        nl = pending.indexOf("\n", from);
      }
      if (from > 0) pending = pending.slice(from);
    }
    pending += decoder.end();
    if (pending) consume(pending);
  } catch {
    // Deleted mid-read, permissions, or a directory where a file was expected. Whatever
    // was extracted before the failure is still worth showing.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }

  return { turns, bytes, elapsedMs: Date.now() - started, chars, dropped, anyElided };
}

/** One wrapped line, as a half-open slice of the turn's text. */
export interface WrapSlice {
  start: number;
  end: number;
}

/**
 * Cost of one code point in terminal columns. ASCII is the fast path because prose is
 * overwhelmingly ASCII and this runs once per character of the whole conversation.
 */
function cpWidth(cp: number): number {
  if (cp >= 0x20 && cp < 0x7f) return 1;
  return displayWidth(String.fromCodePoint(cp));
}

/**
 * Word-wrap `text` to `width` columns, as OFFSETS rather than as strings.
 *
 * OFFSETS ARE THE POINT, and they are what makes search honest. Search runs over the
 * turn's whole contiguous text — that is the text the user believes they are searching —
 * so a hit is a character range in that text, and the only way to paint it is to know
 * which display line holds which range. Wrapping to strings loses that: a hit spanning a
 * line break becomes unfindable, and the match count on screen stops matching the
 * conversation. With `[start, end)` per line the hit is intersected with each line and
 * highlighted on both, and the count is the truth.
 *
 * A break at a space DROPS that space (`end` of one line is below `start` of the next), so
 * the reverse mapping is a containment test, never an assumption that the lines tile the
 * text. Explicit `\n` is honoured and an empty source line yields an empty display line —
 * paragraphs are the structure a reader is following.
 *
 * A word longer than `width` (a URL, a path) is broken mid-word rather than overflowing:
 * the alternative is a line wider than the panel, which Yoga clips silently.
 */
export function wrapOffsets(text: string, width: number): WrapSlice[] {
  const out: WrapSlice[] = [];
  const w = Math.max(1, Math.floor(width));
  const n = text.length;
  let paraStart = 0;
  for (;;) {
    let nl = text.indexOf("\n", paraStart);
    if (nl === -1) nl = n;
    let s = paraStart;
    for (;;) {
      if (s >= nl) {
        // An empty source line still occupies a display row; so does the tail of a
        // paragraph that ended exactly on a break.
        if (s === paraStart || paraStart === nl) out.push({ start: s, end: nl });
        break;
      }
      let cols = 0;
      let j = s;
      let lastSpace = -1;
      while (j < nl) {
        const cp = text.codePointAt(j)!;
        const size = cp > 0xffff ? 2 : 1;
        const cw = cpWidth(cp);
        if (cols + cw > w) break;
        // The FIRST space of a run, so a double space breaks before both and the
        // emitted line carries no trailing blank — `"word  double"` at 12 columns wrapped
        // to `"word "` when this recorded the last space instead.
        if (cp === 32 && j > s && text.charCodeAt(j - 1) !== 32) lastSpace = j;
        cols += cw;
        j += size;
      }
      if (j >= nl) {
        out.push({ start: s, end: nl });
        break;
      }
      // Stopping ON a space means the words before it fitted exactly — break there, not
      // at the previous space. Without this, `"hello world"` in exactly 11 columns wrapped
      // after `"hello"` and wasted five of them.
      const brk = text.charCodeAt(j) === 32 ? j : lastSpace > s ? lastSpace : j;
      out.push({ start: s, end: brk });
      s = brk === j && text.charCodeAt(j) !== 32 ? j : brk + 1;
      while (s < nl && text.charCodeAt(s) === 32) s++;
    }
    if (nl >= n) break;
    paraStart = nl + 1;
    if (paraStart > n) break;
    // A trailing newline ends the text; it does not open another empty line.
    if (paraStart === n) {
      out.push({ start: n, end: n });
      break;
    }
  }
  return out;
}
