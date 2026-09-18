# Verification: the models-index v3 reader handoff, against the live catalog

**Date:** 2026-09-19 (checks run 2026-09-18, UTC)
**Handoff verified:** `models-index/docs/reviews/2026-09-19-claudish-v3-reader-handoff.md`, with its evidence in `2026-09-19-catalog-v3-cutover-bug-report.md`
**Method:** live public endpoints, with the v3 `Accept` header, cache bypassed, and every read pinned to one generation. The backend repository was read at the deployed commit `42358be` and never modified.
**Script:** `ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.ts`

## Result

Every backend claim in the handoff holds: **48 of 48 checks pass** against generation `g-20260918181642356-73127622`. The shared Alibaba contract's own promises hold too: **10 of 10**.

The claims about claudish also hold. Released 9.7.1 cannot read v3, Poe's factory is unimplemented, and the Vertex transport exists.

The checks also surfaced three things the reader must do that the handoff does not spell out. Four pieces of claudish work are missing, and one piece of existing, unmerged claudish work conflicts with the handoff. All are listed below.

## Backend claims

| Handoff claim | Live result | Evidence |
|---|---|---|
| Runtime v1.2.84 | ✓ | `queryVersion` → `{"version":"1.2.84","deploymentRevision":"queryversion-00103-zoc"}` |
| Active generation `g-20260918181642356-73127622` | ✓ | every model page, plans, probes and OpenAPI carry it |
| 1,301 models | ✓, **only with `status=all&includeRouteVariants=true`** | see reader requirement R1 |
| 19 plans | ✓ | |
| 30 route profiles | ✓ | `RouteBindingV3` in the live OpenAPI has 30 alternatives |
| 23 verified probe selections | ✓ | `probeModels.data.routes` |
| 7 explicit unavailable reasons | ✓ | 5 × `client_model_selection_required` (Antigravity, SuperGrok, Devin, Qwen Coding Plan, Sakana Fugu subscription); 2 × `no_verified_probe_model` (Poe, Vertex) |
| Contract 3 is required | ✓ | `queryModels`, `queryPlans` and `probeModels` answer 426 `catalog_client_upgrade_required` without the header |
| Generation-pinned pagination | ✓ | the cursor encodes its generation; a cursor plus a different `generationId` → 400 `invalid_cursor`; an unknown generation → 410 `generation_gone`; plans and probes honour `generationId` |
| Twelve subscription bindings | ✓ | all 12 are registered and each appears in exactly one probe map |
| Five gateway profiles | ✓ | OpenRouter 470 connections, Together 239, Fireworks 21 with verified picks; Poe and Vertex are registered with `no_verified_probe_model` |
| Alibaba memberships exactly 10 / 20 / 31 | ✓ | the plan inclusions and the model-side `subscriptionPlanIds` agree |
| Both probe maps, filtered by `routeId` | ✓ | `?routeId=qwen` → 2 routes and 1 unavailable |
| Grok video booleans | ✓ | `grok-imagine-video`: `videoInput:true`, `videoOutput:true`. `grok-imagine-video-1.5`: `videoInput:false`, `videoOutput:true` |
| OpenRouter restored | ✓ | 470 mapped `openrouter/gateway` connections (0 before) |

### The shared contract's own promises

models-index `ai-docs/alibaba-provider-changes.md` makes promises the handoff does not repeat. **10 of 10 pass** on the same generation, via `VERIFY_models_index_v3_contract-20260919.ts`:

| Promise | Live result |
|---|---|
| Coding Plan published as unknown, with no callable route | `routeStatus: unknown`, `routeReason: authenticated_account_roster_required`, no `route` |
| Coding Plan kept out of recommendations and defaults | 0 mentions in `catalog=recommended` and in `queryPluginDefaults` |
| An unknown connection is never callable | 372 unknown rows, 0 with `externalModelId` or `route`, all 372 with `observedExternalModelId`. Reasons: `unsupported_provider` 268, `unverified_mapping` 94, `mutable_pointer_only` 8, `identity_conflict` 2 |
| Every mapped connection is callable | 0 mapped rows without `externalModelId` |
| PAYG is metered, not a subscription record | no plan is bound to `qwen/dashscope-direct` |
| Token Plan Individual and Team stay separate records | two plans, both bound to `qwen/qwencloud-token-plan` |
| One video field per direction, no duplicate | exactly `videoInput` and `videoOutput` |
| Redirects published | 3, all on `z-ai/glm-coding-subscription`, e.g. `GLM-4.7` → `glm-5.3-flash` |
| Membership coverage on every plan | present on all 19 |

