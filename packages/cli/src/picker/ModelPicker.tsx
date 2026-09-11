/** @jsxImportSource @opentui/react */
/**
 * picker/ModelPicker.tsx — one inline dialog, one list, one cursor.
 *
 * WHAT THIS FILE IS A CORRECTION OF. The first build of this picker was a
 * full-screen two-pane dashboard: a provider rail beside a model list, a gradient
 * context meter and a gradient price meter on every row, an aggregate-distribution
 * panel, and a five-tier responsive column ladder to keep all of it on an
 * 80-column terminal. The owner's verdict, verbatim: *"no no no this is super
 * unclear what is happening, that should be dialog style"*. A three-model design
 * panel then voted unanimously that the form, not the engineering, was the defect.
 *
 * THE ROOT CAUSE IS MEASURABLE, WHICH IS WHY IT IS WORTH WRITING DOWN. The house
 * TUI guidance requires that over half of a whole frame be graphics rows. On a
 * screen whose content IS a list, a row counts as a graphics row only if it
 * carries a bar — so the gate did not permit a meter on every row, it REQUIRED
 * one. The result, measured on the rejected capture: of 32 visible rows 19 read
 * `1M`, and their meters were indistinguishable. The loudest element on the screen
 * carried the least information, and the aggregate panel above it was added (by
 * its own file header) pre-emptively to top up the same count. The gate is for
 * persistent monitoring surfaces. A picker is a one-shot question.
 *
 * THREE STRUCTURAL DECISIONS FOLLOW, and each one deletes a class of defect:
 *
 * 1. **Inline** (`screenMode: "main-screen"`). The shell prompt and the claudish
 *    banner stay on screen above the dialog. It reads as a program ASKING
 *    something rather than as a program that has taken the terminal, and the
 *    guidance's own `screenMode` table assigns inline to a one-shot command.
 * 2. **One list at a time, one cursor in it.** Two panes meant two cursors with
 *    only a border colour to say which one the arrow keys drove — the literal
 *    cause of "unclear what is happening".
 * 3. **No per-row graphics.** Plain aligned columns; colour reserved for meaning,
 *    one meaning each (`rows.tsx` lists them). The one meter left in the picker is
 *    the credential sweep's `done/total`, which is real progress over countable
 *    work.
 *
 * THE DEFAULT SCREEN IS THE PROVIDER LIST, AND NOTHING IS FETCHED BEFORE IT. An
 * intermediate build landed on a flat 574-row cross-provider list and warmed the
 * cloud catalog AND every credentialled provider's live roster to fill it — a
 * `cloud catalog fetching… / live rosters 0/11 providers` screen the user had to
 * watch before he could do anything. The owner's three corrections, verbatim:
 * *"why we prefetching? we should not, as we show on demand"*, *"we should not
 * show the full list of models, we should show a list of providers by default and
 * only when we go inside we load and resolve all models"*, and *"we should not
 * show unsetted providers, just active"*. So:
 *
 *   · Startup does ONE thing: probe credentials, streaming each answer into the
 *     provider list as it settles. No catalog, no roster, no description index.
 *   · `⏎` on a provider fetches THAT provider's roster and shows it. The failure
 *     UX improves for free — a red panel now answers a request the user made.
 *   · `a` opens the cross-provider list, built from the ONE cached catalog fetch,
 *     enriched by whatever rosters he has already opened and by nothing else.
 *
 * NO AWAIT IS EVER SILENT, STRUCTURALLY RATHER THAN BY DILIGENCE. The roster is
 * derived synchronously, so the first frame is complete before any effect runs;
 * every loader is an effect; and every in-flight task draws an affordance whose
 * SHAPE is chosen by what the caller can actually measure. Nothing invents a
 * denominator.
 *
 * CANCELLATION RETURNS A VALUE. Esc and Ctrl+C both call `onDone(null)`; nothing
 * here calls `process.exit`. The bootstrap's `finally` unmounts React and destroys
 * the renderer in that order, which is what restores the terminal with a fetch
 * still in flight.
 *
 * NO BRANDING IS DRAWN HERE. `printLogo` already wrote the wordmark, `Claude Code.
 * Any Model.` and the version to the scrollback before this renderer opened, and
 * inline mode keeps them on screen — so a second miniature wordmark inside the
 * dialog would be claudish reinventing a logo it already has. The dialog's title
 * bar is a panel title, not a mark.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "../model-selector.js";
import { EmptyState } from "../tui/components/EmptyState.js";
import { useAnimationFrame } from "../tui/hooks/useAnimationFrame.js";
import { truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { DiscoveryNotice, discoveryNoticeContent, noticeRows } from "./DiscoveryNotice.js";
import {
  DISCOVERY_DEADLINE_MS,
  type DiscoveryShape,
  type PickerDataSource,
  type PickerProviderChoice,
} from "./PickerDataSource.js";
import { Dialog, FilterRow, Hints, type LoadTask, LoadTasks, Rule } from "./chrome.js";
import { DescriptionBlock, type ProviderFacts, ProviderLine, SelectionLine } from "./detail.js";
import { useModelDescriptions } from "./hooks/useModelDescriptions.js";
import {
  type PickerRow,
  dedupeByModelId,
  toPickerRow,
  usePickerModels,
} from "./hooks/usePickerModels.js";
import { type ProviderState, usePickerProviders } from "./hooks/usePickerProviders.js";
import { rowsFromOutcomes, useProviderDiscovery } from "./hooks/useProviderDiscovery.js";
import {
  deriveDialogLayout,
  deriveRowLayout,
  providerCellsFor,
  providerColumn,
  scrollWindow,
} from "./layout.js";
import { ColumnHeader, HintRow, ModelRow, ProviderRow, priceVaries } from "./rows.js";

/**
 * WHICH AFFORDANCE EACH IN-FLIGHT TASK EARNS — the honesty contract, as one pure
 * function so it can be asserted without a renderer.
 *
 * The credential sweep is the only task with a real denominator: the roster is
 * derived synchronously, so `done/total` is work done over work TOTAL. The GET half
 * of discovery has a published DEADLINE and gets an elapsed-vs-deadline bar whose
 * label says `deadline`, because a deadline is not progress. Everything else gets an
 * elapsed figure and a shimmer, which claims only that time is passing.
 *
 * There is deliberately NO `resolving prices` task. `servedModels` resolves pricing
 * from the same local index the rows came from, so there is no second phase — and
 * drawing a label for a phase that never runs is the same lie as an invented
 * denominator.
 *
 * AND THERE IS NO `live rosters` TASK ANY MORE. It had the most defensible meter in
 * the file — a real `done/total` over the providers about to be asked — and it was
 * still wrong, because the work it measured was work nobody had asked for. A
 * truthful bar for an unwanted fan-out is a truthful answer to the wrong question.
 */
