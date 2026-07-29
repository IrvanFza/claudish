# Claudish - Development Notes

For planned but not-yet-implemented work — including the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, and the Anthropic plugin allowlist consideration — see `ROADMAP.md`. Each item there has an explicit trigger condition; if a condition is met, the item moves to active development.

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Build CLI and macOS bridge bundles
- `bun run dev` - Development mode

## Model Routing (v4.0+)

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

### Provider Shortcuts
- `g@`, `google@` → Google Gemini
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `sakana@`, `fugu@` → Sakana Fugu
- `sc@` → Sakana Fugu Subscription
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see "Custom Endpoints" below

### Default Provider Configuration (v7.0.0+)

`defaultProvider` is a **last-resort fallback** appended to every bare-name routing chain. It is not a "front of the line" override — specific patterns (`gpt-*`, `gemini-*`, etc.) still try their normal providers first. `defaultProvider` only catches models whose explicit chain has zero credentialed providers, or models that match no rule at all.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any built-in provider name (`"openrouter"`, `"openai"`, `"google"`, `"litellm"`, etc.) or a custom endpoint name defined in `customEndpoints`.

**How it interacts with routing rules**: For each bare-name model, `route()` matches against the rules table, builds the candidate chain, then **appends `defaultProvider` to the end** if it isn't already in the chain (deduped against shortcuts — `or` and `openrouter` are treated as the same provider). The combined chain is then credential-filtered. Explicit `provider@model` specs are not affected — `defaultProvider` only applies to bare names.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly.

### Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Firebase slim catalog** (v7.0.0+): The `aggregators[]` field on model documents provides a typed multi-provider routing index. Each entry is `{ provider, externalId, confidence }`. Claudish only consumes this hosted catalog at runtime. Catalog extraction, recommendation generation, portal hosting, and API documentation live in the [models-index](https://github.com/MadAppGang/models-index) repo.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` under the `customEndpoints` key. Each endpoint registers as a provider prefix usable with `@` syntax.

### Config schema

**Simple endpoint** (most common):
```json
{
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}",
      "modelPrefix": "my-org/",
      "models": ["llama3.1-70b", "qwen2.5-72b"]
    }
  }
}
```

**Complex endpoint** (full control):
```json
{
  "customEndpoints": {
    "corp-proxy": {
      "kind": "complex",
      "displayName": "Corporate LLM Proxy",
      "transport": "openai",
      "baseUrl": "https://llm.corp.internal",
      "apiPath": "/api/v2/chat/completions",
      "apiKey": "${CORP_LLM_KEY}",
      "authScheme": "X-Api-Key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

Use as: `claudish --model my-vllm@llama3.1-70b "task"` or `claudish --model corp-proxy@gpt-4o "task"`.

### Key details

- **`${VAR_NAME}` expansion**: The `apiKey` field expands environment variables at startup. Use this instead of hardcoding secrets in config.
- **Zod validation**: Claudish validates all custom endpoints at proxy startup. Invalid entries emit a stderr warning and are skipped — they don't crash the proxy.
- **Runtime registration**: Endpoints call `registerRuntimeProvider()` and `registerRuntimeProfile()` to inject themselves into the provider resolver and transport layers.
- **`models` field** (optional): When present, limits the endpoint to listed models. Omit to allow any model name.
- **`modelPrefix` field** (optional): Prepended to the user-specified model name before sending to the API.

## 1Password Integration (v7.6.0+)

All 1Password logic lives in `packages/cli/src/providers/onepassword.ts` (dependency-light: imported by `index.ts` before heavy deps; uses only node built-ins at module load). Secret operations are **SDK-only** — the `@1password/sdk` is **dynamically imported** (`await import` inside `defaultSdkClientFactory`) only when SDK auth is present AND a secret/field/environment is actually needed — a normal run never loads the ~10MB WASM. **Requires the beta** `@1password/sdk@0.4.1-beta.1` (exact pin): the stable 0.4.0 has no `environments` API.

### Resolution model: SDK-ONLY (no `op` CLI for secrets)
- **All three operations** — resolving `op://` refs (`secrets.resolveAll`), glob field discovery (`vaults.list` → `items.list` → `items.get`), and Environments (`environments.getVariables`) — go through the SDK. There is **no `op` CLI fallback**.
- Public async entry points: `resolveSecrets()`, `readEnvironment()`, `discoverItemFields()`/`resolveGlobImport()`. All accept `{ sdkFactory?, auth?, env? }`; `acquireSdkClient()` is the shared "resolve auth → build client → hard-fail if no auth" helper.
- **Hard-fail** on any failure including no-auth (explicit opt-in via `op://` or `--op-env`); **zero cost** (no SDK/`op` touched) when no op:// source is present.
- The **one** remaining `op` binary touch is an **optional, read-only `op account list --format=json`** (`defaultOpAccountLister`) used SOLELY for the multi-account picker — it never sees a secret and degrades to an actionable error when `op` is absent.

