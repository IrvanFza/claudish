/** @jsxImportSource @opentui/react */
/**
 * picker/ModelPicker.tsx — the picker itself: two panes, one keyboard handler, and
 * nothing else.
 *
 * THIS FILE IS THE PROOF OF THE `tui/` STRUCTURE RULE, which is why it holds so
 * little. The three async domains live in three hooks (`usePickerProviders`,
 * `useCatalogModels`, `useProviderDiscovery`); the column arithmetic lives in
 * `layout.ts`; the rows, the chrome, the stats panel and the notice are each their
 * own module. What is left here is `filter`, `cursor`, `pane`, `selected`, one
 * `useKeyboard`, and composition JSX. If the rule were unusable it would show up
 * here first.
 *
 * NO AWAIT IS EVER SILENT, STRUCTURALLY RATHER THAN BY DILIGENCE. The rail is
 * derived synchronously, so the first frame is complete before any effect runs; every
 * loader is an effect; and every in-flight task draws an affordance whose SHAPE is
 * chosen by what the caller can actually measure — a determinate meter for the
 * credential fan-out (work done over work total), an elapsed-vs-deadline bar for the
 * one discovery path that has a published deadline, and an elapsed-only shimmer for
 * the three that do not. Nothing invents a denominator.
 *
 * CANCELLATION RETURNS A VALUE. Esc and Ctrl+C both call `onDone(null)`; nothing here
 * calls `process.exit`. The bootstrap's `finally` unmounts React and destroys the
 * renderer in that order, which is what restores the terminal with a fetch still in
 * flight.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type ModelInfo,
  buildExplicitModelSpec,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
} from "../model-selector.js";
import { EmptyState } from "../tui/components/EmptyState.js";
import { ErrorBanner } from "../tui/components/ErrorBanner.js";
import { useAnimationFrame } from "../tui/hooks/useAnimationFrame.js";
import { C } from "../tui/theme.js";
import { truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { Panel } from "../tui/viz/widgets.js";
import { DiscoveryNotice } from "./DiscoveryNotice.js";
import {
  DISCOVERY_DEADLINE_MS,
  type DiscoveryShape,
  type PickerDataSource,
} from "./PickerDataSource.js";
import { StatsStrip } from "./StatsStrip.js";
import { FilterStrip, LoadBar, type LoadTask, PickerFooter, PickerHeader } from "./chrome.js";
import { ModelDetail, ProviderDetail } from "./detail.js";
import { useCatalogModels } from "./hooks/useCatalogModels.js";
import { useDelayedVisible } from "./hooks/useDelayedVisible.js";
import { usePickerProviders } from "./hooks/usePickerProviders.js";
import { useProviderDiscovery } from "./hooks/useProviderDiscovery.js";
import { CHROME, derivePanes, deriveRailLayout, deriveRowLayout } from "./layout.js";
import {
  type ListOrigin,
  ModelRow,
  ProviderRailRow,
  RailHintRow,
  contextMeterPct,
  parseDisplayPrice,
  priceMeterPct,
} from "./rows.js";

/**
 * A quiet scrollbar, built PER CALL — `tokens.*` are reassigned in place on theme
 * detection, so a module-level object would copy the strings and pin the dark track
 * onto a light panel. Lifted from `resume-picker.tsx:636-641`, which learned it the
 * same way.
 */
function scrollbarOptions() {
  return {
    showArrows: false,
    trackOptions: { backgroundColor: tokens.bgPanel, foregroundColor: tokens.border },
  } as const;
}

/**
 * WHICH AFFORDANCE EACH IN-FLIGHT TASK EARNS — the honesty contract, as one pure
 * function so it can be asserted without a renderer.
 *
 * The credential sweep is the only task with a real denominator: the roster is derived
 * synchronously, so `done/total` is work done over work TOTAL. The GET half of
 * discovery has a published DEADLINE and gets an elapsed-vs-deadline bar whose label
 * says `deadline`, because a deadline is not progress. Everything else gets an elapsed
 * figure and a shimmer, which claims only that time is passing.
 *
 * There is deliberately NO `resolving prices` task. `buildDiscoveredModelOutcome`
 * resolves pricing inside the same await as the roster (the fallback leg it already
 * needed supplies it), so there is no second phase — and drawing a label for a phase
 * that never runs is the same lie as an invented denominator.
 */
