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
 * 2. **One flat cross-provider list.** Two panes meant two cursors with only a
 *    border colour to say which one the arrow keys drove — the literal cause of
 *    "unclear what is happening". The provider becomes a COLUMN, printed as the
 *    routing shortcut the user could have typed (`or@`, `kc@`, `gk@`), which also
 *    kills the truncation collision that rendered two different providers as
 *    `opencod…`. Filtering on `kc` scopes to Kimi Coding faster than a rail ever
 *    did.
 * 3. **No per-row graphics.** Plain aligned columns; colour reserved for meaning,
 *    one meaning each (`rows.tsx` lists them). The one meter left in the picker is
 *    the credential sweep's `done/total`, which is real progress over countable
 *    work.
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
import { tokens } from "../tui/viz/tokens.js";
import { DiscoveryNotice, discoveryNoticeContent, noticeRows } from "./DiscoveryNotice.js";
import {
  DISCOVERY_DEADLINE_MS,
  type DiscoveryShape,
  type PickerDataSource,
} from "./PickerDataSource.js";
import { Dialog, FilterRow, Hints, type LoadTask, LoadTasks, Rule } from "./chrome.js";
import { SelectionLine } from "./detail.js";
import { type PickerRow, toPickerRow, usePickerModels } from "./hooks/usePickerModels.js";
import { usePickerProviders } from "./hooks/usePickerProviders.js";
import { useProviderDiscovery } from "./hooks/useProviderDiscovery.js";
import { deriveDialogLayout, deriveRowLayout, scrollWindow } from "./layout.js";
import { ColumnHeader, HintRow, ModelRow, ProviderRow } from "./rows.js";

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
 */
type View = "models" | "providers" | "custom";

