# Plan: the claudish catalog v3 reader

**Owner:** the claudish session `v3-subscription:blocks-everyone`
**Inputs:** the backend handoff (models-index `docs/reviews/2026-09-19-claudish-v3-reader-handoff.md`) and its verification, `VERIFY_models_index_v3_handoff-20260919.md`
**Decisions:** recorded in the verification report (no billing gate; Alibaba provider names kept; Token Plan key renamed)

## Design: translate once, at the edge

claudish reads v2 catalog vocabulary in many places. `aggregators[]` and its `provider` field alone are read in 17 files, across routing, pricing, the picker and the TUI probe. Rewriting every consumer would put billing-critical routing at risk in the same release.

The reader instead converts v3 into the internal shape those files already read, at one boundary. This works because every v3 route binding names exactly one claudish provider: `openai/codex-subscription` is `openai-codex`, and `qwen/qwencloud-token-plan` is `qwen-cloud`. After translation, an aggregator row's `provider` **is** the claudish provider name, and its external id is the published `externalModelId`. The handoff asks for the same thing: "Keep SDK provider names and prefixes in the client transport adapter."

What v3 can express and the internal shape could not must still survive the translation:

- `routeStatus: "unknown"` rows are **not routable**. They carry no callable id, so they are dropped from connections. Availability stays three-valued, and an unknown route never becomes "not served".
- `rosterCoverage` travels with each plan. Only complete, unexpired coverage licenses a "not served" answer.
- Plan membership comes from `subscriptionPlanIds`, counted by distinct model.

## The binding table

All 30 registered profiles, and the claudish provider each one means:

| Route profile | claudish provider | Note |
|---|---|---|
| `anthropic/claude-code-subscription` | `native-anthropic` | |
| `anthropic/direct-api` | — | Not mapped. The native route forwards Claude Code's own model ids and credentials, so it never needs a catalog wire id. Unchanged from today. |
| `cognition/devin-subscription` | `devin` | |
| `deepseek/direct-api` | `deepseek` | |
| `fireworks/gateway` | `fireworks` | **new provider** |
| `google/antigravity-subscription` | `antigravity` | |
| `google/direct-api` | `google` | |
| `minimax/coding-plan-subscription` | `minimax-coding` | |
| `minimax/direct-api` | `minimax` | |
| `mistralai/direct-api` | `mistralai` | |
| `moonshotai/direct-api` | `kimi` | |
| `moonshotai/kimi-code-subscription` | `kimi-coding` | |
| `ollama/cloud` | `ollamacloud` | |
| `openai/codex-subscription` | `openai-codex` | |
| `openai/direct-api` | `openai` | |
| `opencode/go-subscription` | `opencode-zen-go` | |
| `opencode/zen` | `opencode-zen` | |
| `openrouter/gateway` | `openrouter` | |
| `poe/gateway` | `poe` | needs its factory |
| `qwen/dashscope-direct` | `qwen-payg` | |
| `qwen/modelstudio-coding-plan` | `qwen-coding` | **new provider** |
| `qwen/qwencloud-token-plan` | `qwen-cloud` | |
| `sakana/direct-api` | `sakana` | |
| `sakana/fugu-subscription` | `sakana-subscription` | |
| `together-ai/gateway` | `together` | **new provider** |
| `vertex/google-cloud` | `vertex` | |
| `x-ai/direct-api` | `x-ai` | |
| `x-ai/supergrok-subscription` | `grok-subscription` | |
| `z-ai/direct-api` | `z-ai`, `glm` | Both use `https://api.z.ai`; they differ only in the key name (`ZAI_API_KEY`, `ZHIPU_API_KEY`). |
| `z-ai/glm-coding-subscription` | `glm-coding` | |

The local providers (`ollama`, `lmstudio`, `vllm`, `mlx`, `litellm`) have no catalog profile and are unaffected.

## Reconciling the work on `worktree-qwen-token-plan`

That session stopped on 2026-09-19 and holds 9 commits plus 72 uncommitted files (+1,175 / −3,228). The uncommitted files are unsigned, because 1Password refused there too. Its export is preserved in this worktree's session folder (`qwen-branch-handoff/uncommitted-vs-1e5e157.patch`, SHA-256 `c6967f95…`). The session's own map of what is safe to carry drives this table.

**Commits**