### Auth resolution (DesktopAuth account selection)
`detectSdkAuth(env)` is env-only: `OP_SERVICE_ACCOUNT_TOKEN` → token; else `OP_ACCOUNT` → DesktopAuth. The richer `resolveSdkAuth(opts)` (async, called once by `index.ts` and memoized via `getSdkAuth()`, so a multi-account user is prompted at most once per run) resolves in order: **token → `OP_ACCOUNT` → `onepasswordAccount` config (global `~/.claudish/config.json`, local `.claudish.json` wins) → single auto-detected account (`op account list`) → interactive picker (multiple accounts + TTY; the choice is saved to global config) → hard-fail** (multiple accounts non-interactive, or `op` absent). The account **URL** (e.g. `my-team.1password.com`) is the saved/`OP_ACCOUNT` value — it's unique even when two accounts share an email. The SDK cannot reuse an interactive `op signin` session, so an `op signin`-only setup must now set `OP_ACCOUNT` (DesktopAuth) or a service-account token.

### Locked-screen denial recovery (v7.20.0+)
1Password returns the SAME error for two different situations: the user saw the desktop approval dialog and clicked **Cancel** (a decision), and the Mac was **locked** so the dialog could not be shown at all and 1Password auto-denied (an environmental condition). Both read `Denied authorization for SDK client`, which is why `isTransientSdkError` pins any denial as TERMINAL — retrying a Cancel re-opens the dialog the user just dismissed (the "second dialog" bug, commit `aa71ce3`). That guard is **unchanged**.

The ambiguity is resolved from OUTSIDE the error, by probing screen-lock state: `defaultScreenLockProbe` runs `ioreg -n Root -d1 -a` and matches `CGSSessionScreenIsLocked` (present only while locked; ~15ms; darwin-only — other platforms return false and keep terminal behavior). `isLockedDenial(err, env)` = denial **&&** no `OP_SERVICE_ACCOUNT_TOKEN` (token auth never shows a desktop prompt, so waiting would be theatre) **&&** screen locked. `withSdkRetry` now **wraps** the transient-IPC loop (`withSdkTransientRetry`) in an OUTER lock-round loop, keeping the two time domains separate: the inner loop owns millisecond-scale IPC blips (150ms·attempt), the outer owns the human-scale "go unlock your Mac" wait. Every non-locked-denial error propagates from the inner loop unchanged.

On a locked denial the user gets a friendly explanation (printed ONCE, on round 1 — re-explaining every 10s reads as nagging) plus a 10-second countdown, up to `LOCK_RETRY_ROUNDS` (3) → 3 retries ≈ 30s. The countdown **breaks early** the moment the probe reports unlocked, so approving is immediately followed by the prompt. Cancellation degrades by CAPABILITY, not by mode (interactive and non-interactive must behave identically — an explicit product decision): TTY stdin → Esc/q/Ctrl-C; otherwise Ctrl-C via SIGINT. The live `\r\x1b[2K` redraw and ANSI styling apply ONLY when `process.stderr.isTTY` (checked at call time, not module load) — under an MCP host or channel session stderr is a captured pipe, which gets one static line per round instead. Test seams: `setScreenLockProbe()` and `setLockRetryTiming({seconds, tickMs})` — the latter is MANDATORY in tests or the suite gains 30 real seconds.

### Concurrent-spawn denial prevention (v7.22.0+)

A THIRD situation produces the same `Denied authorization for SDK client`, and unlike the two above it is neither a decision nor a lock state: **several claudish processes racing the DesktopAuth handshake at once**. 1Password arbitrates that handshake across the whole MACHINE, not per process — it authorizes ONE client and instantly denies every concurrent peer. `runSdkExclusive` serializes SDK calls WITHIN a process (the `-4` IPC fix), but `team-orchestrator.ts` and channel `create_session` spawn N sibling PROCESSES, each building its own client, and no in-process queue can span those.