export function ModelPicker({ source, onDone, onDiscoveryFailure }: ModelPickerProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const providers = usePickerProviders(source);
  const catalog = usePickerModels(source, providers.roster, providers.readySet);

  const [view, setView] = useState<View>("models");
  const [filter, setFilter] = useState("");
  /**
   * `/` was pressed: every printable key types, INCLUDING `p`, `c` and `r`.
   *
   * It exists for exactly one case, and that case is real: `phi3` is an Ollama
   * model, and with the three letter commands live on an empty filter its first
   * keystroke would open the provider dialog instead. `/` is the escape hatch the
   * design names, and it costs nothing when it is not needed — a filter with
   * anything in it already types every key.
   */
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const [cursor, setCursor] = useState(0);
  const [providerCursor, setProviderCursor] = useState(0);
  /** `null` = the flat cross-provider list; a name = scoped to that provider. */
  const [scope, setScope] = useState<string | null>(null);

  const scopedChoice = providers.roster.find((r) => r.value === scope) ?? null;
  const scopedName = scope === null ? "" : source.displayName(scope);
  const hasDiscovery = scopedChoice?.hasDiscovery === true;
  const discovery = useProviderDiscovery(source, scope, hasDiscovery, onDiscoveryFailure);

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
  const list = useMemo((): { rows: RowView[]; fallback: boolean; loading: boolean } => {
    if (scope === null) {
      return { rows: catalog.rows, fallback: false, loading: catalog.phase !== "ready" };
    }
    // A DISCOVERED ROSTER AND A CATALOG LIST GO THROUGH THE SAME ROW BUILDER, so a
    // fallback list cannot be distinguishable by accident — a different price
    // string or a different spec spelling — instead of by the three deliberate
    // provenance encodings.
    const project = (rows: ModelInfo[]): RowView[] =>
      scopedChoice === null ? [] : rows.map((m) => toPickerRow(scopedChoice, m));
    const scoped = catalog.rows.filter((r) => r.provider === scope);
    if (!hasDiscovery) return { rows: scoped, fallback: false, loading: catalog.phase !== "ready" };
    const o = discovery.outcome;
    if (o === null) return { rows: [], fallback: false, loading: true };
    if (o.kind === "rows") return { rows: project(o.rows), fallback: false, loading: false };
    if (o.kind === "unsupported") return { rows: scoped, fallback: false, loading: false };
    return { rows: project(o.fallbackRows), fallback: true, loading: false };
  }, [scope, scopedChoice, hasDiscovery, discovery.outcome, catalog.rows, catalog.phase]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return list.rows;
    // The provider shortcut is matched too, which is how provider scoping survives
    // the rail's deletion: typing `kc` narrows to Kimi Coding in three keystrokes.
    return list.rows.filter(
      (r) =>
        r.model.id.toLowerCase().includes(needle) || r.shortcut.toLowerCase().startsWith(needle)
    );
  }, [list.rows, filter]);

  // ── in-flight affordances ───────────────────────────────────────────────────
  const busy = providers.probing || catalog.phase !== "ready" || discovery.busy;
  const frame = useAnimationFrame(busy);
  const tasks = buildLoadTasks({
    creds: providers.probing ? { done: providers.done, total: providers.total } : null,
    catalog: catalog.phase !== "ready",
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
  const rowLayout = deriveRowLayout(layout.inner, { mark: list.fallback });

  // The cursor can outlive the list it indexed — a filter keystroke, or a scope
  // whose roster came back shorter than the last one's.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, Math.max(0, shown.length - 1))));
  }, [shown.length]);

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
  // cannot express (`esc`, `enter`, the arrows) plus three letters, and those three
  // are live ONLY while the filter is empty and `/` has not been pressed: once
  // anything is typed they are letters again, because a user typing `phi` must get
  // `phi` and not the provider dialog.
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
      if (name === "escape" || key.raw === "p") {
        setView("models");
        return;
      }
      if (name === "up" || name === "down") {
        const d = name === "up" ? -1 : 1;
        setProviderCursor((c) => Math.max(0, Math.min(providers.rows.length - 1, c + d)));
        return;
      }
      if (name === "return" || name === "enter") {
        const chosen = providers.rows[providerCursor];
        if (chosen) {
          setScope(chosen.value);
          setFilter("");
          setCursor(0);
        }
        setView("models");
      }
      return;
    }

    if (name === "escape") {
      if (filter !== "" || typing) {
        setFilter("");
        setTyping(false);
        setCursor(0);
        return;
      }
      if (scope !== null) {
        setScope(null);
        setCursor(0);
        return;
      }
      onDone(null);
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
    if (commandsLive && key.raw === "p") {
      setProviderCursor(
        Math.max(
          0,
          providers.rows.findIndex((r) => r.value === scope)
        )
      );
      setView("providers");
      return;
    }
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
      // p / c / r as commands". See `typing`.
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
      <Dialog
        key="custom"
        title="type a model spec"
        status="provider@model"
        width={layout.width}
        marginLeft={layout.marginLeft}
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
    );
  }

  if (view === "providers") {
    const readyCount = providers.ready.length;
    // Two rows taller than the model list: this dialog spends no column header
    // and no selection line, so the rows it saves go back to the rows.
    const providerRows = layout.listRows + 2;
    const providerTop = scrollWindow(providerCursor, providers.rows.length, providerRows);
    const providerWindow = providers.rows.slice(providerTop, providerTop + providerRows);
    return (
      <Dialog
        key="providers"
        title="providers"
        status={`${readyCount} of ${providers.total} have credentials`}
        width={layout.width}
        marginLeft={layout.marginLeft}
      >
        {providerWindow.map((r) => (
          <ProviderRow
            key={r.value}
            label={r.label}
            shortcut={r.shortcut}
            readiness={r.readiness}
            billing={r.billing}
            count={catalog.counts.get(r.value) ?? null}
            hasDiscovery={r.hasDiscovery}
            note={r.envVar === "" ? "needs sign-in" : `needs ${r.envVar}`}
            cursor={r.value === providers.rows[providerCursor]?.value}
            inner={layout.inner}
          />
        ))}
        {/* 31 providers do not fit in eleven rows, and a list that silently stops at
            twelve is the same unexplained absence this feature exists to remove. */}
        <HintRow
          text={
            providers.rows.length > providerWindow.length
              ? `${providerCursor + 1} of ${providers.rows.length} — ↑↓ for more`
              : ""
          }
          width={layout.inner}
        />
        {providers.notEnabledLocal.length > 0 ? (
          <HintRow
            text={`${providers.notEnabledLocal.join(", ")} — local, not enabled in your config`}
            width={layout.inner}
          />
        ) : null}
        <Rule />
        <Hints
          hints={[
            { key: "↑↓", label: "move" },
            { key: "⏎", label: "show only this provider" },
            { key: "esc", label: "back to all models" },
          ]}
        />
      </Dialog>
    );
  }

  if (phase === "loading") {
    return (
      <Dialog
        key="loading"
        title={scope === null ? "choose a model" : scopedName}
        status="finding models…"
        width={layout.width}
        marginLeft={layout.marginLeft}
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
        <Hints hints={[{ key: "esc", label: "cancel" }]} />
      </Dialog>
    );
  }

  const status =
    scope === null
      ? `${list.rows.length} models · ${providers.ready.length}/${providers.total} providers`
      : (notice?.title ?? `${list.rows.length} models`);

  return (
    <Dialog
      key="models"
      title={scope === null ? "choose a model" : scopedName}
      status={status}
      width={layout.width}
      marginLeft={layout.marginLeft}
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
        height={Math.min(layout.listRows, Math.max(1, window.length))}
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
              shortcut={r.shortcut}
              price={r.price}
              layout={rowLayout}
              cursor={top + i === cursor}
              origin={list.fallback ? "catalog" : "roster"}
            />
          ))
        )}
      </box>

      {/* ONE status row, ALWAYS rendered — see `CHROME_ROWS`. It carries the
          scroll position when the list overflows, the pending sweep when work is
          still in flight behind a usable list ("models appear as soon as they are
          ready" is a promise the screen has to keep), and nothing otherwise. */}
      <HintRow text={statusRow(cursor, shown.length, window.length, tasks)} width={layout.inner} />

      <Rule />
      <SelectionLine
        model={selected?.model ?? null}
        spec={selected?.spec ?? null}
        width={layout.inner}
      />
      <Hints
        hints={[
          { key: "↑↓", label: "move" },
          { key: "⏎", label: "select" },
          { key: "/", label: "filter" },
          ...(scope !== null && hasDiscovery ? [{ key: "r", label: "retry" }] : []),
          { key: "p", label: "providers" },
          { key: "c", label: "custom" },
          { key: "esc", label: filter !== "" ? "clear" : scope !== null ? "all models" : "cancel" },
        ]}
      />
    </Dialog>
  );
}

/** The banner's half of the inline row budget. */
const MAX_BANNER_ROWS = 5;

/**
 * The one status row's text, in priority order: where the cursor is in a list
 * longer than the window, then what is still loading, then nothing.
 *
 * Pure so the priority can be asserted. The scroll position wins over the pending
 * sweep because it changes on every keypress and the sweep changes once.
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
    return `no credential for any of the ${providers.total} providers — press p to see what each one needs`;
  }
  if (total === 0) return `no catalog entries for ${scopedName || "these providers"}`;
  return "nothing to show";
}
