/**
 * `claudish recovery-pane` — the five-line banner that earns claudish the right
 * to wait.
 *
 * PLAIN ANSI WITH RAW STDIN, NOT OpenTUI. This process exists to paint five
 * lines and read two keys. claudish already boots OpenTUI three times (config
 * TUI, probe TUI, resume picker) and a fourth boot for a banner is
 * disproportionate — it would pay a React reconciler and a renderer handshake
 * on the critical path of a user who is, by construction, already having a bad
 * minute. `team-grid.ts`'s self-contained banner is the established precedent
 * in this repo for exactly this shape.
 *
 * THEMING. `cliAnsi()` is called INSIDE `renderPane`, never at module load:
 * command modules are imported before theme detection runs, so a module-level
 * `const C = cliAnsi()` snapshots the pre-detection (dark) palette forever.
 * That bug class has been found six times in this codebase. The banner FILL is
 * additionally theme-independent by construction — a self-contained mid-dark
 * red with bright-white ink, the same pairing `team-grid.ts` uses — so the one
 * element that must be legible no matter what does not depend on detection
 * succeeding at all. (Measured: magmux DOES answer OSC 11 inside a pane, so
 * detection works; the banner does not rely on it.)
 *
 * WHY A PANE AND NOT AN OVERLAY. Keys typed here reach THIS process's own PTY,
 * not Claude Code's. That is the whole reason the recovery UI is a pane: it
 * dissolves the "how does a keystroke reach the proxy" question instead of
 * working around it. Focus is deliberately NOT stolen — Claude Code accepts
 * messages while a turn is in flight, and capturing those keystrokes into our
 * renderer would be a worse failure than one extra click.
 */

import { cliAnsi } from "../theme/ansi.js";
import { type RecoverySocketClient, connectRecoverySocket } from "./socket-client.js";
import {
  PANE_LINGER_MS,
  PROXY_SILENT_MS,
  RECOVERY_PROTOCOL_VERSION,
  type RecoveryClosedFrame,
  type RecoveryEpisodeFrame,
  UI_HEARTBEAT_MS,
} from "./types.js";

export interface PaneViewState {
  /** The episode being painted, or null before the first frame. */
  frame: RecoveryEpisodeFrame | null;
  /** Set once the episode ends; the pane lingers on this rather than vanishing. */
  closed: RecoveryClosedFrame | null;
  /** EPOCH ms — the same clock `nextAttemptAtMs` and `startedAtMs` are in. */
  nowMs: number;
  /** EPOCH ms of the last frame of any kind, or null. */
  lastFrameAtMs: number | null;
  connected: boolean;
  protocolMismatch: boolean;
  /** A transient line, e.g. after `[r]`. */
  notice: string | null;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

/**
 * Truncate to a VISIBLE width, stepping over the escapes.
 *
 * `String.length` counts an SGR escape as eight or nine characters and would
 * cut a line in the middle of one, leaving the rest of the pane painted in
 * whatever colour the fragment happened to start. A split pane is HALF the
 * terminal — measured: `split:"vertical"` took pane 0 from 40 rows to 20 — so
 * "the pane is always wide" is not an assumption this can make.
 */
/** The SGR sequence starting at `i` (`ESC [ … m`), or null. */
function matchSgr(text: string, i: number): string | null {
  if (text[i] !== "\x1b" || text[i + 1] !== "[") return null;
  let j = i + 2;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    const isParam = (c >= 0x30 && c <= 0x39) || c === 0x3b; // 0-9 ;
    if (!isParam) break;
    j++;
  }
  return text[j] === "m" ? text.slice(i, j + 1) : null;
}

/**
 * Drop every SGR sequence, leaving the text.
 *
 * Exported for the tests and for the evidence harness: assertions are about
 * what a person reads, and a capture full of escapes cannot be read by either.
 */
export function stripAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const m = matchSgr(text, i);
    if (m) {
      i += m.length - 1;
      continue;
    }
    out += text[i];
  }
  return out;
}