| Commit | Carry | Why |
|---|---|---|
| `c0ac7d8` failed vs absent credentials | yes | The readiness notices below depend on it. |
| `56066fc` gate subscription → metered | **no** | The billing gate. Jack decided against it. |
| `24d6074` gate bypasses | **split** | Drop the gate parts. Keep three fixes: `op-source.ts`, where `hasOpSources()` sniffed globally, so a locked 1Password marked a never-configured provider "failed" instead of absent; the readiness test that built the real `AntigravityCredentialProvider` and spawned a bare `security` against the login keychain (1 spawn before the fix, 0 after); and one `describeReadiness` per candidate in `routing-rules.ts`. |
| `fe8722e` stop persisting the dynamic catalog | yes, edited | Remove 1 gate line in `routing-rules.test.ts`. |
| `83f9afb` roster → dynamic models catalog | yes | It is independent of the gate. |
| `6b627f1` black-box tests | yes, edited | Drop `metered-fallback.ts` and `metered-fallback.blackbox.test.ts`. |
| `80ff29b`, `1e5e157` docs | yes, edited | Remove the gate passages (53 and 2 lines). |
| `0ba1bfa` three products | yes, edited | Remove `meteredFallbackDefault: "block"` from `qwen-coding` and the test that it blocks; apply Jack's names. |

**Uncommitted groups**

| Group | Carry | Why |
|---|---|---|
| A. rename to `qwen-token-plan`/`qtoken`/`qpay`, delete the aliases | **no** | Contradicts Jack's decision. The key rename is the one part kept, via the deprecated alias. |
| B. gate removal | only the log fix | The gate is never carried. Keep the fix for `routing-rules.ts` printing `[claudish] [claudish]`, a bug already on `main`. |
| C. video capability | yes | The handoff requires it: `videoOutput` excludes chat, `videoInput` alone never does, and the name-shaped rule applies only where the catalog has no row. Runtime-verified there on 6 cases. |
| D. public discovery is not entitlement | yes | The handoff requires it. `qwen-coding` lists its models without authentication, so its list proves coverage, not account access. Availability denies only on `"account"` evidence. |
| E. partial v3 join | no, rebuilt | It is unverified after a late edit, and this plan translates at the edge instead. Its `subscriptionPlanIds` handling is a reference. |
| F. tests and fixtures | with their groups | |

**Contract conflict to resolve with the backend.** models-index `ai-docs/alibaba-provider-changes.md` line 15 reads: "Product identities have one spelling and no aliases, migration shims, alternate credential names, or retired-name diagnostics." Its table names `qwen-token-plan` / `qtoken` / `qpay`. Jack's decisions keep `qwen-cloud` / `qc` / `qp` and deprecate `QWEN_CLOUD_PLAN_API_KEY` with a warning. That document must be amended, or the two sides disagree again.

## Slices

Each slice ends green and committed. Codex writes the tests from real captured responses; each slice is also checked against the live generation.

**1. Reader and edge translation. This alone restores the catalog.**
- `SUPPORTED_CONTRACT_VERSION` becomes 3. The v3 `Accept` header is sent on `queryModels`, `queryPlans` and `probeModels`.
- Walk `queryModels?status=all&includeRouteVariants=true` by `nextCursor`. Pages are capped at 200, so the full catalog is 7 pages.
- Pin `queryPlans` and `probeModels` to page 1's `generationId`. A 410 mid-walk restarts the walk once; a 503 or 426 keeps the current cache and the 9.7 guard.
- Translate through the binding table. The cache file records `contractVersion: 3` and the `generationId`, and a v2 cache on disk is refused, which forces one refresh after updating.
- Remove `FIREBASE_SLUG_TO_PROVIDER_NAME` from its 3 files; the binding table replaces it.
- Acceptance: 1,301 models and 19 plans read live. Alibaba memberships are 10/20/31 after translation. `minimax@minimax-m3` sends `MiniMax-M3`. A before/after table of bare-name routes shows no removed route.

**2. Probes.** Read both maps, keyed by binding. A `client_model_selection_required` or `no_verified_probe_model` entry goes to endpoint discovery, and the client never invents a model id.

**3. Providers.**
- `qwen-coding`, rebased from `worktree-qwen-token-plan` without its two billing-gate commits.
- The Token Plan key becomes `QWEN_TOKEN_PLAN_API_KEY`; `QWEN_CLOUD_PLAN_API_KEY` keeps working with a one-time deprecation warning.
- `together` and `fireworks` gateway providers, each in both `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`.
- Poe's provider factory.

**4. Roster coverage.** Expired or unknown coverage means "unknown", never "not served".

**5. Dev validation and release.** On the live generation, exercise everything the handoff's release acceptance lists:

- the 12 subscription bindings and 5 gateway profiles, with a real request wherever a credential exists;
- Alibaba memberships 10/20/31;
- the six wire translations;
- pinned pagination and both probe maps;
- unknown account access reaching client discovery;
- an authenticated Poe request and a project-aware Vertex request.

Then release as 9.8.0 and tell the backend.
