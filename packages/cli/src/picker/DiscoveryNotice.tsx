/** @jsxImportSource @opentui/react */
/**
 * picker/DiscoveryNotice.tsx — the four non-`rows` outcomes, rendered.
 *
 * THE WORDS ARE NOT THE DEFECT. Measured against a real 401, the old stderr warning
 * survived on screen in full — provider, cause, HTTP status, endpoint, upstream body,
 * the env var to inspect, where to get a key — and the user still read the short
 * fallback list below it as "this provider has no models". What was wrong was its
 * PRESENTATION: plain white body text for the most severe thing on screen, inline
 * rather than pinned, and a JSON body wrapped mid-word. So this file changes no
 * wording it can avoid changing; it supplies severity, a border, a row budget and a
 * truncation point.
 *
 * THREE TIERS, NEVER COLLAPSED TO ok/fail, copied from `TestResult`
 * (`tui/types.ts:79-107`) whose own comment says `unavailable` is "deliberately
 * neutral, not red":
 *
 *   · `failed`                                   → ERROR  (red on `C.bgError`)
 *   · `empty-roster` / `all-filtered` / `collapsed-empty` → NOTICE (`tokens.warn`)
 *   · `rows` / `unsupported`                     → nothing at all
 *
 * `unsupported` rendering nothing is the load-bearing half of that last row: ~25
 * pickable providers declare no `modelDiscovery`, and for them the catalog list IS
 * the normal, correct UI. A panel there would be noise on the majority case, which
 * is how a user learns to ignore the panel.
 */

import type { ReactNode } from "react";
import type { PickerDiscoveryOutcome } from "../model-selector.js";
import { type BannerSeverity, ErrorBanner } from "../tui/components/ErrorBanner.js";

/** What a notice is, before it is a component — pure, so it can be asserted. */
export interface NoticeContent {
  severity: BannerSeverity;
  /** One row each, in priority order. Never re-ordered by the renderer. */
  lines: string[];
  /** A chip at the head of row one, e.g. `HTTP 401`. */
  badge?: string;
  /** Drawn in the border, and only when the banner is bordered. */
  title: string;
}

/**
 * Collapse the stderr formatter's embedded newlines and indentation to one row, and drop
 * its leading `⚠`.
 *
 * The glyph is the STDERR path's severity marker, and it is the only one that path has.
 * Here the severity is carried by the banner's colour, its left rule and its title, so
 * the glyph would be a fourth encoding of a fact already stated three times — and it
 * costs two columns of a headline measured at exactly the frame width (MEASURED: an
 * 80-column banner line that fits without it wrapped with it, spending a row out of a
 * four-row budget). The stderr wording keeps it, unchanged, which is the whole point of
 * the formatter and the sink being separate.
 *
 * `.trim()` runs BEFORE the strip: the formatter's first line starts with a newline,
 * which the whitespace collapse turns into a leading SPACE, and `^⚠` then matches
 * nothing at all. Measured — the glyph survived the first version of this line.
 */
function oneRow(line: string): string {
  return line.replace(/\s+/g, " ").trim().replace(/^⚠\s*/, "");
}

/**
 * The provenance sentence — the line that says the list below is NOT the live
 * roster.
 *
 * It is the third of the three encodings of that one fact (the panel title and the
 * per-row `CAT` chip are the others), and it is never dropped, because it is the one
 * the user's own report was about. It says the same thing
 * `formatDiscoveryFailureNotice` says for the `catalog` fallback, so a reader who
 * sees both the panel and the scrollback line reads one sentence twice rather than
 * two sentences that have to be reconciled.
 */
function provenance(displayName: string): string {
  return `Showing ${displayName}'s cloud-catalog entries below — not its live roster.`;
}

/**
 * Outcome → banner content, or `null` when the outcome has nothing to say.
 *
 * NO STRING HERE INTERPOLATES AN OPTIONAL FIELD WITHOUT A GUARD. `endpoint` and
 * `status` are both optional on `DiscoveryFailure` — a registered fetcher may report
 * `unauthorized` with neither — and a rendered `undefined` is worse than a shorter
 * sentence. A test sweeps every variant × present/absent for both.
 */
export function discoveryNoticeContent(
  outcome: PickerDiscoveryOutcome,
  displayName: string
): NoticeContent | null {
  switch (outcome.kind) {
    case "rows":
    case "unsupported":
      // Nothing to say, and saying nothing is the decision — see the file header.
      return null;
    case "failed":
      return failedContent(outcome, displayName);
    case "empty-roster":
      return emptyRosterContent(outcome, displayName);
    case "all-filtered":
      return allFilteredContent(outcome, displayName);
    case "collapsed-empty":
      return collapsedContent(outcome, displayName);
  }
}

/** What to say when nothing supplied a fallback list either. */
function nextStep(hasFallback: boolean, displayName: string): string {
  return hasFallback ? provenance(displayName) : "Press c to type a model id directly.";
}

type Failed = Extract<PickerDiscoveryOutcome, { kind: "failed" }>;
type EmptyRoster = Extract<PickerDiscoveryOutcome, { kind: "empty-roster" }>;
type AllFiltered = Extract<PickerDiscoveryOutcome, { kind: "all-filtered" }>;
type Collapsed = Extract<PickerDiscoveryOutcome, { kind: "collapsed-empty" }>;

/**
 * THE WORDS ARE THE FORMATTER'S, NOT THIS FILE'S. `notice` arrives from
 * `formatDiscoveryFailureNotice` — the same array the stderr path writes — so the panel
 * and the scrollback line cannot drift apart. All that happens here is one row per
 * line, and the HTTP status moved into a chip.
 */
