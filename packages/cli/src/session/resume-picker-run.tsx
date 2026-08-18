/** @jsxImportSource @opentui/react */
/**
 * resume-picker-run — bootstrap for the resume picker.
 *
 * This is the one place `@opentui/core` and `@opentui/react` meet: `createCliRenderer`
 * from core, `createRoot` from the React binding, as function calls. It is imported
 * DYNAMICALLY from `index.ts`, so a normal run never loads OpenTUI at all.
 *
 * TWO DELIBERATE DEPARTURES FROM THE SKILL'S STOCK BOOTSTRAP, both forced by facts on
 * the ground rather than preference:
 *
 * 1. `screenMode: "alternate-screen"`, NOT `useAlternateScreen: true`. The installed
 *    `@opentui/core@0.1.107` renamed the option: `renderer.d.ts` declares
 *    `screenMode?: ScreenMode` and no longer has `useAlternateScreen` (the 0.1.87
 *    spelling this file previously pinned by measurement). Passing the old key would be
 *    an unknown key, silently ignored, and the picker would draw over the user's
 *    scrollback instead of taking its own screen. claudish pins 0.1.x on purpose
 *    (`build:binary` compiles a standalone binary).
 *
 * 2. `installShutdown` is NOT used, even though it ships beside this file. Its contract
 *    ends in `process.exit(code)` — correct for an app whose quit key means "quit", and
 *    wrong for a picker, whose whole job is to hand a session id back to a caller that
 *    then goes on to launch Claude Code. Its guarantee (never leave the terminal wedged
 *    in raw mode inside the alternate screen) is what matters, and that is provided here
 *    by a `finally` that always unmounts then destroys, in that order — React first, so
 *    no component can render into a dead renderer. The picker is also short-lived and
 *    runs before claudish installs its own child-process signal handling, so owning
 *    SIGINT/SIGTERM here would fight the very handlers that manage the session it is
 *    about to start.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { setStderrQuiet } from "../logger.js";
import { ResumePicker } from "./resume-picker.js";
import { discoverWorktreeGroups, enrichWorktreeGit, getRepoContext } from "./session-discovery.js";

export interface PickerOutcome {
  /** Session id the user chose, or null when they cancelled. */
  sessionId: string | null;
  /** False when there was nothing to choose from — the caller explains, not the picker. */
  hadSessions: boolean;
}

/**
 * Show the picker and resolve with the user's choice.
 *
 * Returns `hadSessions: false` without drawing anything when the repository has no
 * recorded sessions, so the caller can print a one-line explanation instead of opening
 * an empty full-screen UI the user then has to escape from.
 */
export async function runResumePicker(cwd: string = process.cwd()): Promise<PickerOutcome> {
  const repo = getRepoContext(cwd);
  if (!repo) return { sessionId: null, hadSessions: false };

  const groups = discoverWorktreeGroups(repo);
  if (groups.length === 0) return { sessionId: null, hadSessions: false };

  // Branch state BEFORE the renderer starts, not after.
  //
  // MEASURED at 41ms — the per-worktree `git status` probes run concurrently, so the
  // cost is the slowest single one rather than their sum (331ms serially). That is
  // cheap enough to pay up front, and paying it here rather than in a post-mount effect
  // means the flags are correct in the FIRST frame. An earlier version enriched only in
  // a test probe, so the real picker silently rendered every worktree without its dirty
  // count — the kind of gap a character-level check cannot see and a colour screenshot
  // shows immediately.
  await enrichWorktreeGit(groups, repo.root);

  // Anything written to the terminal behind a live renderer leaves cells OpenTUI cannot
  // invalidate, so provider/proxy chatter is muted while the picker owns the screen —
  // the same guard `startConfigTui` uses.
  setStderrQuiet(true);

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false, // the picker's own handler maps Ctrl+C to "cancel"
  });
  const root = createRoot(renderer);

  let chosen: string | null = null;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (id: string | null): void => {
        // Guard: Enter and Ctrl+C can both land before the tree stops rendering, and
        // resolving twice would leave the second teardown racing the first.
        if (settled) return;
        settled = true;
        chosen = id;
        resolve();
      };
      root.render(<ResumePicker groups={groups} onDone={done} />);
    });
  } finally {
    // Order is load-bearing and the reason this is a `finally`: unmount React first so
    // nothing can paint into a destroyed renderer, then destroy, which is what actually
    // restores the terminal out of raw mode and off the alternate screen. Each step is
    // guarded on its own — a throwing unmount must not be able to skip the destroy.
    try {
      root.unmount();
    } catch {
      /* the tree is already gone; the destroy below is what matters */
    }
    try {
      renderer.destroy();
    } catch {
      /* nothing left to restore */
    }
    setStderrQuiet(false);
  }

  return { sessionId: chosen, hadSessions: true };
}