Not a failure, but worth a look given the rule that static values match: the contract calls the products "Alibaba Coding Plan" and "Alibaba Token Plan", while the plan records are named "Alibaba Cloud Model Studio Coding Plan", "QwenCloud Token Plan Individual" and "QwenCloud Token Plan Team Edition". Those are commercial plan names rather than product labels, so they may be intended.

### The six wire translations

Every connection on these profiles publishes an exact `externalModelId`. Examples:

| Profile | Connections | Translate | Examples |
|---|---|---|---|
| `minimax/direct-api` | 8 | 8 | `minimax-m3` → **`MiniMax-M3`**, `minimax-m2.7` → `MiniMax-M2.7` |
| `ollama/cloud` | 24 | 24 | `kimi-k3` → `kimi-k3:cloud`, `glm-5.3` → `glm-5.3:cloud` |
| `opencode/zen` | 69 | 9 | `muse-spark-1.3` → `muse-spark-1.3-contributor-free` |
| `anthropic/direct-api` | 11 | 3 | `claude-opus-4-5` → `claude-opus-4-5-20251101` |
| `x-ai/direct-api` | 7 | 3 | `grok-4.20` → `grok-4.20-0309-reasoning` |
| `deepseek/direct-api` | 2 | 1 | `deepseek-v4.1-flash` → `deepseek-flash` |

## Reader requirements the verification surfaced

**R1. Read the complete projection.** The default `queryModels` projection returns 1,111 models. It omits 181 deprecated models and 9 route variants:

| Query | `total` |
|---|---|
| default | 1,111 |
| `status=active` | 1,033 |
| `status=all` | 1,292 |
| `status=all&includeRouteVariants=true` | **1,301** |

Plan memberships still point at deprecated models. On the default projection, 12 plan members have **no model row**, for example `kimi-k2.5` and `deepseek-v4-pro` in the Alibaba plans. A reader on the default projection would under-count 11 plans.

**R2. Pages are capped at 200.** A request for `limit=500` returns 200 rows. The complete catalog is 7 pages. Follow `nextCursor` until it is absent.

**R3. Membership is by distinct model.** Plan inclusions can name one canonical model under several wire ids. Anthropic has 22 inclusions for 11 models (dated and undated ids); ollama-cloud, opencode-go and streamlake each have one duplicate. `subscriptionPlanIds` already agrees with the distinct counts for all 19 plans, so use it, as the handoff says.

## Two bindings without a supported plan

These are consistent with the handoff, but the reader must route them by **binding**, not by plan:

- `qwen/modelstudio-coding-plan`: plan `alibaba-ai-coding-plan` is `routeStatus: unknown` with no route. The handoff says public coverage is 10 ids but account access is unknown; 9 connections are mapped.
- `sakana/fugu-subscription`: no plan names it at all. It is registered, and its probe entry is `client_model_selection_required`.

## Claudish: claims and gaps

| Handoff statement about claudish | Result |
|---|---|
| 9.7.1 cannot consume the live contract | ✓ true: no `Accept` header, so every read is a 426 |
| Poe's transport exists but its factory is unimplemented | ✓ true: `createHandler: noHandler("unimplemented", …)` at `provider-definitions.ts:909` |
| Vertex has a project-aware transport | ✓ `createHandler: vertexHandler` |

Missing on `main`, all needed for the handoff's release acceptance:

1. **No Together provider and no Fireworks provider.** The fixture binds `together` and `fireworks`, and dev validation must exercise all five gateway profiles. Each new provider needs entries in both `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`.
2. **No Coding Plan provider** (`qwen-coding`).
3. **Alibaba names differ from the handoff:**

| Product | Handoff | `main` | branch `worktree-qwen-token-plan` |
|---|---|---|---|
| Coding Plan | `qwen-coding` / `qcode` / `QWEN_CODING_PLAN_API_KEY` | not built | same as the handoff |
| Token Plan | `qwen-token-plan` / `qtoken` / `QWEN_TOKEN_PLAN_API_KEY` | `qwen-cloud` / `qc` / `QWEN_CLOUD_PLAN_API_KEY` | `qwen-cloud` / `qc`, `qtp` / `QWEN_TOKEN_PLAN_API_KEY` + alias `QWEN_CLOUD_PLAN_API_KEY` |
| PAYG | `qwen-payg` / `qpay` / `DASHSCOPE_API_KEY` | `qwen-payg` / `qp`, `dashscope` / `DASHSCOPE_API_KEY` | same as `main` |

The backend portal already shows users `qcode`, `qtoken` and `qpay`. claudish accepts none of them today, which is claudish's defect to fix.

4. **Poe cannot make a request** until its factory exists.

## Existing work that must be reconciled

Branch `worktree-qwen-token-plan` (worktree locked, 9 commits ahead of `main`, 34 behind, last commit 2026-09-17 22:59 UTC) already implements the three-product Alibaba split. It also contains:

