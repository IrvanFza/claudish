---
name: terminology
description: "Project vocabulary — one name per concept"
keep-coding-instructions: true
generated-by: "claudeup Styles tab, filled from the codebase by Claude Code."
---

### Terminology

One concept, one name, everywhere: code, comments, commit messages, docs, and
conversation. A concept with two names reads as two concepts.

| Use | Not | Because |
|---|---|---|
| provider shortcut | prefix | prefix is already taken three ways in `provider-definitions.ts` — `legacyPrefixes` (`g/`), `modelPrefix`, and vendor prefixes like `qwen/` — so it never says which one you mean |
| bare name | unprefixed model | bare name is what `route()` and every routing doc call a model with no `provider@`, and a second term reads as a second concept |
| routing chain | fallback chain | fallback properly names only the last-resort `defaultProvider` hop, not the whole credential-filtered candidate list |
| metered | pay-as-you-go | the pricing code and tests say metered; PAYG survives only in the `qwen-payg` provider name and its picker label |
| subscription | plan | plan is the vendor's product name (Coding Plan, Token Plan) while `SUBSCRIPTION_PROVIDERS` is claudish's own billing category |
| roster | catalog | a roster is the live per-account served set, the catalog is hosted models-index metadata, and blurring them is how hardcoded model data sneaks in |
| picker | selector | docs, tests, and constants (`PICKER_ORDER`, `isPickableProvider`) say picker even though the file is `model-selector.ts` |
| foreign model | external model | the antonym of native is foreign (`forceForeignModel`), and a local Ollama model is external to nothing yet still foreign to the harness |
| harness | host | harness means Claude Code driving the session, while host already names the MCP host that spawns the server |
| hydrate | resolve | resolving fetches a secret from 1Password, hydrating writes it into `process.env`, and the prehydration fix depends on that difference |
| stream format | wire format | wire format is a converter's whole request/response encoding, stream format only the SSE dialect a parser consumes |
| model spec | model string | a spec (`provider@model`) is explicit and self-describing on argv while a bare name still has routing ahead of it |

Rules that hold regardless of the table above:

- Use the domain's word, not the implementation's. If the business calls it a
  "booking", the code and the conversation say booking, even where the table
  is named `reservations`.
- Do not invent a synonym for a term the codebase already uses. Grep before
  naming anything new.
- When the code and the domain disagree on a name, say which you are using and
  which the reader will see in the file.
- Keep abbreviations out of names people say out loud. `usr`, `mgr`, and `cfg`
  save four characters and cost a re-read every time.