export function buildLoadTasks(input: {
  creds: { done: number; total: number } | null;
  catalog: boolean;
  roster: { displayName: string; shape: DiscoveryShape; elapsed: number } | null;
}): LoadTask[] {
  const tasks: LoadTask[] = [];
  if (input.creds) {
    const { done, total } = input.creds;
    tasks.push({
      id: "creds",
      label: "credentials",
      pct: total > 0 ? (100 * done) / total : 0,
      value: `${done}/${total} checked`,
    });
  }
  if (input.catalog) tasks.push({ id: "catalog", label: "cloud catalog", value: "fetching…" });
  if (input.roster) {
    const { displayName, shape, elapsed } = input.roster;
    const secs = `${(elapsed / 1000).toFixed(1)}s`;
    tasks.push(
      shape === "deadline"
        ? {
            id: "roster",
            label: displayName,
            pct: Math.min(100, (100 * elapsed) / DISCOVERY_DEADLINE_MS),
            value: `${secs} / ${(DISCOVERY_DEADLINE_MS / 1000).toFixed(1)}s deadline`,
          }
        : { id: "roster", label: displayName, value: `discovering…  ${secs}` }
    );
  }
  return tasks;
}

export interface ModelPickerProps {
  source: PickerDataSource;
  /** A model spec, or `null` for cancelled. Called exactly once. */
  onDone: (spec: string | null) => void;
  /** Buffers a failed provider's diagnostic for the ONE write after teardown. */
  onDiscoveryFailure?: (provider: string, notice: readonly string[]) => void;
}

/**
 * Which dialog is on screen. ONE at a time, and one keyboard owner each — there is
 * never a second cursor to disambiguate.
 *
 * `providers` IS THE LANDING VIEW. `models` is reached by entering a provider
 * (`scope` set) or by asking for the cross-provider list (`scope` null); `esc`
 * from either comes back here, and `esc` HERE is what cancels the picker.
 */
type View = "models" | "providers" | "custom";