export function buildLoadTasks(input: {
  creds: { done: number; total: number } | null;
  catalog: boolean;
  roster: { displayName: string; shape: DiscoveryShape; elapsed: number } | null;
  vendor: string | null;
}): LoadTask[] {
  const tasks: LoadTask[] = [];
  if (input.creds) {
    const { done, total } = input.creds;
    tasks.push({
      id: "creds",
      label: "checking credentials",
      pct: total > 0 ? (100 * done) / total : 0,
      value: `${done}/${total}`,
    });
  }
  if (input.catalog) tasks.push({ id: "catalog", label: "cloud catalog" });
  if (input.roster) {
    const { displayName, shape, elapsed } = input.roster;
    const secs = `${(elapsed / 1000).toFixed(1)}s`;
    tasks.push(
      shape === "deadline"
        ? {
            id: "roster",
            // `deadline` rather than `roster · deadline`: MEASURED at 145 columns with
            // three tasks sharing the row, the longer label truncated to
            // `OpenRouter roster · …` — dropping the one word that says this bar is a
            // clock and not a count of work done. The shortest label that keeps it wins.
            label: `${displayName} deadline`,
            pct: Math.min(100, (100 * elapsed) / DISCOVERY_DEADLINE_MS),
            value: `${secs} / ${(DISCOVERY_DEADLINE_MS / 1000).toFixed(1)}s`,
          }
        : { id: "roster", label: `${displayName} roster`, value: secs }
    );
  }
  if (input.vendor !== null) tasks.push({ id: "vendor", label: `${input.vendor} catalog` });
  return tasks;
}

export interface ModelPickerProps {
  source: PickerDataSource;
  /** A model spec, or `null` for cancelled. Called exactly once. */
  onDone: (spec: string | null) => void;
  /** Buffers a failed provider's diagnostic for the ONE write after teardown. */
  onDiscoveryFailure?: (provider: string, notice: readonly string[]) => void;
}

type Pane = "providers" | "models";
type Mode = "browse" | "filter" | "custom";