export function clipAnsi(text: string, width: number): string {
  let out = "";
  let visible = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      // ESC is the subject matter here, so the scan is written by hand rather
      // than as a regex: a regex literal containing the control character trips
      // `noControlCharactersInRegex`, and suppressing a lint rule to parse the
      // one thing this function exists to parse is worse than four lines of
      // explicit scanning.
      const m = matchSgr(text, i);
      if (m) {
        out += m;
        i += m.length - 1;
        continue;
      }
    }
    if (visible >= width) return `${out}\x1b[0m`;
    out += ch;
    visible++;
  }
  return out;
}

/** `2m 12s`, `47s`, `0s`. Never negative — a countdown that went past reads `0s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Greedy wrap. The reason sentence is the one thing that must stay readable. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
    } else if (line.length + 1 + w.length <= width) {
      line += ` ${w}`;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Build the banner. PURE — no clock, no terminal, no escape-code state.
 *
 * Pure because it is the only part of this process worth asserting on in a
 * unit test, and because the live evidence (a capture of the real pane) and the
 * test then look at the same function rather than at two implementations that
 * could drift.
 */
export function renderPane(state: PaneViewState, width: number): string {
  // RENDER TIME. Never at module load.
  const C = cliAnsi();
  const w = Math.max(28, Math.min(width || 80, 200));
  const RED_FILL = "\x1b[1;97;48;2;160;50;70m";
  const GREEN_FILL = "\x1b[1;97;48;2;30;120;70m";
  const lines: string[] = [];

  // Every return goes through `finish`, so there is ONE place the pane's width
  // is enforced and no later branch can forget it.
  const finish = (ls: string[]) => ls.map((l) => clipAnsi(l, w)).join("\n");

  if (state.protocolMismatch) {
    return finish([
      `${RED_FILL}${pad("  ██ CLAUDISH RECOVERY · version skew", w)}\x1b[0m`,
      `${C.GRAY}  This pane speaks protocol v${RECOVERY_PROTOCOL_VERSION}; the proxy does not.${C.RESET}`,
      `${C.GRAY}  Restart the session so both halves are the same build.${C.RESET}`,
      "",
    ]);
  }

  const ep = state.frame;
  const closed = state.closed;

  if (closed) {
    const ok = closed.outcome === "recovered";
    const fill = ok ? GREEN_FILL : RED_FILL;
    const title = ok
      ? `  ██ NETWORK · ${ep?.providerDisplayName ?? "provider"} recovered`
      : `  ██ NETWORK · recovery ended (${closed.outcome.replace(/_/g, " ")})`;
    lines.push(`${fill}${pad(title, w)}\x1b[0m`);
    if (ep) {
      lines.push(
        `${C.GRAY}  ${pad(`${ep.attempts} attempts over ${formatDuration(state.nowMs - ep.startedAtMs)}`, w - 2)}${C.RESET}`
      );
    }
    lines.push(`${C.GRAY}  this pane closes on its own${C.RESET}`);
    return finish(lines);
  }

  if (!ep) {
    lines.push(`${RED_FILL}${pad("  ██ NETWORK · claudish is retrying", w)}\x1b[0m`);
    lines.push(
      `${C.GRAY}  ${state.connected ? "waiting for the proxy to describe the failure…" : "connecting to the claudish proxy…"}${C.RESET}`
    );
    return finish(lines);
  }

  // 1 — the red line. Provider and the failure kind, in the fill that reads on
  // any page.
  const kindWord =
    ep.kind === "dns" ? "DNS failure" : ep.kind === "refused" ? "refused" : "unreachable";
  lines.push(`${RED_FILL}${pad(`  ██ NETWORK · ${ep.providerDisplayName} ${kindWord}`, w)}\x1b[0m`);

  // 2 — the reason, in `buildConnectionErrorMessage`'s OWN words. The same
  // sentence the inline 400 would have carried; if the two ever diverge the
  // user is being told two different stories about one fault.
  for (const l of wrapText(ep.reason, w - 4)) lines.push(`${C.STRONG}  ${l}${C.RESET}`);

  // 3 — host and code, as discrete tokens. The sentence above contains the host
  // too, but embedded in prose; this line is what a capture can be grepped for.
  lines.push(
    `${C.GRAY}  host ${C.RESET}${C.CYAN}${ep.host}${C.RESET}${C.GRAY} · ${ep.code ?? "no code"}${
      ep.loopback ? " · local" : ""
    }${C.RESET}`
  );

  // 4 — the live line. A countdown while waiting; what we are doing instead
  // while an attempt is actually in flight, because a frozen countdown during a
  // 45-second connect reads as a hang.
  const elapsed = formatDuration(state.nowMs - ep.startedAtMs);
  const when =
    ep.state === "waiting" && ep.nextAttemptAtMs !== null
      ? `${C.YELLOW}next attempt in ${formatDuration(ep.nextAttemptAtMs - state.nowMs)}${C.RESET}`
      : ep.state === "handoff"
        ? `${C.YELLOW}waiting for Claude Code to retry${C.RESET}`
        : `${C.YELLOW}connecting to ${ep.host}…${C.RESET}`;
  const tierNote = ep.tier === 2 ? ` · client retry ${ep.clientRetries}` : "";
  lines.push(
    `  ${when}${C.GRAY} · attempt ${ep.attempts} · ${elapsed} in recovery${tierNote}${C.RESET}`
  );

  // 5 — last outcome and the other-episode count.
  const others = ep.otherEpisodes > 0 ? ` · +${ep.otherEpisodes} more` : "";
  const waiters = ep.waiters === 1 ? "1 request held" : `${ep.waiters} requests held`;
  lines.push(`${C.GRAY}  last: ${ep.lastOutcome} · ${waiters}${others}${C.RESET}`);

  // 6 — the keys. The click instruction is not decoration: magmux forwards
  // mouse clicks to focus a pane, and focus is not stolen — so "click, then
  // press" is the actual interaction and the banner has to say so.
  //
  // A `split` pane is HALF the terminal (measured: 40 rows became 20 and 19),
  // and a user with a narrow window gets a narrow pane. Below 64 columns the
  // full sentence wraps or is cut, so the hint sheds the part a user can work
  // out — where to click — and keeps the part they cannot: which keys exist.
  //
  // `[r]` IS HIDDEN IN `handoff`, because in that state it does nothing:
  // `tryNow` returns early when no attempt timer is armed, and a handed-off
  // episode has no waiters and therefore no timer. Advertising a key that
  // prints "retrying now…" over an episode nobody is retrying is the same
  // class of defect as a give-up that does not give up — a control that
  // appears to act and does not.
  const keys =
    ep.state === "handoff"
      ? `${C.BOLD}[q]${C.RESET} give up`
      : `${C.BOLD}[r]${C.RESET} try now${C.GRAY} · ${C.RESET}${C.BOLD}[q]${C.RESET} give up`;
  lines.push(
    w < 64
      ? `${C.GRAY}  ${C.RESET}${keys}`
      : `${C.GRAY}  click here or Ctrl-G Tab, then ${C.RESET}${keys}`
  );

  if (state.notice) lines.push(`${C.GREEN}  ${state.notice}${C.RESET}`);

  // The dead-proxy notice. Frame silence is the heuristic, which is exactly why
  // the proxy ticks in EVERY live state — a 45-second connect used to look
  // identical to a dead proxy.
  if (
    state.lastFrameAtMs !== null &&
    state.nowMs - state.lastFrameAtMs > PROXY_SILENT_MS &&
    state.connected
  ) {
    lines.push(
      `${C.RED}  the claudish proxy has not reported in ${formatDuration(state.nowMs - state.lastFrameAtMs)}${C.RESET}`
    );
  }
  if (!state.connected) {
    lines.push(`${C.RED}  the claudish proxy closed this connection${C.RESET}`);
  }

  return finish(lines);
}