Measured on a real 7-model `team` run (session `team-20260729-163623`): all seven children spawned within 6ms, five hit the denial, and only the models whose key was already in the shell env survived — `errors/01.log` shows a model that COMPLETED while still logging two denials. Reduced repro with lock state held constant (unlocked in both arms): 6 children in a tight loop → **5 denied**; the same 6 staggered 4s apart → **0 denied**; a single child → fine. So this is not the locked-screen case and the lock probe does not fire for it (`isLockedDenial` requires a locked screen, and a denial while unlocked stays TERMINAL).

The fix PREVENTS the race rather than recovering from it: `auth/credentials/prehydrate.ts`'s `prehydrateCredentialsForSpawn(models)` runs `validateApiKeysForModels` in the PARENT before any child is spawned. The authority write-throughs each resolved op:// key into `process.env` (api-key-credential.ts), children inherit `process.env`, so they find the key in step 1 of the chain and never construct an SDK client at all — exactly the state the surviving models were already in. One serialized resolve, one handshake, regardless of model count (a 1Password Environment is fetched once per process via the single-flight memo). Called at both spawn sites; NEVER throws (a credential that cannot be pre-resolved just stays missing and the child reports it as before — failing the spawn would turn "one model has no key" into "the whole team run died").

This covers every spawn site claudish owns. Two INDEPENDENT claudish processes launched at the same instant by unrelated sessions can still collide; that would need a cross-process lock and is deliberately not built yet.

### 1Password failure provenance
Every op-source failure is deliberately NON-FATAL (warn + skip, so a broken import can never lock the user out). That meant a denied authorization surfaced downstream as a plain "missing key" error telling the user to `export` a credential they already store in 1Password. `recordOpFailure()` / `getOpFailures()` / `renderOpFailureNotice(envVar)` in `onepassword.ts` are the negative counterpart to `recordOpHydratedVars` (same run-scoped, in-memory rationale), recorded at all four non-fatal catch sites in `op-source.ts`. `getMissingKeyError` splices the notice ABOVE the generic remediation and switches its header to "Or set the key directly:" — when a key lives in 1Password, approving is the fix and exporting a literal is the bypass. The record is deliberately COARSE (run-scoped, not per-env-var): an Environment fetch is all-or-nothing, so when it fails claudish genuinely cannot know which variables it would have supplied. Output is byte-identical to the old error when no failure was recorded, so non-1Password users see no change.

### Glob field import
A top-level `onepassword: string[]` config array holds glob paths. `isGlobImport()` detects a `*` in the post-item path segment(s); `resolveGlobImport()` does three phases: **discover** field names via the SDK (`vaults.list` → `items.list` → `items.get`, matching by title; duplicate titles → first-match + stderr warn) → **filter** by section-glob + field-glob (`globToRegExp`) → **resolve** only survivors via `resolveSecrets` (batched, in-memory). The SDK's `ItemField` has no ready-made `reference`, so each field's `op://` ref is **synthesized** from the vault/item/section/field titles. The SDK decrypts every field value to list names — no different from `op item get`, which also decrypts everything in-process; we keep only a `hasValue` flag, never the value. Field labels are trimmed; invalid env-var names are skipped with a warning.

### Custom-endpoint op:// apiKeys (pre-resolved at startup)
Provider construction is **synchronous** and can't await the async SDK, so a custom endpoint's `op://` `apiKey` is **pre-resolved in `index.ts` `applyCustomEndpointOpKeys()`** into `CUSTOM_<sanitize(name)>_KEY` (UPPERCASE, non-alphanumerics → `_`). `custom-endpoints-loader.ts`'s `createHandler` reads `process.env[apiKeyEnvVar]` **first**, falling back to `resolveCustomEndpointApiKey()` (which now only expands `${VAR}`/literals — it no longer touches 1Password).

### CLI surface (`onepassword-command.ts`)
- `claudish --op "op://.../*" --list` → `opPreviewCommand(glob, { auth })`: lists matching field names via SDK `items.get`, **never values**.
- `claudish --op "op://.../*" [...args]` → `applyOpImport()`: resolves glob → hydrates `process.env` → runs a normal session with the remaining args (inline mode is glob-only; single refs go in config).
- `--op-env <id>` → 1Password Environments via the SDK `environments.getVariables` (beta-only). **Point-of-need since v7.16.0**: registered as a lazy op source (like config `onepasswordEnvironments[]`) and resolved by the credential authority ONLY when a routed provider's key misses env/config — no longer resolved eagerly at startup (which prompted on `--update`/`--version`/OAuth-only sessions and stormed across spawned children), no longer a highest-priority overwrite (env/config already set wins).