export function ModelPicker({ source, onDone, onDiscoveryFailure }: ModelPickerProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  // THE ONLY WORK STARTUP DOES. Every other loader below is gated on a view the
  // user has actually opened.
  const providers = usePickerProviders(source);

  const [view, setView] = useState<View>("providers");
  const [filter, setFilter] = useState("");
  /**
   * `/` was pressed: every printable key types, INCLUDING `c` and `r`.
   *
   * It exists for exactly one case, and that case is real: a model id beginning
   * with one of the two letter commands — `codex`, `r1` — would navigate on its
   * first keystroke instead of filtering. `/` is the escape hatch the design
   * names, and it costs nothing when it is not needed: a filter with anything in
   * it already types every key.
   */
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const [cursor, setCursor] = useState(0);
  const [providerCursor, setProviderCursor] = useState(0);
  /**
   * Are the providers with NO credential on screen?
   *
   * Off by default, on the owner's instruction: *"we should not show unsetted
   * providers, just active"*. They are not deleted — one summary row says how many
   * were left out and which key brings them back — because an unexplained absence
   * is the defect class this whole feature is about. A fact behind one keystroke is
   * reachable; fourteen `○ needs SOMETHING_API_KEY` rows in front of the four the
   * user can actually use are not.
   */
  const [revealKeyless, setRevealKeyless] = useState(false);
  /** `null` = the cross-provider list; a name = scoped to that provider. */
  const [scope, setScope] = useState<string | null>(null);

  const scopedChoice = providers.roster.find((r) => r.value === scope) ?? null;
  const scopedName = scope === null ? "" : source.displayName(scope);
  const hasDiscovery = scopedChoice?.hasDiscovery === true;
  /**
   * DISCOVERY RUNS ONLY WHILE A PROVIDER'S OWN LIST IS OPEN — the `null` when the
   * view is not `models` is the on-demand rule, in one argument. Outcomes already
   * settled stay in `seen`, so coming back to a provider costs nothing and the
   * all-models view can reuse what has been fetched.
   */
  const discovery = useProviderDiscovery(
    source,
    view === "models" ? scope : null,
    hasDiscovery,
    onDiscoveryFailure
  );
  /** Rosters the user has already opened. No fetch — see `rowsFromOutcomes`. */
  const liveRows = useMemo(() => rowsFromOutcomes(discovery.seen), [discovery.seen]);

  /**
   * THE CATALOG IS FETCHED FOR THE VIEWS THAT READ IT, AND FOR NO OTHER.
   *
   * The cross-provider list is built from it, and so is a provider that does not
   * list its own roster. A discovery provider needs nothing from it — its rows come
   * from its own endpoint — unless discovery comes back `unsupported`, at which
   * point the catalog IS the list and the warm starts then.
   */
  const wantCatalog =
    view === "models" &&
    (scope === null || !hasDiscovery || discovery.outcome?.kind === "unsupported");
  const catalog = usePickerModels(
    source,
    providers.roster,
    providers.readySet,
    liveRows,
    wantCatalog
  );
  const descriptions = useModelDescriptions(source, view === "models");

  /**
   * WHICH PROVIDERS ARE ON SCREEN, and the one number that explains the rest.
   *
   * Active first and always; the keyless ones are appended only when `k` has asked
   * for them, so the cursor's index into this array stays valid across the toggle
   * for every row that was already visible.
   */
  const keyless = providers.missing;
  const providerRows: ProviderState[] = revealKeyless
    ? [...providers.ready, ...keyless]
    : providers.ready;

  /**
   * A MODEL COUNT ONLY WHERE ONE IS ACTUALLY KNOWN — the owner's rule: *"we could
   * not show number of models for some of them"*.
   *
   * Two sources, both already in hand and neither of them a fetch this map causes.
   * A roster the user opened is the truest answer for that provider, so it wins;
   * the catalog answers for the rest, but ONLY once the user has asked for a view
   * that warmed it. A provider in neither set gets `null`, which `ProviderRow`
   * prints as nothing at all.
   */
  const counts = useMemo((): ReadonlyMap<string, number> => {
    const known = new Map<string, number>();
    for (const [name, rows] of liveRows) known.set(name, new Set(rows.map((m) => m.id)).size);
    if (catalog.phase === "ready") {
      for (const [name, n] of catalog.counts) if (!known.has(name)) known.set(name, n);
    }
    return known;
  }, [liveRows, catalog.counts, catalog.phase]);

  // ── which list is on screen, and where it came from ──────────────────────────
  //
  // PROVENANCE IS A PROPERTY OF THE LIST, NOT OF A ROW. One value decides all three
  // encodings — the dialog's status title, the per-row `catalog` mark and the
  // banner's provenance sentence — so they cannot disagree with each other.
  //
  // The UNSCOPED list is catalog-derived too, and is deliberately NOT marked. A
  // mark means "the live roster was asked for and could not be had"; nothing asked
  // for a live roster here, so marking every row would spend the loudest signal in
  // the feature on the ordinary case and teach the reader to ignore it.
  // ONE ROW PER MODEL INSIDE A PROVIDER, N ROWS ACROSS PROVIDERS. The owner stated
  // the rule: *"if model has more than one provider that going to be two lines in
  // 'all models' list. and if we enter to provider catalog, not all models — then
  // the model will be just one"*. The flat list's identity is `(provider, modelId)`
  // and `usePickerModels` applies it; every scoped branch below goes through
  // `dedupeByModelId`, so a live roster overlapping the catalog for the SAME
  // provider cannot show the same model twice.
  const list = useMemo((): { rows: RowView[]; fallback: boolean; loading: boolean } => {
    if (scope === null) {
      return { rows: catalog.rows, fallback: false, loading: catalog.phase !== "ready" };
    }
    // A DISCOVERED ROSTER AND A CATALOG LIST GO THROUGH THE SAME ROW BUILDER, so a
    // fallback list cannot be distinguishable by accident — a different price
    // string or a different spec spelling — instead of by the three deliberate
    // provenance encodings.
    const project = (rows: ModelInfo[]): RowView[] =>
      scopedChoice === null ? [] : dedupeByModelId(rows.map((m) => toPickerRow(scopedChoice, m)));
    const scoped = dedupeByModelId(catalog.rows.filter((r) => r.provider === scope));
    if (!hasDiscovery) return { rows: scoped, fallback: false, loading: catalog.phase !== "ready" };
    const o = discovery.outcome;
    if (o === null) return { rows: [], fallback: false, loading: true };
    if (o.kind === "rows") return { rows: project(o.rows), fallback: false, loading: false };
    if (o.kind === "unsupported") return { rows: scoped, fallback: false, loading: false };
    return { rows: project(o.fallbackRows), fallback: true, loading: false };
  }, [scope, scopedChoice, hasDiscovery, discovery.outcome, catalog.rows, catalog.phase]);

  /**
   * The provider cell for every provider on screen — collision-proof by
   * construction, and computed from the ROSTER rather than from the rows so the
   * column does not change width as rosters merge in behind the cursor.
   */
  // The column budget depends only on the TERMINAL, never on the banner — a
  // banner takes rows, not columns — so it is derived from a base layout here and
  // stays put while a notice appears and disappears above the list.
  const providerCells = providerCellsFor(deriveDialogLayout(width, height).inner, list.fallback);
  const column = useMemo(
    () => providerColumn(providers.roster, truncate, providerCells),
    [providers.roster, providerCells]
  );
  /** Provider → its WHOLE display name, for the filter and the detail line. */
  const labels = useMemo(
    () => new Map(providers.roster.map((r) => [r.value, r.label])),
    [providers.roster]
  );
  /** Provider → what it IS: how it bills, and the credential it wants. */
  const facts = useMemo(
    () => new Map<string, ProviderFacts>(providers.roster.map((r) => [r.value, factsOf(r)])),
    [providers.roster]
  );

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return list.rows;
    // THREE THINGS MATCH, and the readable NAME is one of them — the column now
    // prints `OpenRouter`, so typing `openr` must narrow to it or the filter
    // contradicts the screen. The shortcut still matches (`kc` reaches Kimi
    // Coding in three keystrokes, which is how provider scoping survived the
    // rail's deletion) and so does the model id.
    return list.rows.filter(
      (r) =>
        r.model.id.toLowerCase().includes(needle) ||
        r.shortcut.toLowerCase().startsWith(needle) ||
        (labels.get(r.provider) ?? "").toLowerCase().includes(needle)
    );
  }, [list.rows, filter, labels]);

  // ── in-flight affordances ───────────────────────────────────────────────────
  //
  // `catalog.phase === "loading"`, NEVER `!== "ready"`. The third state is `idle`,
  // which is what the catalog is on the provider list — not fetching, not fetched,
  // and not wanted. Drawing a `cloud catalog fetching…` row for it would put the
  // owner's own complaint back on the landing screen with no request behind it.
  const busy = providers.probing || catalog.phase === "loading" || discovery.busy;
  const frame = useAnimationFrame(busy);
  const tasks = buildLoadTasks({
    creds: providers.probing ? { done: providers.done, total: providers.total } : null,
    catalog: catalog.phase === "loading",
    roster:
      discovery.busy && scope !== null
        ? {
            displayName: scopedName,
            shape: scopedChoice?.discoveryShape ?? "none",
            elapsed: discovery.startedAt === null ? 0 : Date.now() - discovery.startedAt,
          }
        : null,
  });
  // The loading DIALOG replaces the list only while there is nothing to show at
  // all. Once rows exist the list wins and the pending work drops to a footer
  // note: "models appear as soon as they are ready" is a promise the screen has to
  // keep, and a spinner in front of a usable list breaks it.
  const phase: "loading" | "list" = tasks.length > 0 && list.rows.length === 0 ? "loading" : "list";

  // ── layout ──────────────────────────────────────────────────────────────────
  const notice =
    scope !== null && discovery.outcome !== null
      ? discoveryNoticeContent(discovery.outcome, scopedName)
      : null;
  const base = deriveDialogLayout(width, height);
  const bannerRows =
    notice === null
      ? 0
      : noticeRows(notice, Math.max(8, base.inner - 2), MAX_BANNER_ROWS).lines.length;
  const layout = deriveDialogLayout(width, height, bannerRows);
  /**
   * IS THE PROVIDER COLUMN WORTH ITS CELLS HERE?
   *
   * In the cross-provider list it is the whole point — the same model id appears on
   * three providers and the column is what tells them apart. Inside a provider it
   * prints one repeated name under a dialog titled with that same name: 49 rows of
   * `OpenAI Codex` under `OpenAI Codex`, eating the columns the model id wants. The
   * owner said so from a live run. One flag through `deriveRowLayout`, so the header
   * and the rows cannot disagree about whether the cell exists.
   */
  const showProviderColumn = scope === null;
  /**
   * DOES THE PRICE COLUMN EARN CHIPS? Only where it VARIES — see `rows.tsx`. A
   * flat-rate or local provider answers the same word for every row, and a column of
   * identical fills is the solid rectangle the skill measured.
   */
  const chipPrices = priceVaries(scope === null ? null : (scopedChoice?.billing ?? null));
  // `column.cells`, not `providerCells`: a collision may have WIDENED the column
  // past what the row budgeted, and the header and the rows must agree whichever
  // number won.
  const rowLayout = deriveRowLayout(layout.inner, {
    mark: list.fallback,
    ...(showProviderColumn ? { providerCells: column.cells } : { provider: false }),
  });

  // The cursor can outlive the list it indexed — a filter keystroke, or a scope
  // whose roster came back shorter than the last one's.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, Math.max(0, shown.length - 1))));
  }, [shown.length]);
  // The SAME hazard on the provider list, from two directions: `k` folds fourteen
  // rows away under the cursor, and the list GROWS as probes settle under it.
  useEffect(() => {
    setProviderCursor((c) => Math.max(0, Math.min(c, Math.max(0, providerRows.length - 1))));
  }, [providerRows.length]);

  const top = scrollWindow(cursor, shown.length, layout.listRows);
  const window = shown.slice(top, top + layout.listRows);
  const selected = shown[cursor] ?? null;

  // ── keys: ONE handler, because `useKeyboard` is a BROADCAST ─────────────────
  //
  // Every mounted subscriber receives every key — no bubbling, no
  // `stopPropagation` — so mutual exclusion is hand-rolled. Here it is trivial,
  // because there is one view at a time and one cursor in it.
  //
  // FILTER-FIRST, WITH ONE ESCAPE HATCH. In the model view every printable key
  // that is not a bound command types into the filter immediately — there is no
  // search MODE to enter, which is one fewer thing the reader has to know before
  // the screen does anything. The commands that survive are the ones a filter
  // cannot express (`esc`, `enter`, the arrows) plus TWO letters, and those two are
  // live ONLY while the filter is empty and `/` has not been pressed: once anything
  // is typed they are letters again, because a user typing `codex` must get `codex`
  // and not the custom-spec dialog.
  //
  // THE PROVIDER LIST TAKES NO FILTER AND SO NEEDS NO ESCAPE HATCH: its letters
  // (`a`, `k`, `c`) are always commands, which is affordable because that list is
  // short and named, never hundreds of rows a user needs to narrow.
  useKeyboard((key) => {
    const name = key.name;
    if (key.ctrl && name === "c") {
      onDone(null);
      return;
    }

    if (view === "custom") {
      if (name === "escape") {
        setView("models");
        return;
      }
      if (name === "return" || name === "enter") {
        const spec = custom.trim();
        if (spec) onDone(spec);
        return;
      }
      if (name === "backspace") {
        setCustom((v) => v.slice(0, -1));
        return;
      }
      if (printable(key.raw)) setCustom((v) => v + key.raw);
      return;
    }

    if (view === "providers") {
      // THE LANDING VIEW OWNS CANCEL. `esc` goes one step back everywhere else in
      // this picker; here there is no step back, so it is what returns `null`.
      if (name === "escape") {
        onDone(null);
        return;
      }
      if (name === "up" || name === "down") {
        const d = name === "up" ? -1 : 1;
        setProviderCursor((c) => Math.max(0, Math.min(providerRows.length - 1, c + d)));
        return;
      }
      if (name === "pageup" || name === "pagedown") {
        const d = (name === "pageup" ? -1 : 1) * layout.listRows;
        setProviderCursor((c) => Math.max(0, Math.min(providerRows.length - 1, c + d)));
        return;
      }
      if (name === "home") {
        setProviderCursor(0);
        return;
      }
      if (name === "end") {
        setProviderCursor(Math.max(0, providerRows.length - 1));
        return;
      }
      if (name === "return" || name === "enter") {
        // ENTERING A PROVIDER IS WHAT FETCHES ITS ROSTER. Nothing before this
        // keystroke asked that endpoint anything.
        const chosen = providerRows[providerCursor];
        if (chosen) {
          setScope(chosen.value);
          setFilter("");
          setTyping(false);
          setCursor(0);
          setView("models");
        }
        return;
      }
      if (key.raw === "a") {
        setScope(null);
        setFilter("");
        setTyping(false);
        setCursor(0);
        setView("models");
        return;
      }
      if (key.raw === "k") {
        setRevealKeyless((v) => !v);
        return;
      }
      if (key.raw === "c") setView("custom");
      return;
    }

    if (name === "escape") {
      if (filter !== "" || typing) {
        setFilter("");
        setTyping(false);
        setCursor(0);
        return;
      }
      // ONE WAY BACK, AND IT IS THE SAME ONE FROM BOTH MODEL LISTS. A scoped list
      // and the cross-provider list are both something the user OPENED from the
      // provider list, so `esc` returns him to it rather than quitting — quitting
      // is `esc` there, or Ctrl+C anywhere.
      setView("providers");
      return;
    }
    if (name === "up" || name === "down") {
      const d = name === "up" ? -1 : 1;
      setCursor((c) => Math.max(0, Math.min(shown.length - 1, c + d)));
      return;
    }
    if (name === "pageup" || name === "pagedown") {
      const d = (name === "pageup" ? -1 : 1) * layout.listRows;
      setCursor((c) => Math.max(0, Math.min(shown.length - 1, c + d)));
      return;
    }
    if (name === "home") {
      setCursor(0);
      return;
    }
    if (name === "end") {
      setCursor(Math.max(0, shown.length - 1));
      return;
    }
    if (name === "return" || name === "enter") {
      if (selected) onDone(selected.spec);
      return;
    }
    if (name === "backspace") {
      setFilter((v) => v.slice(0, -1));
      setCursor(0);
      return;
    }
    const commandsLive = filter === "" && !typing;
    if (commandsLive && key.raw === "c") {
      setView("custom");
      return;
    }
    if (commandsLive && key.raw === "r" && scope !== null && hasDiscovery) {
      discovery.retry(scope);
      return;
    }
    if (key.raw === "/") {
      // Not inserted: `/` FOCUSES the filter, which here means "stop treating
      // c / r as commands". See `typing`.
      setTyping(true);
      return;
    }
    if (printable(key.raw)) {
      setFilter((v) => v + key.raw);
      setCursor(0);
    }
  });

  // ── the three dialogs ───────────────────────────────────────────────────────
  //
  // `key={view}-{phase}` FORCES A REMOUNT WHEN THE TREE CHANGES SHAPE. Inline mode
  // reserves rows by scrolling the main screen, and OpenTUI's in-place
  // reconciliation tore the panel when the chrome below a banner changed shape
  // (`probe-tui-app.tsx:1455-1462` records the same failure and the same cure). A
  // loading dialog flipping to a list dialog is exactly that transition.

  if (view === "custom") {
    return (
      <Centred width={width} height={height}>
        <Dialog
          key="custom"
          title="type a model spec"
          status="provider@model"
          width={layout.width}
          marginLeft={0}
        >
          <box height={1} flexShrink={0}>
            <text>
              <span fg={tokens.accent}>{"› "}</span>
              <span fg={tokens.text}>{custom}</span>
              <span fg={tokens.accent}>▍</span>
            </text>
          </box>
          <box height={1} flexShrink={0}>
            <text>
              <span fg={tokens.subtle}>
                {"e.g. or@openai/gpt-5, kc@kimi-k3, ollama@llama3.2 — anything argv accepts"}
              </span>
            </text>
          </box>
          <Rule />
          <Hints
            hints={[
              { key: "⏎", label: "launch it", on: custom.trim() !== "" },
              { key: "esc", label: "back" },
            ]}
          />
        </Dialog>
      </Centred>
    );
  }

  if (view === "providers") {
    const settled = !providers.probing;
    // One row taller than the model list's list: this dialog spends no column
    // header and no description block, and two of the three rows it spends
    // instead — the omitted-provider summary and the credential sweep — are
    // rendered blank rather than dropped, so the list does not shift under the
    // cursor when a sweep finishes or `k` is pressed.
    const windowRows = layout.listRows;
    const providerTop = scrollWindow(providerCursor, providerRows.length, windowRows);
    const providerWindow = providerRows.slice(providerTop, providerTop + windowRows);
    const here = providerRows[providerCursor] ?? null;
    return (
      <Centred width={width} height={height}>
        <Dialog
          key={`providers-${providerRows.length === 0 ? "empty" : "list"}`}
          title="choose a provider"
          status={
            settled
              ? `${providers.ready.length} of ${providers.total} have credentials`
              : `${providers.ready.length} ready · ${providers.done}/${providers.total} checked`
          }
          width={layout.width}
          marginLeft={0}
        >
          {/* TWO ROWS WHEN IT IS EMPTY, because `EmptyState` with a hint IS two
              rows and a one-row box would overprint the second onto the row
              below it. */}
          <box
            flexDirection="column"
            height={Math.min(
              windowRows,
              Math.max(providerWindow.length === 0 ? 2 : 1, providerWindow.length)
            )}
            flexShrink={0}
            overflow="hidden"
          >
            {providerWindow.length === 0 ? (
              <EmptyState
                label={
                  settled
                    ? `no credential for any of the ${providers.total} providers`
                    : "checking which providers you have credentials for…"
                }
                {...(settled ? { hint: "k shows what each one needs" } : {})}
              />
            ) : (
              providerWindow.map((r) => (
                <ProviderRow
                  key={r.value}
                  label={r.label}
                  shortcut={r.shortcut}
                  readiness={r.readiness}
                  billing={r.billing}
                  count={counts.get(r.value) ?? null}
                  hasDiscovery={r.hasDiscovery}
                  note={r.envVar === "" ? "needs sign-in" : `needs ${r.envVar}`}
                  cursor={r.value === here?.value}
                  inner={layout.inner}
                />
              ))
            )}
          </box>
          {/* A list that silently stops is the same unexplained absence this
              feature exists to remove. */}
          <HintRow
            text={
              providerRows.length > providerWindow.length
                ? `${providerCursor + 1} of ${providerRows.length} — ↑↓ for more`
                : ""
            }
            width={layout.inner}
          />
          {/* THE OMITTED PROVIDERS, COUNTED. They are off the list because the user
              cannot launch any of them, and stated here because "where did the other
              fourteen go" must have an answer on the screen that dropped them. */}
          <HintRow
            text={
              keyless.length === 0
                ? ""
                : revealKeyless
                  ? `showing ${keyless.length} with no credential · k hides them again`
                  : `+${keyless.length} more need a key · k`
            }
            width={layout.inner}
          />
          {/* A DIFFERENT REASON, ON ITS OWN LINE. These are not missing a key: they
              are opt-in in your config (`config.localProviders`) and were never
              probed for liveness. */}
          <HintRow
            text={
              providers.notEnabledLocal.length > 0
                ? `${providers.notEnabledLocal.join(", ")} — local, not enabled in your config`
                : ""
            }
            width={layout.inner}
          />
          {/* THE ONE METER IN THE PICKER, on the one screen that waits for anything.
              It is `done/total` over a roster derived synchronously — real progress
              over countable work — and it disappears, leaving its row, when the last
              probe settles. */}
          {settled ? (
            <HintRow text="" width={layout.inner} />
          ) : (
            <LoadTasks
              tasks={tasks}
              frame={frame}
              labelWidth={12}
              barWidth={Math.max(8, Math.min(22, layout.inner - 40))}
            />
          )}
          <Rule />
          {/* The SAME line the model list carries, plus the count when one is
              known — so "what is this provider" has one answer wherever it is
              asked. */}
          <ProviderLine
            facts={here === null ? null : factsOf(here)}
            width={layout.inner}
            count={here === null ? null : (counts.get(here.value) ?? null)}
          />
          <Hints
            hints={[
              { key: "↑↓", label: "move" },
              { key: "⏎", label: "open", on: here !== null },
              { key: "a", label: "all models" },
              // `keyless` SAID THE OPPOSITE OF WHAT IT MEANT. These providers need a
              // key — that is precisely why they are hidden — and "keyless" reads as
              // "no key required". The hint row above already says `need a key`, so
              // the footer now says it too, in 9 of the 76 columns 80 gives us.
              { key: "k", label: revealKeyless ? "hide" : "needs key", on: keyless.length > 0 },
              { key: "c", label: "custom" },
              { key: "esc", label: "quit" },
            ]}
          />
        </Dialog>
      </Centred>
    );
  }

  if (phase === "loading") {
    return (
      <Centred width={width} height={height}>
        <Dialog
          key="loading"
          title={scope === null ? "all models" : scopedName}
          status="finding models…"
          width={layout.width}
          marginLeft={0}
        >
          <LoadTasks
            tasks={tasks}
            frame={frame}
            labelWidth={14}
            barWidth={Math.max(8, Math.min(22, layout.inner - 40))}
          />
          <box height={1} flexShrink={0}>
            <text>
              <span fg={tokens.trace}>models appear as soon as they are ready</span>
            </text>
          </box>
          <Rule />
          <Hints hints={[{ key: "esc", label: "providers" }]} />
        </Dialog>
      </Centred>
    );
  }

  // THE COUNT IS COMPUTED THE WAY IT IS LABELLED, and the two views count
  // differently because their rows mean different things. The flat list holds one
  // row per ROUTE — a model on three providers is three rows — so calling that
  // number "models" would be a claim about the catalog that is off by the exact
  // amount the list is useful. Both numbers are printed: the models are what the
  // reader is choosing between, the routes are why the same name appears twice. A
  // provider view has one route in scope, so its rows ARE models and it says so.
  const status =
    scope === null
      ? `${countModels(list.rows)} models · ${list.rows.length} routes · ${providers.ready.length}/${providers.total} providers`
      : (notice?.title ?? `${list.rows.length} models`);

  // THE CROSS-PROVIDER LIST IS LABELLED AS WHAT IT IS. It used to be the screen the
  // picker opened on, so `choose a model` was the whole dialog's purpose; it is now
  // one of the two things a provider list can open, and the other one is titled with
  // its provider's name. `all models` says which of the two you are looking at.
  return (
    <Centred width={width} height={height}>
      <Dialog
        key="models"
        title={scope === null ? "all models" : scopedName}
        status={status}
        width={layout.width}
        marginLeft={0}
      >
        {/* The banner sits ABOVE the rows it qualifies, never below them: the eye
            goes to the list, and a warning under a healthy-looking list is a warning
            nobody reads. That is the user's own report, verbatim. */}
        {discovery.outcome === null ? null : (
          <DiscoveryNotice
            outcome={discovery.outcome}
            displayName={scopedName}
            width={Math.max(8, layout.inner - 2)}
            maxRows={MAX_BANNER_ROWS}
          />
        )}

        <FilterRow
          value={filter}
          matches={shown.length}
          total={list.rows.length}
          width={layout.inner}
        />
        <ColumnHeader layout={rowLayout} />

        {/* CONTENT-SIZED, CAPPED — never `flexGrow`. A four-row Kimi fallback makes a
            short dialog; it does not make a tall dialog with fifteen rows of unpainted
            background in it, which is what the rejected full-screen build did and what
            the reader read as "this provider has nothing". The cap is `listRows`, and
            the banner's rows have already come out of it, so the box is bounded above
            in every state. */}
        <box
          flexDirection="column"
          height={Math.min(
            layout.listRows,
            Math.max(window.length === 0 && filter !== "" ? 2 : 1, window.length)
          )}
          flexShrink={0}
          overflow="hidden"
        >
          {window.length === 0 ? (
            <EmptyState
              label={emptyLabel(list.loading, filter, list.rows.length, scopedName, providers)}
              {...(filter === "" ? {} : { hint: "esc clears the filter" })}
            />
          ) : (
            window.map((r, i) => (
              <ModelRow
                key={r.spec}
                model={r.model}
                providerLabel={column.text.get(r.provider) ?? r.shortcut}
                price={r.price}
                layout={rowLayout}
                cursor={top + i === cursor}
                origin={list.fallback ? "catalog" : "roster"}
                chip={chipPrices}
              />
            ))
          )}
        </box>

        {/* ONE status row, ALWAYS rendered — see `CHROME_ROWS`. It carries the
            scroll position when the list overflows, then whatever is still in
            flight, then nothing. There is no aggregate failure line any more:
            with the fan-out gone, the only roster that can fail is one the user
            opened, and that one gets the banner above this list. */}
        <HintRow
          text={statusRow(cursor, shown.length, window.length, tasks)}
          width={layout.inner}
        />

        <Rule />
        {/* THREE ROWS ON THE PANEL'S OWN BACKGROUND. They recede by their INK — a
            fill here was rejected on sight, and `Rule` above is already the
            separator a fill would have been a second copy of (`detail.tsx`). */}
        <SelectionLine
          model={selected?.model ?? null}
          spec={selected?.spec ?? null}
          width={layout.inner}
        />
        <ProviderLine
          facts={selected === null ? null : (facts.get(selected.provider) ?? null)}
          width={layout.inner}
        />
        <DescriptionBlock
          text={
            selected === null ? "" : descriptionOf(selected, descriptions.get.bind(descriptions))
          }
          width={layout.inner}
        />
        {/* ONE KEY PER ACTION, AND EVERY ACTION IN THE ROW. `p` is gone: `esc` is
            the way back to the provider list from both model lists, and a second
            key for the one destination bought nothing while costing the row the
            columns `r retry` needs at 80. */}
        <Hints
          hints={[
            { key: "↑↓", label: "move" },
            { key: "⏎", label: "select", on: selected !== null },
            { key: "/", label: "filter" },
            ...(scope !== null && hasDiscovery ? [{ key: "r", label: "retry" }] : []),
            { key: "c", label: "custom" },
            { key: "esc", label: filter !== "" ? "clear" : "providers" },
          ]}
        />
      </Dialog>
    </Centred>
  );
}

