/**
 * session-discovery — find resumable Claude Code sessions, grouped by worktree.
 *
 * Claude Code stores one JSONL transcript per session at
 * `~/.claude/projects/<slugged-cwd>/<session-uuid>.jsonl`. The FILENAME is the id
 * `claude --resume` takes, so nothing here has to parse a file to know what to resume.
 *
 * SCALE IS THE DESIGN CONSTRAINT, and it is not hypothetical. MEASURED on this machine:
 * 5,656 transcripts across 219 project directories, 2.57 GB in total, the largest single
 * file 73.5 MB. Reading transcripts to build a list is therefore off the table — it
 * would be gigabytes of I/O to draw one screen. Two rules follow, and everything below
 * is shaped by them:
 *
 *   1. THE LIST IS BUILT FROM DIRECTORY NAMES AND `stat` ALONE. Grouping, worktree
 *      identity and recency all come from the path and the mtime, so opening a
 *      transcript is never on the path to a rendered row.
 *   2. DETAIL IS HYDRATED LAZILY, AND ONLY IN BOUNDED CHUNKS. `hydrateSession` reads a
 *      64 KB head and a 128 KB tail with positioned reads — never the middle, never the
 *      whole file — so a 73 MB transcript costs the same as a 73 KB one.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Where Claude Code keeps transcripts. */
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Claude Code's directory name for a working directory: every `/` and `.` becomes `-`.
 * MEASURED against real directories — `/Users/jack/mag/claudish/.claude/worktrees/x`
 * becomes `-Users-jack-mag-claudish--claude-worktrees-x`, the doubled dash being the
 * `/` and the `.` of `/.claude` in sequence.
 *
 * The mapping is deliberately NOT inverted anywhere in this file. It is lossy — a `-`
 * in the slug could have been `/`, `.` or a literal `-` — so un-slugging a path would
 * guess. Every real path here comes from git or from the caller instead.
 */
export function slugForPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

/** A resumable session. Fields below `sizeBytes` are absent until `hydrateSession`. */
export interface SessionRow {
  /** The UUID `claude --resume` accepts. Taken from the filename. */
  id: string;
  file: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Claude Code's own generated title, the single best label for a session. */
  title?: string;
  /** The opening user prompt, cleaned of slash-command envelopes. */
  firstPrompt?: string;
  gitBranch?: string;
  /** Display columns of the final user message — "how big was the last thing I said". */
  lastMessageChars?: number;
  hydrated?: boolean;
}

/** One worktree (or the repo root) and every session recorded inside it. */
export interface WorktreeGroup {
  /** Worktree name, or `(root)` for the main checkout. */
  name: string;
  /** Absolute path when known from git; null for a worktree that has been deleted. */
  path: string | null;
  /** Whether git still lists this worktree. Sessions outlive their worktree. */
  live: boolean;
  /** Whether this is the worktree claudish is running in. */
  current: boolean;
  sessions: SessionRow[];
  /** mtime of the most recent session in the group. */
  lastActiveMs: number;
}

export interface RepoContext {
  /** The main checkout's absolute path. */
  root: string;
  /** The worktree cwd currently sits in (may equal `root`). */
  current: string;
  /** Absolute paths of every worktree git still knows about, including `root`. */
  liveWorktrees: string[];
}

/**
 * Locate the repository and its live worktrees.
 *
 * `--git-common-dir` is what distinguishes the main checkout from a worktree: inside a
 * worktree `--show-toplevel` is the worktree itself, while the common dir still points
 * at the parent's `.git`. Returns null outside a repository, which is a normal
 * condition (the picker then falls back to every project directory).
 */