### TUI surface — the "1Password" tab (`claudish config`, tab 5)
The OpenTUI config interface (`packages/cli/src/tui/`) exposes a dedicated **1Password tab** managing, at both **global** (`~/.claudish/config.json`) and **project** (`./.claudish.json`) scope: the `onepasswordAccount`, per-item `op://` refs + glob imports (`onepassword[]`), and 1Password **Environments** (`onepasswordEnvironments[]`, a NEW persisted config field mirroring `--op-env`).

- **Persistence**: `providers/onepassword-config.ts` — scope-aware, **config-only** (no SDK at module load), all SYNC with an injectable `OpConfigPaths` test seam. Both scopes use a **raw read-modify-write** (preserves unrelated keys; never routes global through profile-config's cached-`homedir()` `CONFIG_FILE`, so global is hermetically testable). `index.ts`'s `readConfiguredOnepasswordAccount`/`saveOnepasswordAccount` now delegate here. **Point-of-need (v7.16.0):** `applyOpEnvironment()` no longer resolves anything — it only **validates** the `--op-env` flag shape; both `onepasswordEnvironments[]` config and the `--op-env` flag are discovered + resolved LAZILY by `auth/credentials/op-source.ts` (`registeredEnvironmentIds` = seam-aware config env ids + argv `--op-env`; `resolveEnvironmentShared` = single-flight, whole-environment `getVariables` cached into `resolvedCache`) only when a routed provider key misses env/config. `onepasswordEnvironments` is added to `profile-config.ts`'s `loadConfig` allowlist so global round-trips preserve it, and to `op-source.ts`'s `SniffedConfig` so tests can inject it through the existing seam.
- **TUI wiring**: tab/mode/types in `tui/types.ts` (`OpEntry`/`OpScope`/`OpKind`); `tui/components/OnepasswordContent.tsx` (auth card + merged scope-marked scrollable list — ▴ project / • global / · env), `OnepasswordDetail.tsx` (browse-only entry detail), and `OnepasswordModal.tsx` (the centered **absolute-overlay** add-wizard — `position="absolute"` + `zIndex`, painted as the topmost sibling of the root box, NOT crammed in the bottom strip). `App.tsx` owns state + the keyboard handler. Scope model mirrors Routing; pickers follow the Profiles `<select>` pattern (focused `<select>` owns ↑↓ via `onChange`; `useKeyboard` owns Enter/Esc).
- **Add wizard flow** (`a` key) — **browse, don't type**: Step 1 **scope** (global/project) → Step 2 **account** picker (shown ONLY when `!detectSdkAuth()` AND `resolveDesktopAccount()` returns `needsPicker`, i.e. >1 account & not authed; auto-skipped otherwise) → Step 3 **kind** (intent-labeled `<select>` with descriptions ON: "API key from an item" / "Environment") → Step 4 **value**:
  - **API key** → per-level pickers `pick_op_vault` → `pick_op_item` → `pick_op_field` (from `listVaults`/`listItems`/`discoverItemFields` — two tiny new engine exports `listVaults`/`listItems` mirror `discoverItemFields`' `acquireSdkClient`). The `op://Vault/Item/[Section/]Field-or-*` path is **built from the literal titles** (`buildFieldOptions` in the modal) — the user never types `op://`. Globs always target ONE concrete vault+item (the grammar forbids multi-vault/item globs). Each level shows a "◌ Loading…" state while the async SDK call runs; Esc steps back one level (field→item→vault→browse). **Inline fuzzy filter**: the vault/item/field (and account) pickers are MANUALLY rendered (not `<select>`) so App owns ↑↓ + a shared `opFilter` string — typing narrows the list via `fuzzyMatch` (case-insensitive subsequence, in `OnepasswordModal.tsx`), backspace widens, a "filter: … N matches" header + "no matches" empty state show state, and the filter resets on every level entry/exit. `*` is excluded from filter input (`isFilterChar`) — it'd match literally in the subsequence filter and exclude every concrete-field row.
  - **Grouped field picker** (`buildFieldOptions` → `FieldPickerOption` with a `selectable` flag): rows are `★ Import everything (all N fields)`, then per-SECTION groups — a non-selectable **header** = the section title (often the user's key name, e.g. `GOOGLE_GEMINI_API_KEY`), then a nested `↳ import all N fields` glob, then each concrete field — then a `(no section)` group for top-level fields. This replaced the confusing flat `section 'X' — all fields (*)` rows (when a user keeps one key per section, the header now reads as the key group, not gibberish). The cursor SKIPS header rows (App's `nextSelectable`/`firstSelectable` + a `useEffect` cursor-snap; Enter guards on `chosen.selectable`). The selected option's full `op://` path renders on ONE fixed "saves: …" footer line, mid-truncated (`midTruncate`) so it never wraps/overlaps rows.
  - **Environment** → typed ID (the SDK has **no** way to enumerate Environments — only `getVariables(id)`) with a **two-Enter NAME preview**: Enter#1 → `readEnvironment` → render variable names (no values); Enter#2 → persist.
- **Importable-only, FLAT field list** (`buildFieldOptions`): only **importable** fields are shown — concealed (SDK `fieldType === "Concealed"`, case-insensitive) AND a valid env-var name; everything else (notes/username/`credential`) is hidden, and sections with zero importable fields are omitted. The list is **flat and uniform** (no headers/gaps — earlier grouped/collapsed layouts made single-key and multi-key sections look like different items): one selectable key row per field, rendered `ENVNAME  ·  section` (env-var name green, section a dim aligned tag). A MULTI-key section additionally gets one `↳ all of <section> (N, auto-updates)` glob row after its keys; the sectionless `★ All top-level keys (N, auto-updates)` glob is appended only when importable top-level keys exist. `renderFieldPicker` renders this in a bordered scroll region with `▲/▼ more` indicators; the selected option's full `op://` path shows on the fixed "saves: …" footer (`midTruncate`d, `dialogW - 16`, so it never wraps).
- **SDK call SERIALIZATION (`-4` fix)**: the 1Password SDK's WASM↔desktop-app IPC bridge is **NOT safe for concurrent calls on a shared client** — two ops in flight at once corrupt the channel → `IPC operation failed: -4`. The config TUI fires overlapping calls (e.g. a post-save confirm AND the main-list glob-expansion at the same instant), which reliably triggered it. Fix in `onepassword.ts`: a process-wide `runSdkExclusive` queue chains every SDK op so **at most one runs at a time**, plus `withSdkRetry` (cache-reset + 150ms·attempt backoff, up to 3 attempts) for genuinely transient blips, plus the per-auth client cache (`defaultSdkClientFactory`, one desktop handshake reused). `isTransientSdkError` also matches **stale-desktop-session** errors (`invalid client id` / `invalid session` / `session expired` / `unauthorized` / `token expired`) — after an idle period 1Password expires the SDK session and the cached client's id goes invalid; these are retryable (reset cache → rebuild client = fresh DesktopAuth handshake → retry), so claudish self-heals after idle instead of surfacing `invalid client id`. (The desktop app's re-authorization prompt after idle is 1Password's own session-timeout behavior — claudish can't suppress it, but now auto-retries once approved.) ALL TUI SDK calls (`loadOpVaults/Items/Fields`, `runOpAdd` confirm, `testOpEntry`, `previewOpEnvironment`, the `opExpansions` effect) go through `withSdkRetry` → serialized. Serialization is the PRIMARY fix; the client cache + retry are secondary. Tests: `withSdkRetry` serialization (max-concurrency=1), retry-then-succeed, give-up-after-3, no-retry-on-genuine-error.
- **Field-load speed**: the field picker uses `discoverItemFieldsById(vaultId, itemId, vaultTitle, itemTitle)` — ONE `items.get` SDK call instead of `discoverItemFields`' three (`vaults.list` → `items.list` → `items.get`), ~3× faster on the 1Password desktop-app IPC path. Results are **cached per `${vaultId}:${itemId}`** in `opFieldsCache` (a `useRef` Map), so re-entering an item is instant (no spinner). The latency is desktop-app IPC + WASM load + decrypt (not a network call), so caching + the single-call path are the real wins. `discoverItemFields` (title-based, 3 calls) is retained for `runOpAdd`'s confirm + the main-list glob expansion, which don't have the IDs handy.
- **User-facing terms (no jargon)**: the main list + detail use **key** (single ref), **set** (a glob = many keys), **environment** — never "ref"/"glob". The KIND column color-codes them (key=blue, set=yellow, env=cyan); the auth card summarizes "N keys / M sets / K environments".
- **Sets auto-expand in the main list**: each glob entry resolves its key names + a MASKED value tail lazily via a cached `opExpansions` effect (`discoverItemFields`+`filterGlobFields`, keyed by glob value) and renders them as dim `↳ NAME   ••••XXXX` sub-rows (with `◌ resolving…` / `✗ error` states). The tail is `DiscoveredField.valueTail` — the LAST 4 chars of the value, captured at discovery (where the SDK has already decrypted in-process) via the exported `valueTail()` helper; the full value is never stored/returned/logged. This is the standard "••••1234" identification pattern so the user can confirm WHICH credential is wired up. (The op keys themselves ARE applied to providers — they hydrate `process.env` at startup via `loadStoredApiKeys`, and the Providers tab reads `process.env[apiKeyEnvVar]`; an earlier "providers show not set" report was the `-4` concurrency bug, now fixed by SDK serialization.) Both the main list and the field picker render selected rows as a height-1 highlight box and **non-selected rows as bare `<text>`** (transparent → no dark/blue strips; the earlier `flexGrow` row box painted the whole panel). The field picker's list sits in a **bordered scroll region** with `▲ N above` / `▼ N below` indicators.
- **Glob grammar (claudish-side only — 1Password rejects `*`/`**` outright, so it never sees them)**: `op://V/Item/*` = sectionless/top-level fields only; `op://V/Item/Section/*` (or `*/*`, `M*/*`, `*_KEY/*`) = fields in matching section(s) only; **`op://V/Item/**` = the WHOLE item — every importable field, sectioned AND sectionless** (the `matchAll` flag on `GlobImport`, added because no `*`/`*/*` form unions both axes). `parseGlobImport` maps a lone single-segment `**` → `{sectionGlob:null, fieldGlob:"*", matchAll:true}`; `filterGlobFields` short-circuits the section check when `matchAll`. `**` is purely additive — `*`'s sectionless-only meaning (and its pinned test) is unchanged.
- **`★` rows in the field picker** (`buildFieldOptions`): **`★ All keys in this item (N)` → `op://V/Item/**`** is shown first whenever the item has ≥1 importable key — ONE config entry covers every item shape (no-sections / all-sectioned / mixed). A second **`★ All top-level keys → op://V/Item/*`** appears ONLY for a MIXED item (has sections AND top-level keys), as a narrower pick; it's suppressed for a no-sections item (where `**` already equals `*`). Both counts reflect importable fields only. This replaced an earlier `★ All top-level keys`-only design that couldn't express "the whole item" when keys live in sections.
- **Startup glob failures are NON-FATAL** (`index.ts` `loadStoredApiKeys`): a saved glob that matches nothing (e.g. after a 1Password item edit) now warns + skips per-glob instead of `process.exit(1)` — a bad import must never lock the user out of claudish (especially `claudish config`, where they'd go to fix it). Genuine auth/token failures still hard-fail via the single-ref `resolveSecrets` path.
- **Hydrate-on-add (keys apply WITHOUT a restart)**: after a successful add, `runOpAdd` resolves the new ref/set/environment and **gap-fills the values into the running process's `process.env`** (env already set wins, same rule as startup), then drops all probe handler caches (`invalidateProbeProxyHandlers()`) and `refreshConfig()`. The Providers tab reads `process.env[apiKeyEnvVar]`, so the imported keys light up **immediately** in the same session — previously they only appeared after relaunching claudish (the import only hydrated env at startup). Sets use `resolveGlobImport` (returns the `{envVar:value}` map directly — one resolution both confirms and hydrates); refs use `resolveSecrets` + `envNameFromOpRef`; environments use `readEnvironment`. The status line reports "N keys applied".
- **`runOpAdd` is PERSIST-FIRST**: it writes the ref/glob/env to config **immediately** (the picked option is valid by construction — it came from an SDK-discovered list), then runs a **non-fatal** confirmation test (`resolveSecrets`/`discoverItemFields`+`filterGlobFields`/`readEnvironment`) that only annotates the status line (masked value / key count / var count) — a flaky second SDK round-trip can no longer silently lose the save. A genuine persist failure (or the confirm error) is logged to stderr and shown in the status line. (Earlier bug: re-validating before persist meant a thrown confirm left `onepassword[]` empty — "Imports: 0" despite a successful pick.) Auth still resolves via `resolveSdkAuth` (in-TUI multi-account picker via `pick_op_account` + deferred-promise `onNeedsPicker`); the heavy SDK/WASM stays lazy.

### Tests
`onepassword.test.ts` — hermetic via injectable `SdkClientFactory` (fake client answering `vaults`/`items`/`secrets`/`environments`) and `OpAccountLister` (fake account list) seams; neither the `op` binary nor the real SDK is ever invoked. The SDK-shaped item fixture is **derived** from the real-captured CLI item fixture (no hand-crafted secret-like data). Covers no-auth hard-fail and `resolveDesktopAccount`/`resolveSdkAuth` (env / config / single-auto / multi-picker / multi-error).
`onepassword-config.test.ts` — hermetic via the `OpConfigPaths` seam pointing global/project at temp files (`homedir()` can't be re-pointed at runtime in Bun); covers scope-independent account/imports/environments read-write, project-then-global precedence, idempotent add, empty-list key deletion, `readAllOnepasswordEnvironments` dedup, raw-merge preservation of unrelated fields, and garbled-file tolerance.

## Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

### Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

### Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

### Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

### Composition in ComposedHandler
```
ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected) + ProviderTransport
```

**Stream parser selection** (3-tier priority):
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

**Adding a new provider**: Add one entry to `PROVIDER_PROFILES` table in `providers/provider-profiles.ts`.
**Adding a new model**: Create a ModelTranslator adapter, register in `adapters/adapter-manager.ts`.
**Verifying wiring**: `claudish --probe <model>` shows the full adapter composition.

### Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

### Errors that ride an HTTP 200 stream (`stream-head-sniffer.ts`)

The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity faults **inside** a 200 body, not via the status code:

```
200 OK
data: {"type":"response.created", ...}
data: {"type":"response.in_progress", ...}
data: {"type":"error","error":{"code":"server_is_overloaded", ...},"sequence_number":2}
```

Every retry hook in claudish keys off the HTTP **status** (`anthropic-compat.ts`'s 429 loop, `gemini-codeassist.ts`'s 429 classifier), so this class of failure bypassed all of them. The parser turned it into an assistant **text block** with `stop_reason: "end_turn"` and `onApiError` only flagged stats — so a transient, textbook-retryable fault became a permanent, successful-looking answer reading `[API Error: server_is_overloaded]`.

`sniffResponsesStreamHead()` peeks at the stream head in `composed-handler.ts` step **7b**, which is the only window where the status code is still ours to choose (once Hono flushes the 200, a 503 is no longer expressible):

- **Retryable** (`server_is_overloaded`, `server_error`, `service_unavailable_error`, prose "overloaded"/"try again later") → re-issue upstream with **progressive** backoff `3s → 15s → 30s` (`STREAM_RETRY_DELAYS_MS`). Progressive, not tight: the outage that motivated this ran ~6.5 minutes, so only the late attempts recover anything.
- **All retries exhausted** → HTTP **503** `overloaded_error`. Safe specifically because `fallback-handler.ts`'s `isRetryableError` does NOT list 503 — it cannot silently switch the user off a pinned model, it reaches Claude Code, which runs its own retry loop.
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is the one place the 400-not-503 doctrine (`composed-handler.ts` ~line 461) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```

## Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

### Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

### Components (`packages/cli/src/channel/`)

- **SessionManager** — spawns `claudish --model X --stdin --quiet` child processes, tracks lifecycle, enforces timeouts
- **SignalWatcher** — per-session state machine (starting→running→tool_executing→waiting_for_input→completed/failed/cancelled)
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines) for session output

### MCP Tools (11 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (2): `team`, `report_error`
- **Channel** (5): `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

### Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

### Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback on state transitions. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|completed|failed|cancelled",
      "model": "<model-id>",
      "elapsed_seconds": "<numeric string>",
      "task_id": "<same as session_id>",
      "status": "working|input_required|completed|failed|cancelled",
      "created_at": "<ISO 8601 from session start>",
      "last_updated_at": "<ISO 8601 at notification time>"
    }
  },
  "jsonrpc": "2.0"
}
```

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys via `SignalWatcher`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 7-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` for the full plan.

### Enabling channel rendering in Claude Code

The Claudish MCP server emits the documented wire format, but Claude Code gates channel **registration** behind several conditions that have nothing to do with the wire contract. All of these must be satisfied for `<channel>` blocks to surface in the agent's context:

| Requirement | Why |
|---|---|
| Claude Code v2.1.80 or later | Channels feature minimum version |
| Anthropic auth via claude.ai OR Console API key | Channels are NOT supported on Bedrock, Vertex, or Foundry |
| Interactive session (no `-p` / `--print`) | Channel registration is bound to the interactive event loop. Empirically verified: in `-p` mode the registration codepath never runs and frames are silently dropped |
| Server defined in project `.mcp.json` or `~/.claude.json` | `--mcp-config` is NOT consulted by the channel resolver. Tools loaded via `--mcp-config` work; channels declared by the same server do not register |
| Server explicitly named in `--channels` OR `--dangerously-load-development-channels` | Being in MCP config alone is not enough. Per Anthropic docs: *"a server also has to be named in `--channels`"* |
| Org policy `channelsEnabled: true` (Team/Enterprise only) | Pro/Max users without an org skip this check |

**Launch command — bare server**:

```bash
# in a directory with .mcp.json containing a "claudish" entry
claude --dangerously-load-development-channels server:claudish
```

**Launch command — via the Magus `code-analysis` plugin** (Claudish is bundled there as an MCP server):

```bash
claude --dangerously-load-development-channels plugin:code-analysis@magus
```

The `--dangerously-load-development-channels` flag triggers a one-time confirmation prompt per session. To remove that prompt, the plugin would need to be added to Anthropic's curated channel allowlist (security review required) or to your org's `allowedChannelPlugins` managed setting.

### Diagnostic tracing — `CLAUDISH_CHANNEL_TRACE=1`

When the channel pipeline appears broken (e.g., client never renders `<channel>` blocks), set `CLAUDISH_CHANNEL_TRACE=1` before starting the MCP server. The diagnostics module (`packages/cli/src/channel/diagnostics.ts`) then emits `[channel-trace] …` lines to stderr at three checkpoints:

1. `fired sid=… type=… model=… elapsed=…s` — onStateChange callback entered (producer side fires)
2. `callback returned sid=… type=…` — bridge invoked `server.notification()` without throwing
3. `WIRE-OUT {…json…}` — the JSON-RPC frame literally hit stdout

If you see (1) but not (2): the bridge is throwing or rejecting silently.
If you see (1)+(2) but not (3): the SDK's transport is dropping the frame.
If you see all three but the client doesn't render the notification: the issue is client-side — most often one of the gating conditions in "Enabling channel rendering in Claude Code" above is unmet.

Off by default. Zero overhead in production.

When the MCP server is spawned by a host that captures stderr (e.g. Claude Code), set `CLAUDISH_CHANNEL_TRACE_FILE=/path/to/log` alongside `CLAUDISH_CHANNEL_TRACE=1` to mirror trace lines to a file you can `tail` from outside the host process. The file is opened with `appendFileSync` so multiple sessions append safely.

Two diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.

### Testing

```bash
bun test --cwd . ./packages/cli/src/channel/*.test.ts
```

65 tests across 5 files: scrollback-buffer (11), signal-watcher (12), session-manager (21), e2e-channel (15), channel-wire-format (6). The wire-format tests run without an API key by using the fake-claudish PATH shim, so they execute on every CI run.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests use a fake-claudish PATH shim (`channel/test-helpers/fake-claudish.ts`).

## Test Infrastructure

### Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Version Bumping Checklist

When releasing a new version, update ALL of these locations:
1. `package.json` (root monorepo version)
2. `packages/cli/package.json` (npm-published package - **CI/CD publishes from here**)
3. `packages/cli/src/version.ts` (fallback VERSION constant — moved from cli.ts in v7.0.0)

The fallback VERSION in version.ts ensures compiled binaries (Homebrew, standalone) display the correct version when package.json isn't available. The `packages/cli/package.json` version is what npm publishes - if it's not updated, npm publish will fail.

## Session Artifacts

Write research/planning artifacts to `ai-docs/sessions/{task-slug}-{YYYYMMDD-HHMMSS}-{hash}/` — not `/tmp` (cleared on reboot). Referenced docs live there, e.g. `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
<!-- revised: 2026-07-26 — root cause was a missing Ollama embedding model, not mnemex itself -->
- Prefer mnemex AST lookups over grep for symbol/caller questions: `mnemex --agent symbol|callers|callees "Name"`
- Semantic search is `mnemex --agent search "concept"` — NOT `map`, which ignores its argument entirely and always dumps the same PageRank overview
- `search` needs Ollama serving `nomic-embed-text` — without it embeddings are zero-length, so search is useless and `status` panics with a lance divide-by-zero. Fix: `ollama pull nomic-embed-text` → `rm -rf .mnemex/vectors` → `mnemex index`

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