/**
 * The full-height flex root that puts the dialog in the MIDDLE of the terminal.
 *
 * "why we not showing provider first and let show it in a middle of the screen".
 * The dialog used to be pinned to row one with the rest of a 45-row terminal
 * painted black below it, which is what "inline" bought — and it bought nothing,
 * because `CliRendererConfig` at `@opentui/core@0.1.107` has no `height` key, so
 * the renderer is sized to `stdout.rows` in `main-screen` mode exactly as it is in
 * the alternate screen. The region was always the whole terminal; only the dialog
 * was at the top.
 *
 * FLEXBOX, NOT SPACER BOXES. `justifyContent="center"` on a column root centres it
 * vertically and `alignItems="center"` horizontally, so neither axis needs the
 * margin arithmetic the previous build did by hand — and both re-centre on a
 * resize with no code at all. The dialog is a fixed-width, content-height flex
 * item, which is what makes it centre rather than stretch.
 */
function Centred({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}): ReactNode {
  return (
    <box
      flexDirection="column"
      width={Math.max(1, Math.floor(width))}
      height={Math.max(1, Math.floor(height))}
      justifyContent="center"
      alignItems="center"
    >
      {children}
    </box>
  );
}

/**
 * The prose sentence for a row, or `""`.
 *
 * `catalogModelToModelInfo` substitutes `"<provider> model"` when the catalog has
 * no description, which every slim-catalog row hits — so a raw `model.description`
 * would print `unknown model` under half the list. The real index is tried first
 * and the placeholder is filtered out, because a blank line is honest and
 * `unknown model` is not.
 */
