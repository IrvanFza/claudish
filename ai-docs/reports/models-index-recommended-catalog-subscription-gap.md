# models-index gap: `subscriptionPlans` does not reach the recommended catalog

**For:** the `models-index` repo (MadAppGang/models-index)
**Filed from:** claudish, 2026-08-18
**Status:** open — claudish side is fixed and shipped; the remaining half is backend data

---

## One-line ask

`?catalog=recommended` should emit the `subscription` object for every model whose full
document carries `subscriptionPlans`. Today it does so for some models and not others, and
claudish cannot tell the difference from the outside.

---

## Why this matters

Claudish renders a model's price in `--models-top` and in the MCP `list_models` tool. When a
model has no per-token rate it used to print a bare `N/A`, which reads as *"unknown / never
provisioned"*. That is not a cosmetic problem: it caused a real mis-triage. A reporter looked
at `swe-1.7` showing `N/A`, concluded the model was not provisioned, and filed it as
unroutable — while `dv@swe-1.7` was serving 509-token replies the whole time.

**`N/A` is usually the truthful answer for these models.** They are subscription-only and the
vendor publishes no standalone per-token rate — and the catalog says so, per model, in
`pricingSummary`. The problem was never the missing number; it was that claudish had no way to
say *why* it was missing.

Claudish now renders `SUB` (its existing flat-rate label) whenever a model has no rate **and**
the recommended catalog names a subscription that includes it. That fix is live. It works for
exactly the models the backend supplies `subscription` for.

---

## The measured gap

Both models below are subscription-only with no published per-token rate. Both should render
`SUB`. Only one does, because only one carries `subscription` on the recommended catalog.

### `swe-1.7` — correct today

```jsonc
// GET ?search=swe-1.7
{ "modelId": "swe-1.7",
  "subscriptionPlans": ["cognition-devin"],
  "pricingSummary": "SWE-1.7 is available in Devin (Web, Desktop, and CLI) via Cerebras at
                     1000 TPS. Cognition does not publish standalone token pricing, context
                     window, or max output token limits for this model row." }

// GET ?catalog=recommended
{ "id": "swe-1.7",
  "pricing": { "input": "N/A", "output": "N/A", "average": "N/A" },
  "subscription": { "prefix": "dv", "plan": "Devin", "command": "dv@swe-1.7" } }   // ✅ present
```

claudish renders: **`SUB`** (and `SUB (Devin)` on markdown surfaces).

### `glm-5.3` — the gap

```jsonc
// GET ?search=glm-5.3
{ "modelId": "glm-5.3",
  "subscriptionPlans": ["z-ai-glm-coding-plan"],                                    // ← known here
  "pricingSummary": "Available to all GLM Coding Plan users; Z.ai says the standalone API is
                     coming soon, so it does not yet publish a per-token API rate for this
                     model.",
  "contextWindow": 1000000, "maxOutputTokens": 128000 }

// GET ?catalog=recommended
{ "id": "glm-5.3",
  "pricing": { "input": "N/A", "output": "N/A", "average": "N/A" },
  /* no "subscription" key */ }                                                     // ❌ absent
```

claudish renders: **`N/A`** — indistinguishable from a model nobody can reach.

Counts at time of filing: the recommended catalog returns **30** models, **10** of which carry
`subscription`. `glm-5.3` is not one of them despite having `subscriptionPlans` upstream.

---

## Suggested fix

In whatever projection builds `?catalog=recommended`, derive `subscription` from the model
document's `subscriptionPlans` rather than from a separate source, so the two endpoints cannot
disagree. `z-ai-glm-coding-plan` maps to claudish's `gc@` GLM Coding Plan provider, so the
entry would be roughly:

```jsonc
"subscription": { "prefix": "gc", "plan": "GLM Coding Plan", "command": "gc@glm-5.3" }
```

If a plan id has no claudish prefix, emitting `{ "plan": "<name>" }` alone is still a strict
improvement — claudish only needs `plan` to render `SUB`, and `prefix`/`command` are used for
the `via:` line.

---

## Two smaller notes, same area

1. **Field name.** Claudish's `ModelDoc` declared `availableInPlans` and read it nowhere,
   while the API sends `subscriptionPlans`. Fixed on the claudish side — flagged only in case
   `availableInPlans` is a name the backend once used and something else still reads it.

2. **`pricingSummary` is not on the recommended catalog.** It is the single most useful
   sentence for explaining an absent price, and it exists per model on `?search=`. If it were
   included in the recommended projection, claudish could show the vendor's own reason instead
   of a two-letter label. Not required for the fix above — `subscription` alone resolves the
   mis-triage — but it would make the answer self-explaining.

---

## What claudish will NOT do

Per the repo boundary rule, claudish does not paper over catalog gaps in the CLI: no per-model
cloud lookup to fill in missing fields (`catalog-client.ts` is explicit that re-querying the
cloud one model at a time is not how this works), and no hardcoded model→plan table. Until the
recommended catalog carries `subscription` for `glm-5.3`, claudish will keep rendering `N/A`
for it — correctly, because from claudish's side that is genuinely unknown.