export interface RecoveryPaneOptions {
  socketPath: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** EPOCH ms. Injectable so a test can drive the countdown deterministically. */
  now?: () => number;
  /** Stop after this long with no live episode. Tests pass something small. */
  lingerMs?: number;
}

/** Parse `--socket <path>` out of a recovery-pane argv slice. */
export function parsePaneArgs(argv: string[]): { socketPath: string | null } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--socket" && argv[i + 1]) return { socketPath: argv[i + 1] as string };
    if (a?.startsWith("--socket=")) return { socketPath: a.slice("--socket=".length) };
  }
  return { socketPath: null };
}

/**
 * Run the pane until the user quits, the episode ends and the linger expires,
 * or the proxy goes away. Resolves with the process exit code.
 */
export async function runRecoveryPane(opts: RecoveryPaneOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const now = opts.now ?? (() => Date.now());
  const lingerMs = opts.lingerMs ?? PANE_LINGER_MS;

  const state: PaneViewState = {
    frame: null,
    closed: null,
    nowMs: now(),
    lastFrameAtMs: null,
    connected: true,
    protocolMismatch: false,
    notice: null,
  };

  let noticeUntilMs = 0;
  let closedAtMs: number | null = null;
  /** The episode this renderer is heartbeating. Exactly one at a time. */
  let paintedEpisodeId: string | null = null;
  let client: RecoverySocketClient | null = null;

  const paint = () => {
    state.nowMs = now();
    if (state.notice && state.nowMs > noticeUntilMs) state.notice = null;
    const width = stdout.columns ?? 80;
    const body = renderPane(state, width);
    // Home, repaint each line clearing to EOL, then clear the rest. No
    // alternate screen: the pane's content stays in magmux's scrollback, which
    // is where a user looks after the fact to find out what happened.
    const painted = body.split("\n").join("\x1b[K\n");
    stdout.write(`\x1b[H${painted}\x1b[K\x1b[J`);

    // THE LEASE. Sent after painting, and on this timer rather than on frame
    // arrival — the proxy has nothing to say for the 20–75 s an unreachable
    // connect takes, and a lease renewed by frames would expire in exactly the
    // failure class this feature exists for.
    if (paintedEpisodeId && client?.connected) {
      client.send({
        v: RECOVERY_PROTOCOL_VERSION,
        type: "ack",
        episodeId: paintedEpisodeId,
        paintedAt: state.nowMs,
      });
    }
  };

  stdout.write("\x1b[?25l"); // hide the cursor; there is nothing to type into
  const restore = () => {
    try {
      stdout.write("\x1b[?25h\n");
      stdin.setRawMode?.(false);
      stdin.pause();
    } catch {
      /* the terminal went away first */
    }
  };

  client = await connectRecoverySocket({
    socketPath: opts.socketPath,
    onFrame: (frame) => {
      state.lastFrameAtMs = now();
      if (frame.type === "closed") {
        if (frame.outcome === "protocol_mismatch") {
          state.protocolMismatch = true;
          paint();
          return;
        }
        if (!state.frame || frame.episodeId === state.frame.episodeId) {
          state.closed = frame;
          closedAtMs = now();
          // Stop heartbeating: this episode is over, and a lease that outlived
          // its episode is the latch this design replaced.
          paintedEpisodeId = null;
        }
        paint();
        return;
      }
      // A new episode supersedes the old one. The renderer heartbeats exactly
      // one episode; the previous one's lease lapses on its own within
      // UI_LEASE_MS with no extra protocol.
      state.frame = frame;
      state.closed = null;
      closedAtMs = null;
      paintedEpisodeId = frame.episodeId;
      paint();
    },
    onClose: () => {
      state.connected = false;
      paint();
    },
  });

  if (!client) {
    state.connected = false;
    paint();
    restore();
    return 1;
  }

  let done: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    done = resolve;
  });

  // Raw stdin: the pane's two keys must not need a newline, and the terminal
  // must not echo them into the banner.
  try {
    stdin.setRawMode?.(true);
  } catch {
    /* not a TTY — the banner still renders, the keys simply do nothing */
  }
  // Outside the try: a stdin that cannot go raw can still deliver bytes, and
  // resume() is also what keeps this process's event loop alive.
  stdin.resume();
  stdin.on("data", (buf: Buffer) => {
    const s = buf.toString("utf-8");
    for (const ch of s) {
      if (ch === "\x03") {
        // Ctrl-C in this pane means the same as [q]: the user asked to stop.
        client?.send({ v: RECOVERY_PROTOCOL_VERSION, type: "bye", reason: "user_quit" });
        restore();
        done(0);
        return;
      }
      if (ch === "q" || ch === "Q") {
        client?.send({ v: RECOVERY_PROTOCOL_VERSION, type: "bye", reason: "user_quit" });
        restore();
        done(0);
        return;
      }
      if (ch === "r" || ch === "R" || ch === "\r" || ch === "\n") {
        // Not in `handoff`: there is no armed timer to collapse there, so the
        // key would only print a reassurance that is not true. The banner hides
        // it in that state too — one rule, both places.
        if (state.frame && state.frame.state !== "handoff" && client?.connected) {
          client.send({
            v: RECOVERY_PROTOCOL_VERSION,
            type: "retry_now",
            episodeId: state.frame.episodeId,
          });
          state.notice = "retrying now…";
          noticeUntilMs = now() + 3_000;
          paint();
        }
      }
    }
  });

  // ONE timer drives both the countdown and the heartbeat, at UI_HEARTBEAT_MS.
  // They are the same act — "I am still painting this episode" — and splitting
  // them into two timers would let a frozen renderer keep its lease.
  const ticker = setInterval(() => {
    paint();
    if (closedAtMs !== null && now() - closedAtMs > lingerMs) {
      restore();
      done(0);
    }
    if (!state.connected && client && !client.connected) {
      // The proxy is gone. Linger briefly so the last state is readable, then
      // leave rather than sitting on a dead socket forever.
      if (closedAtMs === null) closedAtMs = now();
    }
  }, UI_HEARTBEAT_MS);
  ticker.unref?.();

  paint();
  const code = await finished;
  clearInterval(ticker);
  client.close();
  return code;
}