export function descriptionOf(
  row: { model: ModelInfo },
  lookup: (id: string) => string | undefined
): string {
  const found = lookup(row.model.id);
  if (found !== undefined && found !== "") return found;
  const own = (row.model.description ?? "").trim();
  return own === "" || /^\S+ model$/i.test(own) ? "" : own;
}

/**
 * How many DISTINCT models a list of rows covers.
 *
 * Exported so the title's arithmetic can be asserted: `N models · M routes` is
 * only honest if the two numbers are computed differently, and a regression that
 * made them equal would be invisible on a screenshot of a roster where no model
 * happens to be served twice.
 */
export function countModels(rows: readonly { model: ModelInfo }[]): number {
  return new Set(rows.map((r) => r.model.id)).size;
}

/** A roster entry as the facts the detail line prints. Derived, never a table. */
function factsOf(choice: PickerProviderChoice): ProviderFacts {
  return {
    label: choice.label,
    shortcut: choice.shortcut,
    billing: choice.billing,
    envVar: choice.envVar,
  };
}

/** The banner's half of the inline row budget. */
const MAX_BANNER_ROWS = 5;

/**
 * The one status row's text, in priority order: where the cursor is in a list
 * longer than the window, then what is still loading, then nothing.
 *
 * IT NO LONGER CARRIES AN AGGREGATE FAILURE COUNT, because there is no longer an
 * aggregate. That line existed for the startup fan-out — thirteen rosters in
 * flight at once, where a banner per failure would have pushed the list off the
 * screen and a banner for the first would have spoken for the rest. With rosters
 * fetched one at a time, on request, the only roster that can fail is the one the
 * user just opened, and it gets the full banner above its own list.
 *
 * Pure so the priority can be asserted. The scroll position wins over the pending
 * work because it changes on every keypress.
 */