export function getRepoContext(cwd: string = process.cwd()): RepoContext | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const current = git(["rev-parse", "--show-toplevel"]);
  const commonDir = git(["rev-parse", "--git-common-dir"]);
  if (!current || !commonDir) return null;

  // `--git-common-dir` answers an absolute `/repo/.git` from a worktree and a bare
  // `.git` from the main checkout, so only the absolute form identifies the root.
  const root = commonDir.endsWith("/.git")
    ? commonDir.slice(0, -"/.git".length)
    : current;

  const liveWorktrees: string[] = [];
  const porcelain = git(["worktree", "list", "--porcelain"]);
  if (porcelain) {
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) liveWorktrees.push(line.slice("worktree ".length));
    }
  }
  return { root, current, liveWorktrees };
}

/** `~/.claude/projects` entries, or `[]` when the directory does not exist yet. */
function projectDirs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Transcript files in one project directory, as `stat`-only rows. */
function sessionsIn(dirName: string): SessionRow[] {
  const dir = join(PROJECTS_DIR, dirName);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const n of names) {
    const file = join(dir, n);
    try {
      const st = statSync(file);
      // A zero-byte transcript is a session that died before writing anything; it
      // cannot be resumed into anything meaningful, so it is not offered.
      if (st.size === 0) continue;
      rows.push({ id: basename(n, ".jsonl"), file, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {
      // Raced with a delete. Skip.
    }
  }
  return rows;
}

/** True when `p` is `root` itself or lives beneath it. Path-segment aware, so
 * `/repo-old` is NOT under `/repo` — the exact confusion the slug cannot avoid. */
function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/**
 * The absolute `cwd` a project directory's sessions ran in, read from a transcript.
 *
 * Claude Code records `cwd` on most records, so the head of any one transcript settles
 * what the lossy slug cannot: whether `-Users-j-mag-claudish-old` is this repo's
 * `old/` subdirectory or a different checkout called `claudish-old`.
 *
 * Deliberately called ONLY for the ambiguous case — a directory whose slug extends the
 * root's with no worktree marker. Doing it for all 219 project directories on this
 * machine would put ~200 file opens on the picker's startup path to answer a question
 * git has already answered for every case that matters.
 *
 * The known gap, stated rather than hidden: a DELETED worktree that lived outside the
 * root is invisible — git no longer lists it and its slug does not extend the root's, so
 * nothing points at it. Finding those would cost the full scan this avoids.
 */
function readProjectCwd(dirName: string): string | null {
  const rows = sessionsIn(dirName);
  if (rows.length === 0) return null;
  // Newest first: an old transcript may predate a directory move.
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const row of rows.slice(0, 2)) {
    for (const r of parseRecords(readChunk(row.file, 0, Math.min(HEAD_BYTES, row.sizeBytes)), false)) {
      if (typeof r.cwd === "string" && r.cwd) return r.cwd;
    }
  }
  return null;
}

/**
 * A session is treated as LIVE when its transcript was touched within this window.
 *
 * Claude Code appends continuously while a session is open — mode lines, snapshots and
 * titles land alongside messages — so a recent mtime is a good liveness proxy and the
 * only one available without inspecting processes. 120s is deliberately generous: the
 * cost of calling a finished session "active" is a misleading dot, while the cost of
 * calling a live one dead is offering to resume a session that is currently writing,
 * which is the genuinely damaging mistake.
 */
export const ACTIVE_WINDOW_MS = 120_000;

export function isActive(row: SessionRow, now = Date.now()): boolean {
  return now - row.mtimeMs < ACTIVE_WINDOW_MS;
}

/**
 * Group every session belonging to `repo` by worktree.
 *
 * Assignment is by LONGEST MATCHING SLUG PREFIX against the known worktree paths, which
 * is what correctly folds a session started in a subdirectory back into its worktree:
 * `…-worktrees-gemini-fix-packages-cli` is a session run from `packages/cli` inside the
 * `gemini-fix` worktree, not a worktree called `gemini-fix-packages-cli`. Matching
 * shortest-first would put it in its own phantom group, and splitting the slug on `-`
 * cannot work at all because worktree names contain dashes.
 *
 * Worktrees git no longer lists still appear, marked `live: false`. Their transcripts
 * remain on disk and remain resumable, and hiding them would silently drop history.
 */
export function discoverWorktreeGroups(repo: RepoContext): WorktreeGroup[] {
  const rootSlug = slugForPath(repo.root);
  // EVERY project directory is considered, not just those whose slug starts with the
  // root's. A slug-prefix filter is wrong in both directions, because the slug is lossy:
  //   - it ADMITS a foreign sibling — `/Users/j/mag/claudish-old` slugs to
  //     `-Users-j-mag-claudish-old`, which prefix-matches the root just as a real
  //     subdirectory would, so another project's sessions get listed as resumable here;
  //   - it DROPS a legitimate worktree created outside the root, which
  //     `git worktree add ../repo-feature` does by default — git knows about it, the
  //     prefix test does not, and it never reaches the picker at all.
  // Ownership is decided below against git's own worktree list and, where that cannot
  // settle it, against the transcript's recorded `cwd`.
  const mine = projectDirs();

  // Longest first so the most specific worktree claims a directory before the root does.
  const known = [...repo.liveWorktrees]
    .map((p) => ({ path: p, slug: slugForPath(p) }))
    .sort((a, b) => b.slug.length - a.slug.length);

  const groups = new Map<string, WorktreeGroup>();
  /**
   * Group name → the absolute `cwd` its sessions recorded, for the dead-worktree fold
   * below. Populated lazily and only for groups with no live path, since that is the
   * only case the fold has to adjudicate.
   */
  const groupCwd = new Map<string, string>();
  const upsert = (name: string, path: string | null, live: boolean): WorktreeGroup => {
    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        path,
        live,
        current: path !== null && path === repo.current,
        sessions: [],
        lastActiveMs: 0,
      };
      groups.set(name, g);
    }
    return g;
  };

  const WORKTREE_MARK = "--claude-worktrees-";
  // The root's slug is a prefix of EVERY worktree directory under it
  // (`-Users-jack-mag-claudish` prefixes `-Users-jack-mag-claudish--claude-worktrees-x`),
  // so the root must never win a prefix match — it would swallow every worktree whose
  // directory no live worktree claims. MEASURED before this exclusion: 43 project
  // directories collapsed into 6 groups, with 1,471 sessions wrongly filed under
  // `(root)`. Worktree ownership is therefore decided by the MARKER first, and the
  // root only claims directories that have no marker at all.
  const worktreeMatches = known.filter((k) => k.path !== repo.root);

  for (const dir of mine) {
    const at = dir.indexOf(WORKTREE_MARK);
    let name: string;
    let path: string | null;
    let live: boolean;

    // 1. A worktree git currently lists, matched on its REAL path's slug. This is the
    //    only branch that can see a worktree living outside the root.
    const hit = worktreeMatches.find((k) => dir === k.slug || dir.startsWith(`${k.slug}-`));
    if (hit) {
      path = hit.path;
      live = true;
      name = hit.path === repo.root ? "(root)" : basename(hit.path);
    } else if (at !== -1 && dir.startsWith(rootSlug)) {
      // 2. A worktree git no longer lists, nested under this root. Its transcripts
      //    survive and stay resumable, so it keeps a group. Un-slugging is lossy, so a
      //    deleted worktree's subdirectory sessions may carry a suffix in the heading
      //    rather than being silently merged or dropped.
      path = null;
      live = false;
      name = dir.slice(at + WORKTREE_MARK.length);
    } else if (dir === rootSlug) {
      // 3. The main checkout itself.
      name = "(root)";
      path = repo.root;
      live = true;
    } else if (dir.startsWith(`${rootSlug}-`) && at === -1) {
      // 4. AMBIGUOUS: the slug extends the root's, with no worktree marker. That is
      //    either a subdirectory of this repo (`<root>/packages/cli`) or a different
      //    project whose name merely starts the same way (`<root>-old`, `<root>.bak` —
      //    `.` slugs to `-` too). The slug cannot tell them apart, so ask the
      //    transcript, which records the absolute `cwd` it ran in.
      const cwd = readProjectCwd(dir);
      if (!cwd || !isUnder(cwd, repo.root)) continue; // a foreign sibling — not ours
      name = "(root)";
      path = repo.root;
      live = true;
    } else {
      // Belongs to some other repository entirely.
      continue;
    }

    const g = upsert(name, path, live);
    if (path) groupCwd.set(name, path);
    else if (!groupCwd.has(name)) {
      const cwd = readProjectCwd(dir);
      if (cwd) groupCwd.set(name, cwd);
    }
    for (const s of sessionsIn(dir)) {
      g.sessions.push(s);
      if (s.mtimeMs > g.lastActiveMs) g.lastActiveMs = s.mtimeMs;
    }
  }

  // Fold a deleted worktree's subdirectory groups back into the worktree itself.
  //
  // A live worktree gets this free from the prefix match against its real path, but a
  // deleted one has no path to match, so `mcp-failed-auth` and
  // `mcp-failed-auth-packages-cli` arrive as two headings for one worktree. Names are
  // all we have, so the fold is name-based: a group merges into the LONGEST other group
  // whose name it extends with a `-`. That rule cannot merge two genuinely different
  // worktrees, because a worktree named `foo-bar` only absorbs `foo-bar-<something>`,
  // and if a real worktree `foo-bar-baz` also exists it is itself a group and wins by
  // being longer.
  const names = [...groups.keys()].sort((a, b) => b.length - a.length);
  for (const name of [...groups.keys()]) {
    const g = groups.get(name);
    if (!g || g.live) continue;
    const parent = names.find((n) => n !== name && name.startsWith(`${n}-`) && groups.has(n));
    if (!parent) continue;
    const into = groups.get(parent)!;

    // NAME SHAPE IS NOT ENOUGH — confirm the descent against the recorded `cwd`.
    //
    // The name test cannot tell "a subdirectory of worktree X" from "a sibling worktree
    // called X-something". For LIVE worktrees git settles it, but two DEAD siblings both
    // reach here: worktrees `resume` and `resume-message` under one root would see
    // `resume-message` folded into `resume`, losing its heading and filing its sessions
    // under an unrelated worktree — the "silently drop history" outcome this pass exists
    // to avoid. So the transcripts decide: fold only when the child really did run
    // beneath the parent.
    const childCwd = groupCwd.get(name);
    const parentCwd = groupCwd.get(parent);
    if (!childCwd || !parentCwd || !isUnder(childCwd, parentCwd)) continue;

    into.sessions.push(...g.sessions);
    into.lastActiveMs = Math.max(into.lastActiveMs, g.lastActiveMs);
    groups.delete(name);
  }

  for (const g of groups.values()) g.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Current worktree first, then most recently active. The current worktree is almost
  // always what the user means, and making them hunt for it would defeat the point.
  return [...groups.values()]
    .filter((g) => g.sessions.length > 0)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return b.lastActiveMs - a.lastActiveMs;
    });
}

