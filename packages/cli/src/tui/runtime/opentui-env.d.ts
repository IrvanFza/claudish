/**
 * runtime/opentui-env.d.ts — the React 19 / OpenTUI type reconciliation, and the
 * one place that records what the type system will and will not catch for you.
 *
 * THE MISMATCH this file exists for: React 19 lets a component return `ReactNode`
 * (which includes `undefined`), while OpenTUI's intrinsic elements were typed to
 * accept `ReactElement | null`. A component written the idiomatic React 19 way —
 * `function Row(): ReactNode` — was then rejected as a child of `<box>`.
 *
 * MEASURED 2026-07-30 against the pinned binding: it now declares
 * `type Element = React.ReactNode` in its own `jsx-namespace.d.ts`, so the widening
 * below is INERT at this pin. It is kept because it costs nothing and because a
 * project pinning an older binding — or a `.tsx` that misses the `jsxImportSource`
 * pragma and falls back to the global JSX namespace — still needs it. Verify with
 * `bun run typecheck`, not by trusting this comment. */
import type { ReactNode } from "react";

declare global {
  namespace JSX {
    /** Agree with OpenTUI's own `Element`, so a component may return `undefined`. */
    type Element = ReactNode;
  }
}