export function statusRow(
  cursor: number,
  shown: number,
  visible: number,
  tasks: LoadTask[]
): string {
  if (shown > visible && visible > 0) return `${cursor + 1} of ${shown} — ↑↓ for more`;
  if (tasks.length > 0) return `still checking: ${tasks.map((t) => t.label).join(", ")}`;
  return "";
}

/** One row of the list, whichever list it is. */
type RowView = PickerRow;

/** Every key that is not a command types into the filter. */
function printable(raw: string | undefined): raw is string {
  return raw !== undefined && raw.length === 1 && raw >= " " && raw !== "\x7f";
}

/**
 * SAY WHICH EMPTY IT IS. "Nothing here" covers five different situations — still
 * loading, no provider has a credential, loaded and genuinely empty, filtered to
 * nothing, and failed — and a picker that prints one sentence for all five is the
 * complaint this feature exists to fix. The failed case never reaches here: it goes
 * to the banner, which has a colour.
 */
function emptyLabel(
  loading: boolean,
  filter: string,
  total: number,
  scopedName: string,
  providers: { ready: unknown[]; probing: boolean; total: number }
): string {
  if (loading) return `loading ${scopedName || "models"}…`;
  if (filter !== "") return `no model matches “${filter}”`;
  if (providers.ready.length === 0 && !providers.probing) {
    return `no credential for any of the ${providers.total} providers — esc, then k, shows what each one needs`;
  }
  if (total === 0) return `no catalog entries for ${scopedName || "these providers"}`;
  return "nothing to show";
}