// ---------------------------------------------------------------------------
// Lazy hydration — bounded reads only
// ---------------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;

/** Read up to `len` bytes at `pos`. Returns "" on any I/O failure. */
function readChunk(file: string, pos: number, len: number): string {
  if (len <= 0) return "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, pos);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Parse the complete JSONL records in a chunk, discarding partial edge lines. */
function parseRecords(chunk: string, dropFirstPartial: boolean): Record<string, unknown>[] {
  const lines = chunk.split("\n");
  // A tail chunk almost always begins mid-record, and a head chunk almost always ends
  // mid-record. Dropping the affected edge is why a bounded read is safe at all.
  if (dropFirstPartial) lines.shift();
  else lines.pop();
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object") out.push(o);
    } catch {
      /* truncated or not a record */
    }
  }
  return out;
}

/** Flatten Claude Code's string-or-blocks message content to plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
    .join(" ");
}

/**
 * Strip the envelopes Claude Code wraps around slash commands and hook output, so a
 * session invoked as `/investigate` previews as its actual prompt rather than as
 * `<command-message>investigate</command-message><command-name>…`.
 */
function cleanPrompt(text: string): string {
  return text
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, " ")
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, " ")
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fill in a row's title, opening prompt, branch and last-message size.
 *
 * Idempotent and cheap to call from a render path: it returns immediately once
 * `hydrated` is set, and touches at most 192 KB regardless of transcript size.
 */