export function ModelPicker({ source, onDone, onDiscoveryFailure }: ModelPickerProps): ReactNode {
  const { width, height } = useTerminalDimensions();
  const providers = usePickerProviders(source);

  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("models");
  const [mode, setMode] = useState<Mode>("browse");
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState("");
  const [modelCursor, setModelCursor] = useState(0);
  const [showMissing, setShowMissing] = useState(false);

  // A provider whose probe came back `missing` is collapsed out of the rail, so the
  // cursor is pinned to a provider VALUE rather than to an index: an index would slide
  // under the user as ~30 probes settle during the first second.
  const railRows = useMemo(
    () =>
      providers.rows.filter(
        (r) => r.readiness !== "missing" || showMissing || r.value === selected
      ),
    [providers.rows, showMissing, selected]
  );
  const current = selected ?? railRows[0]?.value ?? null;
  const currentRow = providers.rows.find((r) => r.value === current) ?? null;
  const displayName = current === null ? "" : source.displayName(current);
  const hasDiscovery = currentRow?.hasDiscovery === true;

  const discovery = useProviderDiscovery(source, current, hasDiscovery, onDiscoveryFailure);
  const { catalog, list } = useCatalogModels(source, current, !hasDiscovery);

  // ── which list is on screen, and where it came from ──────────────────────────
  //
  // PROVENANCE IS A PROPERTY OF THE LIST, NOT OF A ROW. One value decides all three
  // encodings — the panel title, the per-row `CAT` chip and the banner's provenance
  // sentence — so they cannot disagree with each other. Sniffing `ModelInfo.source`
  // or `providerSlug` was the alternative and was wrong: `source` is a display label
  // set on BOTH paths, and `providerSlug` is set only by the catalog converters, so
  // the discriminant would have been the absence of an optional field.
  const listSource: { rows: ModelInfo[]; origin: ListOrigin; fallback: boolean; loading: boolean } =
    useMemo(() => {
      if (hasDiscovery) {
        const o = discovery.outcome;
        if (o === null) return { rows: [], origin: "roster", fallback: false, loading: true };
        if (o.kind === "rows")
          return { rows: o.rows, origin: "roster", fallback: false, loading: false };
        if (o.kind === "unsupported")
          return { rows: [], origin: "catalog", fallback: false, loading: false };
        return { rows: o.fallbackRows, origin: "catalog", fallback: true, loading: false };
      }
      return {
        rows: list.rows,
        origin: "catalog",
        fallback: false,
        loading: list.phase === "loading",
      };
    }, [hasDiscovery, discovery.outcome, list.rows, list.phase]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return listSource.rows;
    return listSource.rows.filter((m) => m.id.toLowerCase().includes(needle));
  }, [listSource.rows, filter]);

  // Meter bounds are taken over the VISIBLE list, so the comparison a reader makes is
  // always against what they can see. Re-derived when the filter changes, which is
  // what makes a narrowed list re-scale rather than flatten.
  const bounds = useMemo(() => {
    const ctx = shown.map((m) => m.contextLength ?? 0).filter((n) => n > 0);
    const prices = shown
      .map((m) =>
        current === null ? undefined : parseDisplayPrice(resolveProviderDisplayPrice(current, m))
      )
      .filter((n): n is number => n !== undefined && n > 0);
    return {
      ctxMin: ctx.length > 0 ? Math.min(...ctx) : 0,
      ctxMax: ctx.length > 0 ? Math.max(...ctx) : 0,
      priceMin: prices.length > 0 ? Math.min(...prices) : 0,
      priceMax: prices.length > 0 ? Math.max(...prices) : 0,
    };
  }, [shown, current]);

  // ── layout ──────────────────────────────────────────────────────────────────
  const panes = derivePanes(width);
  const rowLayout = deriveRowLayout(panes.rowCells, { mark: listSource.fallback });
  const railLayout = deriveRailLayout(panes.railInner);
  const twoRowHeader = height >= CHROME.headerTwoRows;
  const statsPanelled = height >= CHROME.statsPanel;
  const bannerBordered = height >= CHROME.bannerBordered;
  const bannerMax = bannerBordered ? 6 : 4;
  // A banner line sized to `width - 2` wrapped by exactly one column — MEASURED, and
  // the reason for the slack rather than the arithmetic: the box spends a border column
  // and a padding column, and the row still wanted one more. A wrapped line costs a row
  // out of a four-row budget, which is the one thing this banner cannot afford.
  const bannerWidth = width - 4;

  // ── in-flight affordances ───────────────────────────────────────────────────
  const busy =
    providers.probing || catalog.phase === "loading" || discovery.busy || listSource.loading;
  const frame = useAnimationFrame(busy);
  const showCreds = useDelayedVisible(providers.probing);
  const showCatalog = useDelayedVisible(catalog.phase === "loading");
  const showRoster = useDelayedVisible(discovery.busy);
  const showVendor = useDelayedVisible(listSource.loading && !hasDiscovery);

  const tasks = buildLoadTasks({
    creds: showCreds ? { done: providers.done, total: providers.total } : null,
    catalog: showCatalog,
    roster:
      showRoster && current !== null
        ? {
            displayName,
            shape: currentRow?.discoveryShape ?? "none",
            elapsed: discovery.startedAt === null ? 0 : Date.now() - discovery.startedAt,
          }
        : null,
    vendor: showVendor ? displayName : null,
  });

  // ── scroll sync: the cursor leads, the viewport follows ─────────────────────
  const modelScroll = useRef<ScrollBoxRenderable | null>(null);
  const railScroll = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const sb = modelScroll.current;
    if (!sb || shown.length === 0) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    if (modelCursor < top) sb.scrollTo({ x: 0, y: modelCursor });
    else if (modelCursor >= top + viewportH) sb.scrollTo({ x: 0, y: modelCursor - viewportH + 1 });
  }, [modelCursor, shown.length]);
  useEffect(() => {
    const sb = railScroll.current;
    if (!sb) return;
    const i = railRows.findIndex((r) => r.value === current);
    if (i < 0) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    if (i < top) sb.scrollTo({ x: 0, y: i });
    else if (i >= top + viewportH) sb.scrollTo({ x: 0, y: i - viewportH + 1 });
  }, [current, railRows]);

  // The cursor can outlive the list it indexed — a filter keystroke, or a provider
  // whose roster came back shorter than the last one's.
  useEffect(() => {
    setModelCursor((c) => Math.max(0, Math.min(c, Math.max(0, shown.length - 1))));
  }, [shown.length]);

  // ── keys: ONE handler, because `useKeyboard` is a BROADCAST ─────────────────
  //
  // Every mounted subscriber receives every key — no bubbling, no `stopPropagation` —
  // so mutual exclusion is hand-rolled. Two mutually exclusive halves: a text mode owns
  // every printable key, and browse mode owns the commands. Both modes are explicit
  // (entered with `/` and `c`) rather than type-to-filter, because `c` and `k` are
  // commands here and a filter that swallowed them would put the custom-spec hatch out
  // of reach — the cost `resume-picker.tsx` pays for `a` and `v`.
  const handleTextKey = (key: { name?: string; raw?: string }): void => {
    const name = key.name;
    const setter = mode === "custom" ? setCustom : setFilter;
    if (name === "escape") {
      if (mode === "filter") setFilter("");
      setMode("browse");
      return;
    }
    if (name === "return" || name === "enter") {
      if (mode === "custom") {
        const spec = custom.trim();
        if (spec) onDone(spec);
        return;
      }
      setMode("browse");
      setPane("models");
      return;
    }
    if (name === "backspace") {
      setter((v) => v.slice(0, -1));
      return;
    }
    const ch = key.raw;
    if (ch && ch.length === 1 && ch >= " " && ch !== "\x7f") {
      setter((v) => v + ch);
      setModelCursor(0);
    }
  };

  useKeyboard((key) => {
    const name = key.name;
    if (key.ctrl && name === "c") {
      onDone(null);
      return;
    }
    if (mode === "custom" || mode === "filter") {
      handleTextKey(key);
      return;
    }

    if (name === "escape") {
      if (filter) {
        setFilter("");
        return;
      }
      onDone(null);
      return;
    }
    if (name === "tab") {
      setPane((p) => (p === "providers" ? "models" : "providers"));
      return;
    }
    if (name === "left") {
      setPane("providers");
      return;
    }
    if (name === "right") {
      setPane("models");
      return;
    }
    if (name === "up" || name === "down") {
      const d = name === "up" ? -1 : 1;
      if (pane === "providers") {
        const i = railRows.findIndex((r) => r.value === current);
        const next = railRows[Math.max(0, Math.min(railRows.length - 1, (i < 0 ? 0 : i) + d))];
        if (next) {
          setSelected(next.value);
          setModelCursor(0);
        }
        return;
      }
      setModelCursor((c) => Math.max(0, Math.min(shown.length - 1, c + d)));
      return;
    }
    if (name === "return" || name === "enter") {
      if (pane === "providers") {
        setPane("models");
        return;
      }
      const model = shown[modelCursor];
      if (model && current !== null) {
        // The SAME spec builder the classic path uses, with the provider's own
        // externalId — `or@openai/gpt-5`, not the catalog's bare key. Every row is
        // provider-scoped, so no bare Claude name can leave this picker.
        onDone(buildExplicitModelSpec(current, resolveProviderExternalId(current, model)));
      }
      return;
    }
    if (name === "slash" || key.raw === "/") {
      setMode("filter");
      setPane("models");
      return;
    }
    if (key.raw === "c") {
      setMode("custom");
      return;
    }
    if (key.raw === "k") {
      setShowMissing((v) => !v);
      return;
    }
    if (key.raw === "@") {
      setPane("providers");
    }
  });

  // ── panel titles: the first of the three provenance encodings ───────────────
  const listLabel = listSource.fallback
    ? "cloud catalog (fallback)"
    : listSource.origin === "roster"
      ? "live roster"
      : "cloud catalog";
  // MEASURED: a title that fills the border exactly is DROPPED — `Panel` renders no
  // title at all rather than a clipped one, which turned the loudest provenance
  // encoding into an empty border. Six columns of slack, and the `⚠` that used to
  // prefix the fallback label is gone with it: the word `fallback` carries the meaning,
  // and `Panel`'s title colour is fixed chrome, so a glyph there could not have been
  // coloured to add anything.
  // The PROVENANCE must survive the truncation, so the title spends nothing on a word
  // the panel's own position already says. `models · …` was the first casualty of a
  // title clipped at 52 columns — and the half it clipped was `(fallback)`.
  const panelTitle = truncate(
    `${displayName || "—"} · ${listSource.rows.length} · ${listLabel}`,
    Math.max(8, panes.panelOuter - 8)
  );

  const missingCount = providers.missing.length;
  const notEnabled = providers.notEnabledLocal.length;
  // THE DETAIL BLOCKS ARE HEIGHT-GATED, and 26 rows is where the trade flips. Below it
  // every row belongs to the list, and two rows of prose would cost two GRAPHICS rows —
  // the wrong direction for the whole-frame density count. Above it a short list leaves
  // its panel half empty, and the description the inquirer picker used to show has
  // somewhere to go.
  const showDetail = height >= CHROME.detail;
  const cursorModel = shown[modelCursor] ?? null;
  const cursorSpec =
    cursorModel === null || current === null
      ? null
      : buildExplicitModelSpec(current, resolveProviderExternalId(current, cursorModel));

  return (
    <box flexDirection="column" height={height} backgroundColor={C.bg}>
      <PickerHeader
        right={`${providers.ready.length}/${providers.total} ready · ${catalog.phase === "failed" ? "catalog offline" : `${catalog.size} catalogued`}`}
        twoRows={twoRowHeader}
      />

      <LoadBar tasks={tasks} frame={frame} width={width} />

      <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
        {/* ── provider rail ───────────────────────────────────────────────── */}
        <box width={panes.railW} flexDirection="column" minHeight={0}>
          <Panel title="providers" focused={pane === "providers"} flush flexGrow={1} flexBasis={0}>
            <scrollbox
              ref={railScroll}
              focused={false}
              flexGrow={1}
              scrollbarOptions={scrollbarOptions()}
            >
              {railRows.map((r) => (
                <ProviderRailRow
                  key={r.value}
                  label={r.label}
                  readiness={r.readiness}
                  billing={r.billing}
                  count={r.value === current ? listSource.rows.length : null}
                  cursor={r.value === current}
                  focused={pane === "providers"}
                  layout={railLayout}
                />
              ))}
              {/* An unexplained absence is the defect class this feature is about, so
                  both absences are named. Neither row is selectable. */}
              {missingCount > 0 && !showMissing ? (
                <RailHintRow
                  text={`+${missingCount} need a key · k`}
                  width={railLayout.railInner}
                />
              ) : null}
              {notEnabled > 0 ? (
                <RailHintRow
                  text={`+${notEnabled} local not enabled`}
                  width={railLayout.railInner}
                />
              ) : null}
            </scrollbox>
            {/* Pinned UNDER the list, so a short rail's leftover space carries the
                selected provider's own copy instead of a void. `flexShrink={0}` lives
                inside the component: the scrollbox above asks for its entire content
                height and Yoga spreads that shortfall across every sibling. */}
            {showDetail && currentRow !== null ? (
              <ProviderDetail
                label={displayName}
                description={currentRow.description}
                envVar={currentRow.envVar}
                width={railLayout.railInner}
              />
            ) : null}
          </Panel>
        </box>

        {/* ── models + filter + shape ──────────────────────────────────────── */}
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <Panel title={panelTitle} focused={pane === "models"} flush flexGrow={1} flexBasis={0}>
            <scrollbox
              ref={modelScroll}
              focused={false}
              flexGrow={1}
              scrollbarOptions={scrollbarOptions()}
            >
              {shown.length === 0 ? (
                <EmptyState
                  label={emptyLabel(
                    listSource.loading,
                    filter,
                    listSource.rows.length,
                    displayName
                  )}
                  {...(filter ? { hint: "esc clears the filter · c types a spec" } : {})}
                />
              ) : (
                shown.map((m, i) => (
                  <ModelRow
                    key={`${m.id}-${i}`}
                    model={m}
                    layout={rowLayout}
                    cursor={i === modelCursor}
                    ctxPct={contextMeterPct(m.contextLength, bounds.ctxMin, bounds.ctxMax)}
                    pricePct={priceMeterPct(
                      parseDisplayPrice(
                        current === null ? "N/A" : resolveProviderDisplayPrice(current, m)
                      ),
                      bounds.priceMin,
                      bounds.priceMax
                    )}
                    priceText={current === null ? "N/A" : resolveProviderDisplayPrice(current, m)}
                    origin={listSource.fallback ? "catalog" : "roster"}
                  />
                ))
              )}
            </scrollbox>
            {/* What Enter will actually return, plus the description the old picker
                showed and this one would otherwise drop. */}
            {showDetail ? (
              <ModelDetail model={cursorModel} spec={cursorSpec} width={panes.panelOuter - 2} />
            ) : null}
          </Panel>

          <FilterStrip
            value={mode === "custom" ? custom : filter}
            active={mode !== "browse"}
            matches={shown.length}
            total={listSource.rows.length}
            width={panes.panelOuter}
            prompt={mode === "custom" ? "provider@model" : "filter"}
          />

          <StatsStrip
            shown={shown}
            total={listSource.rows.length}
            width={panes.panelOuter}
            panelled={statsPanelled}
            priceOf={(m) => (current === null ? "" : resolveProviderDisplayPrice(current, m))}
          />
        </box>
      </box>

      {/* The notice is pinned BELOW both panes and spans the full width: the failure is
          the context for the list above it, and a pinned region is the half of the fix
          the old inline stderr line could not provide. */}
      {discovery.outcome !== null && current !== null ? (
        <DiscoveryNotice
          outcome={discovery.outcome}
          displayName={displayName}
          width={bannerWidth}
          height={height}
          maxLines={bannerMax}
          bordered={bannerBordered}
        />
      ) : null}
      {catalog.phase === "failed" ? (
        <ErrorBanner
          severity="notice"
          lines={["The cloud catalog is unavailable — prices and capability flags may be missing."]}
          width={width - 2}
        />
      ) : null}
      {!hasDiscovery && list.phase === "failed" && current !== null ? (
        <ErrorBanner
          severity="notice"
          lines={[`${displayName}'s catalog list could not be loaded. Press c to type a spec.`]}
          width={bannerWidth}
        />
      ) : null}

      <PickerFooter
        hints={[
          { key: "↑↓", label: "move" },
          { key: "⏎", label: pane === "providers" ? "models" : "select" },
          { key: "/", label: "filter" },
          { key: "⇥", label: "pane" },
          {
            key: "k",
            label: missingCount > 0 ? `${missingCount} hidden` : "hidden",
            on: missingCount > 0,
          },
          { key: "c", label: "custom" },
          { key: "esc", label: filter ? "clear" : "cancel" },
        ]}
      />
    </box>
  );
}

/**
 * SAY WHICH EMPTY IT IS. "Nothing here" covers four different situations — still
 * loading, loaded and genuinely empty, filtered to nothing, and failed — and a picker
 * that prints one sentence for all four is the complaint this feature exists to fix.
 * The failed case never reaches here: it goes to the banner, which has a colour.
 */
function emptyLabel(loading: boolean, filter: string, total: number, displayName: string): string {
  if (loading) return `loading ${displayName || "models"}…`;
  if (filter) return `no model matches “${filter}”`;
  if (total === 0) return `no catalog entries for ${displayName || "this provider"}`;
  return "nothing to show";
}