- `feat(routing): gate the crossing from a subscription to metered billing`
- `fix(routing): close three gate bypasses and the over-block they hid behind`

The handoff says the opposite: "An available PAYG key is permission to use it", and the backend review adds "These corrections introduce no billing permission or fallback protection gate." Merging this branch as it stands would ship the gate. Decided below: the gate is not carried.

## Decisions (Jack, 2026-09-19)

1. **Reader ownership:** the claudish session `v3-subscription:blocks-everyone` owns the reader and coordinates the provider changes. It rebases the Alibaba work from `worktree-qwen-token-plan` instead of rewriting it, and it has told that session.
2. **No billing gate.** The reader follows the handoff: subscriptions → dynamic subscriptions → native API → aggregators → fallback, and a configured key is permission to use it. The two gate commits on `worktree-qwen-token-plan` are not carried.
3. **claudish adopts the backend's Alibaba identities exactly.** The static values in models-index `ai-docs/alibaba-provider-changes.md` are the single source: one spelling, and no aliases, migration shims, alternate credential names or retired-name diagnostics. The old names are removed, not deprecated.

| Product | Provider | Prefix | Credential | Binding |
|---|---|---|---|---|
| Alibaba Coding Plan (new) | `qwen-coding` | `qcode` | `QWEN_CODING_PLAN_API_KEY` | `qwen/modelstudio-coding-plan` |
| Alibaba Token Plan | `qwen-token-plan` | `qtoken` | `QWEN_TOKEN_PLAN_API_KEY` | `qwen/qwencloud-token-plan` |
| Alibaba PAYG | `qwen-payg` | `qpay` | `DASHSCOPE_API_KEY` | `qwen/dashscope-direct` |

Removed outright: provider `qwen-cloud`, prefixes `qc`, `qp` and `dashscope`, and the credentials `QWEN_CLOUD_PLAN_API_KEY` and `QWEN_API_KEY`.

The new gateway providers take the fixture's names, `together` and `fireworks`, because claudish has no earlier name to keep.

## Requests to the backend

**1. Reader ownership.** Your handoff lists claudish's reader-ownership prompt as pending. It is answered: one claudish session owns the reader, as the handoff asks. The portal identifiers, the binding fixture and `alibaba-provider-changes.md` are already correct, and claudish changes to match them.

**2. Retire "roster" from the wire contract (Jack, 2026-09-19).** The word carries two meanings in the contract today, and neither reader can tell which is meant. claudish already retired it for the same reason (commit `83f9afb`, "roster becomes the dynamic models catalog"). Static values must stay identical on both sides, so the rename happens in the backend first and claudish reads the new names.

- The **dynamic models catalog** is the per-credential model list a provider's discovery endpoint returns. It is never persisted.
- **Membership** is a plan's published member list, part of the cloud catalog. The handoff already uses this word: "Use `subscriptionPlanIds` for memberships".

| Current | Meaning | Requested |
|---|---|---|
| `authenticated_account_roster_required` (inclusion reason, and the Coding Plan's `routeReason`) | dynamic models catalog | **`dynamic_models_catalog_required`** (decided by Jack) |
| `authenticated_variant_roster_required` | dynamic models catalog | `dynamic_variant_catalog_required` |
| `rosterCoverage` | membership | `membershipCoverage` |
| `rosterRequirements` | membership | `membershipRequirements` |
| `rosterId` (in `rosterRequirements[]`) | membership | `membershipSourceId` |
| `RosterEntryV3` | membership | `MembershipEntryV3` |
| `rosters` (`ManualApprovalRequiredErrorV3`) | membership | `memberships` |
| `authoritative_roster_identity_unresolved` | membership | `authoritative_membership_identity_unresolved` |
| `no_exact_callable_roster` | membership | `no_exact_callable_membership` |
| `sourceText` prose: "account-specific Devin model roster", "account-specific Grok subscription roster" | dynamic models catalog | "account-specific Devin dynamic models catalog", and the same for Grok |
| `sourceText` prose: "exact roster not published" | membership | "exact membership not published" |

Only the first row's spelling is Jack's decision. The others are proposed to follow the same two terms; please confirm or adjust them in the change, and claudish will read whatever is published. The reader is being written now, so renaming before it ships means one migration instead of two.

Found by searching the live OpenAPI document and the live plan and probe data of generation `g-20260918181642356-73127622` for every occurrence of the word. The spec itself has no prose using it.

## Reproduce

```
bun run ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.ts
```

The script captures the whole generation into a new `ai-docs/sessions/` folder, which is gitignored, and prints PASS or FAIL per claim with its evidence.