export function hydrateSession(row: SessionRow): SessionRow {
  if (row.hydrated) return row;
  row.hydrated = true;

  // Re-stat a LIVE session before reading its tail. `sizeBytes` was captured during the
  // list pass, and a session that is still appending — exactly the ones the picker marks
  // with a green dot, and the most likely thing a user picks — will have grown since.
  // Using the stale size aims the tail window at the middle of the file, so the "current"
  // title and last message come from an older part of it, or from nothing at all if it
  // grew by more than TAIL_BYTES.
  if (isActive(row)) {
    try {
      row.sizeBytes = statSync(row.file).size;
    } catch {
      // Deleted mid-scan; the bounded reads below cope with a stale size.
    }
  }

  const head = parseRecords(readChunk(row.file, 0, Math.min(HEAD_BYTES, row.sizeBytes)), false);
  for (const r of head) {
    if (!row.gitBranch && typeof r.gitBranch === "string") row.gitBranch = r.gitBranch;
    if (!row.firstPrompt && r.type === "user" && !r.isMeta) {
      const t = cleanPrompt(contentText((r.message as any)?.content));
      if (t) row.firstPrompt = t;
    }
    if (row.gitBranch && row.firstPrompt) break;
  }

  // The title is regenerated as a session evolves, so the LAST `ai-title` is the current
  // one — hence reading the tail rather than the head for it.
  const tailStart = Math.max(0, row.sizeBytes - TAIL_BYTES);
  const tail = parseRecords(readChunk(row.file, tailStart, row.sizeBytes - tailStart), tailStart > 0);
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i]!;
    if (!row.title && r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) {
      row.title = r.aiTitle.trim();
    }
    if (row.lastMessageChars === undefined && r.type === "user" && !r.isMeta) {
      const t = cleanPrompt(contentText((r.message as any)?.content));
      if (t) row.lastMessageChars = t.length;
    }
    if (row.title && row.lastMessageChars !== undefined) break;
  }
  return row;
}