/** The `claudish recovery-pane` entry point. */
export async function recoveryPaneCommand(argv: string[]): Promise<void> {
  const { socketPath } = parsePaneArgs(argv);
  if (!socketPath) {
    console.error("Usage: claudish recovery-pane --socket <path>");
    process.exit(2);
  }
  // The pane is its own PROCESS, reached from `index.ts` before `runCli()`, so
  // nothing has published a theme mode for it. `cliAnsi()` is read at paint
  // time — which is right, and which the module-load snapshot trap makes
  // necessary — but it cannot use a mode that was never detected, so the pane
  // stayed on the unknown/classic palette even where OSC 11, `COLORFGBG` or an
  // explicit `CLAUDISH_THEME=light` would have chosen the light one.
  //
  // It runs HERE rather than inside `runRecoveryPane` for the same reason the
  // TUI runs it before `createCliRenderer`: the OSC query puts stdin in raw
  // mode and reads it, so it must finish before the pane's own key handler
  // owns the stream. Bounded at 150 ms, a no-op without a TTY on both ends, and
  // never fatal — a banner with the wrong palette still beats no banner.
  try {
    const { detectAndSetThemeMode } = await import("../theme/theme-mode.js");
    await detectAndSetThemeMode();
  } catch {
    /* the classic palette is a working fallback */
  }
  const code = await runRecoveryPane({ socketPath });
  process.exit(code);
}
