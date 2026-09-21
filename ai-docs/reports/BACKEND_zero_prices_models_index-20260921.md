# To models-index: the rename and the Poe pick landed, and one new price defect

Ready to send. Everything below was read from the live service today, generation
`g-20260921062451697-f490edba`.

---

**Re: `pricing.type` and the Poe pick are live — thank you; one data defect to fix**

Both items we were waiting on are delivered and correct on our side. We read them live and then
through our own reader.

- **The discriminator is `type`.** The pricing object's keys are now
  `batchDiscountPct, cachedRead, cachedWrite, input, output, tiers, type`. The old spelling is
  gone entirely, which is exactly what we asked for — no alias to carry on either side. Values:
  `flat` 975, `unavailable` 467, `free` 30, `tiered` 28. claudish reads `type` and only `type`.
- **The Poe pick is published.** `probeModels` now returns `poe/gateway` →
  `gemini-3.8-flash`, where it previously reported `no_verified_probe_model`. It survives our
  route-to-provider mapping and reaches our probe path unchanged. 25 picks, 5 unavailable
  routes, and all five of those are `client_model_selection_required`
  (`antigravity`, `grok-subscription`, `vertex`, `sakana-subscription`, `devin`) — the four
  dynamic subscriptions plus Vertex, which is the agreed design rather than a gap.
- **Our reader.** A forced refresh reads 1,123 entries across 2 pages on that generation. Of
  1,734 mapped connections, 923 now carry a price we can order by and 811 do not.

## The defect: 167 metered connections quote a price of zero

167 connections publish `type: "flat"` with `input: 0` and `output: 0`. By route:

| Route | Zero-priced connections |
|---|---|
| `together-ai/gateway` | 163 |
| `openrouter/gateway` | 3 |
| `opencode/zen` | 1 |

Examples on `together-ai/gateway`: `glm-5.3-fp8`, `glm-5.3-fp8-lora`, `minimax-h3`, `flux-3`,
`seedance-2.5`, `flash-image-3.1-lite`. Together AI charges for all of those, so zero is not
their price — it is a price nobody measured, published as if it were measured.

Why it matters more than an unpriced row: **zero is the strongest possible price.** A consumer
ordering connections by cost puts a zero first, so the effect of a missing measurement is to
PROMOTE that connection above every genuinely cheap one. An `unavailable` row merely sorts last.
This is the one direction in which a data gap costs a user money rather than a better option.

What we ask: publish `type: "unavailable"` where the rate is unknown, and reserve zero for a rate
that is genuinely zero. The contract already separates those two cases cleanly, and 30
connections use `type: "free"` correctly today.

**What claudish does until then.** We treat a `flat` or `tiered` price summing to exactly zero as
unknown, so those 167 connections sort last instead of first. The rule is asymmetric on purpose:
a zero on ONE side is kept, because free input with paid output is a real tariff. Only zero on
both sides is rejected. We would rather delete that rule than keep it — it is a guess about your
data, which is exactly what both sides agreed to avoid — so it goes as soon as the rows say
`unavailable`.

## A short list of first-party models that may be missing their vendor's own route

Low priority, and we checked carefully before sending it, because our first pass at this was
wrong. Counting raw totals suggested your own-API coverage was badly incomplete (deepseek 2 of 34,
qwen 136 of 240). It is not. Vendors expose only current models on their own APIs, and once retired
generations, open-weight releases, gateway quantizations (`-fp8`, `-fp4`, `-lora`), provider-suffixed
variants (`-di`, `-n`, `-el`, `-fw`) and route variants (`kimi-k3-256k`) are excluded, your coverage
matches what the vendors actually host. DeepSeek publishing only `deepseek-v4.1-flash` and
`deepseek-v4-pro` on `deepseek/direct-api` is correct; z-ai's 11 and MiniMax's 8 are their current
lineups.

What is left after that filter is a handful we believe the vendor does host:

| Model | Expected route | Note |
|---|---|---|
| `glm-4.5v`, `glm-4.6v`, `glm-5v-turbo` | `z-ai/direct-api` | Z.ai's own API serves its vision models |
| `glm-4.7-flash` | `z-ai/direct-api` | the rest of the 4.7 line is mapped |
| `kimi-k2-0905` | `moonshotai/direct-api` | |
| `minimax-m2-her`, `minimax-m1` | `minimax/direct-api` | |

Each may have a reason we cannot see — a retirement, a region, a different endpoint. Treat the list
as a question rather than a defect report.

## Nothing else outstanding from our side

The two design answers we sent still stand: unknown modalities as an absent field are right for
us, and we order tiered prices by the first tier, never averaging tiers and never choosing a tier
from a request's size. Modalities are in use now — the catalog's `outputModalities` decides
whether claudish offers a model as a chat model, in both directions, and 16 models whose names
look non-chat but whose published output includes text stopped being hidden by our old name rule.