/** The best label available for a row: its title, else its opening prompt, else its id. */
export function sessionLabel(row: SessionRow): string {
  return row.title || row.firstPrompt || row.id;
}

/**
 * The newest transcript for `cwd` — the session that just ended.
 *
 * This is how the end-of-session summary learns the id to print in its resume command
 * without claudish having to parse the child's stdout. Newest-by-mtime is exact here
 * because the summary runs moments after the child exited, so the session it just ran
 * is necessarily the most recently written transcript for that directory.
 */
export function findLatestSessionId(
  cwd: string = process.cwd(),
  sinceMs = 0
): string | null {
  // `sinceMs` bounds the guess to transcripts touched during THIS session.
  //
  // Newest-by-mtime is only "necessarily" the session that just ran when one session
  // owns the directory. A second terminal in the same cwd, a `team` run or an MCP
  // channel child all write here too and any of them can be the most recently touched
  // at the moment claudish exits — which would print a resume command naming someone
  // else's conversation, as a line the user is invited to paste. Filtering by the
  // proxy's start time cannot make the guess right, but it does make it fail closed:
  // when nothing in this directory was written during the session, the answer is null
  // and the card prints no resume line at all.
  const rows = sessionsIn(slugForPath(cwd)).filter((r) => r.mtimeMs >= sinceMs);
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).id;
}