function failedContent({ failure, notice, fallbackRows }: Failed, _name: string): NoticeContent {
  const badge = failure.status === undefined ? undefined : `HTTP ${failure.status}`;
  const lines: string[] = [];
  for (const raw of notice) {
    const line = oneRow(raw);
    if (line === "") continue;
    // De-duplicate the status: it is the badge now, and spending nine columns of a
    // 78-column headline saying it twice costs the end of the sentence.
    lines.push(badge === undefined ? line : line.replace(` (${badge})`, ""));
  }
  return {
    severity: "error",
    lines,
    ...(badge === undefined ? {} : { badge }),
    title: fallbackRows.length > 0 ? "discovery failed · showing catalog" : "discovery failed",
  };
}

/**
 * NOTICE, NOT ERROR, and the distinction is the point: an endpoint that answers
 * correctly with nothing has not failed. Painting it red would teach the user to
 * ignore red. It stays visibly distinct from a rejected key in BOTH tier and copy,
 * which is what V7 asks for.
 */
function emptyRosterContent({ failure, fallbackRows }: EmptyRoster, name: string): NoticeContent {
  const at = failure.endpoint ? ` — the endpoint answered at ${failure.endpoint}` : "";
  return {
    severity: "notice",
    lines: [
      `${name}'s model list is empty${at} and listed nothing.`,
      nextStep(fallbackRows.length > 0, name),
    ],
    title: "empty roster",
  };
}

/**
 * The sample ids are what make this self-explaining: they are almost always
 * embeddings, speech models or wildcard routes, which a reader recognises at a glance
 * — and without them "none of them chat-capable" sounds like claudish's fault.
 */
function allFilteredContent(
  { servedCount, sampleIds, fallbackRows }: AllFiltered,
  name: string
): NoticeContent {
  const lines = [
    `${name} served ${servedCount} model${servedCount === 1 ? "" : "s"}, none of them chat-capable.`,
  ];
  if (sampleIds.length > 0) lines.push(`e.g. ${sampleIds.join(", ")}`);
  lines.push(nextStep(fallbackRows.length > 0, name));
  return { severity: "notice", lines, title: "nothing chat-capable" };
}

/** Defensive: unreachable through the one shipped resolver, and still rendered. */
function collapsedContent({ chatCount, fallbackRows }: Collapsed, name: string): NoticeContent {
  const lines = [
    `${chatCount} chat-capable model${chatCount === 1 ? "" : "s"} collapsed to zero choices — please report this.`,
  ];
  if (fallbackRows.length > 0) lines.push(provenance(name));
  return { severity: "notice", lines, title: "no choices" };
}

/**
 * Merge the two credential rows onto one when the width allows.
 *
 * `Check MOONSHOT_API_KEY (…)` and `Get a key: https://…` are one thought and, at
 * the measured 80-column case, 65 columns together — so merging buys a row back for
 * the list at no cost to the words. A long env var plus a long URL does not fit, and
 * then they stay two rows and the banner spends its fourth.
 */
export function mergeCredentialLines(lines: string[], width: number): string[] {
  const i = lines.findIndex((l) => l.startsWith("Check "));
  if (i < 0 || i + 1 >= lines.length) return lines;
  const next = lines[i + 1]!;
  if (!next.startsWith("Get a key:")) return lines;
  // The parenthetical ("a value in your shell overrides stored credentials") is the
  // part that does not fit, and it is advice rather than a fact the user must have —
  // the VARIABLE NAME is the fact, and it survives.
  // `\.?` because the formatter's line ends `(…).` — without it the parenthetical
  // survives, the merge overflows the width test, and the two rows never merge at all.
  const bare = lines[i]!.replace(/\s*\(.*\)\.?\s*$/, "");
  const merged = `${bare} · ${next}`;
  if (merged.length > width) return lines;
  return [...lines.slice(0, i), merged, ...lines.slice(i + 2)];
}

export interface DiscoveryNoticeProps {
  outcome: PickerDiscoveryOutcome;
  displayName: string;
  /** Usable columns, for truncation and for the merge decision. */
  width: number;
  /** Terminal rows, so the banner can choose its chrome budget. */
  height: number;
  /** Hard cap on content rows. 4 borderless, 6 inside a border. */
  maxLines: number;
  /** A full rounded border (2 rows) instead of the 1-column left rule (0 rows). */
  bordered: boolean;
}

/**
 * THE BANNER'S ROW BUDGET IS A BUDGET, NOT A PRIORITY ORDER — four rows at
 * `height < 30`, and the four lines that must never be dropped do not fit in four
 * rows WITH a border (the border alone is two of them). That contradiction is
 * resolved by measurement rather than by ranking: below 30 rows the banner is a
 * 1-column left rule in the severity colour, which costs one COLUMN and zero ROWS.
 *
 * Lines past `maxLines` are dropped from the END, which is the same order the design
 * names — the upstream `detail` body goes first because it is already the tail of
 * the truncated headline, then the sample ids. The full text is never lost: it goes
 * to the deferred stderr write after teardown, and to the debug log.
 */
export function DiscoveryNotice({
  outcome,
  displayName,
  width,
  maxLines,
  bordered,
}: DiscoveryNoticeProps): ReactNode {
  const content = discoveryNoticeContent(outcome, displayName);
  if (content === null) return null;
  const merged = mergeCredentialLines(content.lines, width);
  return (
    <ErrorBanner
      severity={content.severity}
      lines={merged.slice(0, Math.max(1, maxLines))}
      width={width}
      title={content.title}
      bordered={bordered}
      {...(content.badge === undefined ? {} : { badge: content.badge })}
    />
  );
}
