# API Reference

Claudish exposes a Firebase Cloud Functions HTTP API for model catalog data and telemetry, plus an MCP server with 11 tools for AI model interaction from Claude Code.

**Base URL:** `https://us-central1-claudish-6da10.cloudfunctions.net`

---

## Model Catalog

### Query models

`GET /queryModels`

Four query modes on a single endpoint, selected by query parameters.

#### Standard query

Filter the full model catalog by provider, pricing, context window, or name.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `provider` | string | — | Filter by provider slug (e.g., `openai`, `anthropic`, `google`) |
| `status` | string | `active` | Filter by lifecycle status. Pass `all` to include deprecated/preview |
| `maxPriceInput` | number | — | Max input price in USD per million tokens |
| `minContext` | number | — | Minimum context window in tokens |
| `search` | string | — | Case-insensitive substring match on modelId, displayName, or aliases |
| `limit` | number | `50` | Max results (capped at 200) |

```bash
curl "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?provider=openai&maxPriceInput=5.0&minContext=100000&search=gpt&limit=10"
```

```json
{
  "models": [
    {
      "modelId": "gpt-5.4",
      "displayName": "GPT-5.4",
      "provider": "openai",
      "pricing": { "input": 2.5, "output": 10.0 },
      "contextWindow": 131072,
      "maxOutputTokens": 16384,
      "capabilities": { "vision": true, "thinking": true, "tools": true, "streaming": true },
      "aliases": ["gpt5.4", "gpt-5-4"],
      "status": "active",
      "fieldSources": { "pricing": { "collectorId": "openai-api", "confidence": "api_official" } },
      "sources": { "openai": { "confidence": "api_official", "externalId": "gpt-5.4" } },
      "lastUpdated": "2026-04-06T03:00:00Z"
    }
  ],
  "total": 1
}
```

#### Slim catalog

`?catalog=slim` -- minimal projection for CLI model resolution. Used by the OpenRouter catalog resolver.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `catalog` | `"slim"` | — | Required to select this mode |
| `limit` | number | `1000` | Max results (capped at 2000) |

```bash
curl "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?catalog=slim"
```

```json
{
  "models": [
    { "modelId": "gpt-5.4", "aliases": ["gpt5.4"], "sources": { "openai": { "confidence": "api_official", "externalId": "gpt-5.4" } } }
  ],
  "total": 1
}
```

#### Recommended models

`?catalog=recommended` -- fully deterministic, algorithmically scored top picks, auto-generated daily by the recommender pipeline (v2.0+, no LLM step).

The recommender selects one flagship and one fast model per provider (OpenAI, Google, xAI, Qwen, Z.ai, Moonshot, MiniMax), plus subscription/gateway access variants. Selection uses a version-aware scoring formula (newest version wins, then capabilities, pricing, context, confidence). A pre-publish diff gate blocks anomalous outputs (provider disappearing, >20% total drop) and writes to `config/recommended-models-pending` with a Slack alert instead.

Three entry categories:
- **flagship** -- `category: "programming"` or `"vision"` or `"reasoning"`, the best general-purpose model per provider
- **subscription** -- `category: "subscription"`, same flagship model accessible via a dedicated endpoint (coding plan, gateway)
- **fast** -- `category: "fast"`, cheaper/faster variant of the flagship (mini, flash, turbo, lite)

```bash
curl "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?catalog=recommended"
```

```json
{
  "version": "2.0.0",
  "lastUpdated": "2026-04-14",
  "generatedAt": "2026-04-14T03:00:42.942Z",
  "source": "firebase-auto",
  "models": [
    {
      "id": "gpt-5.4",
      "openrouterId": "openai/gpt-5.4",
      "name": "gpt-5.4",
      "description": "GPT-5.4 is OpenAI's latest frontier model...",
      "provider": "Openai",
      "category": "programming",
      "priority": 1,
      "pricing": { "input": "$2.50/1M", "output": "$15.00/1M", "average": "$8.75/1M" },
      "context": "1.1M",
      "maxOutputTokens": 128000,
      "modality": "text->text",
      "supportsTools": true,
      "supportsReasoning": false,
      "supportsVision": false,
      "isModerated": false,
      "recommended": true
    },
    {
      "id": "gpt-5.4",
      "openrouterId": "openai/gpt-5.4",
      "name": "gpt-5.4",
      "description": "...",
      "provider": "Openai",
      "category": "subscription",
      "priority": 8,
      "pricing": { "input": "$2.50/1M", "output": "$15.00/1M", "average": "$8.75/1M" },
      "context": "1.1M",
      "maxOutputTokens": 128000,
      "modality": "text->text",
      "supportsTools": true,
      "supportsReasoning": false,
      "supportsVision": false,
      "isModerated": false,
      "recommended": true,
      "subscription": {
        "prefix": "cx",
        "plan": "OpenAI Codex",
        "command": "cx@gpt-5.4"
      }
    }
  ]
}
```

#### Changelog

`?changes=true` -- field-level change history for a specific model.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changes` | `"true"` | — | Required to select this mode |
| `modelId` | string | — | Required. Canonical model ID |
| `limit` | number | `50` | Max entries (capped at 200) |

```bash
curl "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?changes=true&modelId=gpt-5.4&limit=10"
```

```json
{
  "modelId": "gpt-5.4",
  "changelog": [
    {
      "detectedAt": "2026-04-05T03:00:00Z",
      "collectorId": "openai-api",
      "confidence": "api_official",
      "changeType": "updated",
      "changes": [
        { "field": "pricing.input", "oldValue": 3.0, "newValue": 2.5 }
      ]
    }
  ],
  "total": 1
}
```

---

### Query plugin defaults

`GET /queryPluginDefaults`

Returns the plugin configuration: model aliases, role assignments, and team compositions. Cached for 5 minutes (`Cache-Control: public, max-age=300`).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `resolve` | `"true"` | — | Resolve short aliases to full model IDs in roles and teams |

```bash
curl "https://us-central1-claudish-6da10.cloudfunctions.net/queryPluginDefaults?resolve=true"
```

```json
{
  "version": "1.2.0",
  "generatedAt": "2026-04-06T12:00:00Z",
  "shortAliases": {
    "grok": "x-ai/grok-code-fast-1",
    "gemini": "google/gemini-3-pro-preview",
    "gpt": "openai/gpt-5.4"
  },
  "roles": {
    "reviewer": { "modelId": "openai/gpt-5.4", "fallback": "x-ai/grok-code-fast-1" },
    "architect": { "modelId": "google/gemini-3-pro-preview" }
  },
  "teams": {
    "review": ["openai/gpt-5.4", "x-ai/grok-code-fast-1", "google/gemini-3-pro-preview"],
    "fast": ["x-ai/grok-code-fast-1", "minimax/minimax-m2"]
  },
  "knownModels": {
    "gpt-5.4": {
      "displayName": "GPT-5.4",
      "provider": "openai",
      "contextWindow": 131072,
      "status": "active",
      "capabilities": { "vision": true, "thinking": true, "tools": true, "streaming": true }
    }
  }
}
```

Without `?resolve=true`, roles and teams contain the short alias names instead of resolved model IDs.

---

### Trigger model collection

`POST /collectModelCatalogManual`

Manually triggers the data collection pipeline. No request body needed. Runs all 20 collectors (13 API + 7 HTML scrapers), merges results, and regenerates recommendations.

```bash
curl -X POST "https://us-central1-claudish-6da10.cloudfunctions.net/collectModelCatalogManual"
```

```json
{
  "ok": true,
  "modelsCollected": 847,
  "modelsMerged": 312,
  "recommendedModels": 23,
  "collectorsOk": 18,
  "collectorsFailed": 2,
  "errors": [
    { "collectorId": "browserbase-qwen", "error": "Session timeout after 30s" }
  ]
}
```

Also runs on a daily schedule at 03:00 UTC.

---

## Telemetry

### Ingest error telemetry

`POST /telemetryIngest`

Accepts structured error telemetry from CLI clients. Max payload: 8KB. Documents expire after 90 days.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `1` | Must be `1` |
| `claudish_version` | string | CLI version (e.g., `"6.9.1"`) |
| `error_class` | string | One of: `http_error`, `auth`, `rate_limit`, `connection`, `stream`, `config`, `overload`, `unknown` |
| `error_code` | string | Error code (e.g., `"429"`, `"ECONNREFUSED"`) |
| `provider_name` | string | Provider that failed (e.g., `"openrouter"`) |
| `model_id` | string | Model ID that was requested |
| `stream_format` | string | Stream parser used (e.g., `"openai-sse"`) |
| `timestamp` | string | ISO timestamp |
| `platform` | string | OS platform (e.g., `"darwin"`) |
| `node_runtime` | string | Runtime version (e.g., `"bun 1.2.3"`) |
| `install_method` | string | How claudish was installed (e.g., `"npm"`, `"homebrew"`) |
| `session_id` | string | Anonymous session identifier |
| `error_message_template` | string | Error message with values stripped (max 500 chars) |

**Optional fields:** `http_status` (number), `is_streaming` (boolean), `retry_attempted` (boolean), `model_mapping_role`, `concurrency`, `adapter_name`, `auth_type`, `context_window`, `provider_error_type`

```bash
curl -X POST "https://us-central1-claudish-6da10.cloudfunctions.net/telemetryIngest" \
  -H "Content-Type: application/json" \
  -d '{
    "schema_version": 1,
    "claudish_version": "6.9.1",
    "error_class": "http_error",
    "error_code": "429",
    "provider_name": "openrouter",
    "model_id": "openai/gpt-5.4",
    "stream_format": "openai-sse",
    "timestamp": "2026-04-06T12:00:00Z",
    "platform": "darwin",
    "node_runtime": "bun 1.2.3",
    "install_method": "npm",
    "session_id": "abc123def456",
    "error_message_template": "Rate limited: retry after {seconds}s",
    "http_status": 429,
    "is_streaming": true,
    "retry_attempted": true
  }'
```

```json
{ "ok": true }
```

### Ingest error reports

`POST /errorReportIngest`

Accepts error reports from the `report_error` MCP tool. Max payload: 64KB. Documents expire after 90 days. All data is sanitized client-side (API keys, user paths, emails stripped).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error_type` | string | Yes | One of: `provider_failure`, `team_failure`, `stream_error`, `adapter_error`, `other` |
| `version` | string | No | CLI version |
| `model` | string | No | Model that failed |
| `command` | string | No | Command that was run (max 500 chars stored) |
| `stderr` | string | No | Error output (max 5000 chars stored) |
| `exit_code` | number | No | Process exit code |
| `platform` | string | No | OS platform |
| `arch` | string | No | CPU architecture |
| `runtime` | string | No | Runtime version |
| `context` | string | No | Additional context (max 5000 chars stored) |
| `session` | object | No | Key-value session data (values truncated to 2000 chars) |

```bash
curl -X POST "https://us-central1-claudish-6da10.cloudfunctions.net/errorReportIngest" \
  -H "Content-Type: application/json" \
  -d '{
    "error_type": "provider_failure",
    "version": "6.9.1",
    "model": "x-ai/grok-code-fast-1",
    "stderr": "Error: Proxy error: 502 - Bad Gateway",
    "exit_code": 1,
    "platform": "darwin",
    "arch": "arm64",
    "runtime": "bun 1.2.3"
  }'
```

```json
{ "ok": true }
```

---

## MCP Server Tools

The MCP server exposes 11 tools in 3 groups. Start it with `claudish --mcp` (stdio transport).

Control which groups are enabled via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

### Low-level tools

#### run_prompt

Run a prompt through any model. Supports all providers with auto-routing and fallback chains.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model name or ID. Short names auto-route (e.g., `kimi-k2.5`). Provider prefix optional (e.g., `google@gemini-3.1-pro-preview`) |
| `prompt` | string | Yes | Prompt to send |
| `system_prompt` | string | No | System prompt |
| `max_tokens` | number | No | Max response tokens (default: 4096) |

Returns the model's text response with token usage appended.

#### list_models

List recommended models for coding tasks. No parameters. Returns a markdown table with pricing, context window, and capability flags (tools, reasoning, vision), plus auto-generated quick picks (budget, large context, most advanced, vision, agentic).

#### search_models

Search all OpenRouter models by name, provider, or capability.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `"grok"`, `"vision"`, `"free"`) |
| `limit` | number | No | Max results (default: 10) |

Returns a markdown table of matching models with provider, pricing, and context window.

#### compare_models

Run the same prompt through multiple models and compare responses side-by-side.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `models` | string[] | Yes | List of model IDs to compare |
| `prompt` | string | Yes | Prompt to send to all models |
| `system_prompt` | string | No | System prompt |
| `max_tokens` | number | No | Max response tokens |

Returns each model's response in sequence with per-model token usage.

### Agentic tools

#### team

Multi-model orchestration with anonymized outputs and blind judging.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | `run`, `judge`, `run-and-judge`, or `status` |
| `path` | string | Yes | Session directory path (must be within cwd) |
| `models` | string[] | For `run`/`run-and-judge` | External model IDs. Do not pass Claude model names (`opus`, `sonnet`, etc.) |
| `judges` | string[] | No | Model IDs for judging (default: same as runners) |
| `input` | string | No | Task prompt (or place `input.md` in session dir) |
| `timeout` | number | No | Per-model timeout in seconds (default: 300) |

**Modes:**
- `run` -- execute models in parallel, write anonymized outputs
- `judge` -- blind-vote on existing outputs
- `run-and-judge` -- full pipeline (run then judge)
- `status` -- check progress of a session

#### report_error

Report a claudish error to developers. All data is auto-sanitized (API keys, paths, emails stripped).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error_type` | string | Yes | `provider_failure`, `team_failure`, `stream_error`, `adapter_error`, or `other` |
| `model` | string | No | Model ID that failed |
| `command` | string | No | Command that was run |
| `stderr_snippet` | string | No | First 500 chars of stderr |
| `exit_code` | number | No | Process exit code |
| `error_log_path` | string | No | Path to full error log |
| `session_path` | string | No | Path to team session directory (collects status.json, manifest.json, error logs) |
| `additional_context` | string | No | Extra context |
| `auto_send` | boolean | No | Suggest enabling automatic reporting |

Sends the sanitized report to the `errorReportIngest` endpoint.

### Channel tools

Async model sessions with push notifications. When active, the MCP server pushes `notifications/claude/channel` events as sessions progress through states: `starting` -> `running` -> `tool_executing` -> `waiting_for_input` -> `completed`/`failed`/`cancelled`.

#### create_session

Start an async model session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model identifier (e.g., `google@gemini-2.0-flash`) |
| `prompt` | string | No | Initial prompt. If omitted, send later via `send_input` |
| `timeout_seconds` | number | No | Session timeout (default: 600, max: 3600) |
| `claude_flags` | string | No | Extra flags for claudish (space-separated) |
| `work_dir` | string | No | Working directory (default: cwd) |

Returns `{ session_id, status: "starting" }`.

#### send_input

Send input to a session waiting for input (`waiting_for_input` state).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session ID from `create_session` |
| `text` | string | Yes | Text to send |

#### get_output

Get output from a session's scrollback buffer (2000-line ring buffer).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session ID from `create_session` |
| `tail_lines` | number | No | Return only last N lines (default: all) |

#### cancel_session

Cancel a running session. Sends SIGTERM, then SIGKILL after 5 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session ID to cancel |

#### list_sessions

List all active channel sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_completed` | boolean | No | Include completed/failed/cancelled sessions (default: false) |

---

## Schemas

### ModelDoc

Full model document stored in Firestore `models/{id}` collection.

| Field | Type | Description |
|-------|------|-------------|
| `modelId` | string | Canonical ID (e.g., `"claude-opus-4-6"`) |
| `displayName` | string | Human-readable name |
| `provider` | string | Primary provider slug (e.g., `"anthropic"`) |
| `family` | string? | Model family (e.g., `"claude-3"`) |
| `description` | string? | Description from provider API |
| `releaseDate` | string? | ISO date (e.g., `"2026-02-17"`) |
| `pricing` | PricingData? | `{ input, output, cachedRead?, cachedWrite?, imageInput?, audioInput?, batchDiscountPct? }` -- USD per million tokens |
| `contextWindow` | number? | Max input tokens |
| `maxOutputTokens` | number? | Max output tokens |
| `capabilities` | CapabilityFlags | `{ vision, thinking, tools, streaming, batchApi, jsonMode, structuredOutput, citations, codeExecution, pdfInput, fineTuning, audioInput?, videoInput?, imageOutput?, promptCaching?, effortLevels? }` |
| `aliases` | string[] | Alternative model IDs that route to this model |
| `status` | string | `"active"`, `"deprecated"`, `"preview"`, or `"unknown"` |
| `fieldSources` | object | Per-field provenance tracking (which collector, confidence tier, timestamp) |
| `sources` | Record<string, SourceRecord> | Per-provider attribution: `{ confidence, externalId, lastSeen, sourceUrl? }` |
| `lastUpdated` | Timestamp | Last data update |
| `lastChecked` | Timestamp | Last collection check |

### RecommendedModelEntry

Auto-generated recommended model entry. One per flagship, fast variant, and subscription/gateway access method.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Canonical short ID (e.g., `"minimax-m2.7"`). Never contains `/` (vendor prefix stripped at ingress) |
| `openrouterId` | string | Vendor-prefixed ID for OpenRouter routing (e.g., `"minimax/minimax-m2.7"`) |
| `name` | string | Display name |
| `description` | string | Model description from provider API |
| `provider` | string | Capitalized provider name (e.g., `"Openai"`, `"Google"`, `"Qwen"`) |
| `category` | string | `"programming"`, `"vision"`, `"reasoning"`, `"fast"`, or `"subscription"` |
| `priority` | number | 1-indexed rank (flagships first, then subscriptions, then fast) |
| `pricing` | object | `{ input: "$0.50/1M", output: "$3.00/1M", average: "$1.75/1M" }` -- formatted strings |
| `context` | string | Human-readable context window (e.g., `"1.1M"`, `"196K"`) |
| `maxOutputTokens` | number \| null | Max output tokens |
| `modality` | string | IO modality (e.g., `"text->text"`, `"text+image->text"`) |
| `supportsTools` | boolean | Function calling support (always `true` for recommended models) |
| `supportsReasoning` | boolean | Extended thinking support |
| `supportsVision` | boolean | Image input support |
| `isModerated` | boolean | Content moderation applied |
| `recommended` | `true` | Always `true` |
| `subscription` | object? | Present only for `category: "subscription"`. `{ prefix, plan, command }` (e.g., `{ prefix: "cx", plan: "OpenAI Codex", command: "cx@gpt-5.4" }`) |

### PluginDefaultsDoc

Plugin configuration stored in Firestore `config/plugin-defaults`.

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Config version |
| `shortAliases` | Record<string, string> | Alias name to full model ID (e.g., `{ "grok": "x-ai/grok-code-fast-1" }`) |
| `roles` | Record<string, RoleConfig> | Role name to `{ modelId, fallback? }` |
| `teams` | Record<string, string[]> | Team name to array of model IDs (may include `"internal"` sentinel) |

### Confidence tiers

Data provenance tiers, highest trust wins during merge.

| Tier | Rank | Description |
|------|------|-------------|
| `scrape_unverified` | 1 | Scraped but not cross-validated |
| `scrape_verified` | 2 | Scraped and confirmed by API or cross-source |
| `aggregator_reported` | 3 | OpenRouter, Fireworks (not billing-authoritative) |
| `gateway_official` | 4 | Gateway billing-authoritative (e.g., OpenCode Zen) |
| `api_official` | 5 | Direct provider `/v1/models` API |

---

## Data collection pipeline

The model catalog is built by 20 collectors running in parallel:

- **13 API collectors** -- direct provider model list APIs (OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Together, Fireworks, MiniMax, Kimi/Moonshot, Zhipu/GLM, Qwen/DashScope, OpenRouter)
- **7 HTML scrapers** -- pricing pages and docs (zero Firecrawl dependency). Uses Browserbase for JS-rendered pages (Alibaba/Qwen pricing)

**Pipeline stages:**
1. **Collect** -- all 20 collectors run in parallel (9-minute timeout). Every raw model is validated through a Zod schema gate at `BaseCollector.makeResult()` — bad data (unknown providers, invalid IDs, out-of-bounds pricing) is dropped with the collectorId in the warning log
2. **Merge** -- deduplicate by canonical ID (single `canonicalizeModelId()` — lowercase, strip vendor prefixes, strip `:free`), resolve field conflicts by confidence tier
3. **Write** -- upsert to Firestore with `modelId` as doc key (asserts no `/` in ID), detect and log field-level changes to changelog subcollections
4. **Cleanup** -- mark documents not seen in current merge and older than 48 hours as deprecated
5. **Recommend** -- fully deterministic scoring pipeline (no LLM step). Per provider: filter by `isCodingCandidate()` predicate (tools required, no audio/video/image-output), apply version-aware `pickBest()` (newest version number wins, then shortest ID, then scoring formula), split into flagship + fast
6. **Diff gate** -- compare new recommendations against previous day. Block publish if: any provider disappeared, any category lost >30% of its models entirely (not just recategorized), total entries dropped >20%, any ID contains `/`. Blocked outputs go to `config/recommended-models-pending` with a Slack alert
7. **Alert** -- Slack notifications for: collection results, newly discovered models, provider count drops (≥50% or to zero from ≥5)

**Schedule:** Daily at 03:00 UTC + manual trigger via `POST /collectModelCatalogManual`.

**Invariants enforced by the contract layer (S1-S7 refactor):**
- `modelId` matches `^[a-z0-9][a-z0-9._-]*$` — no uppercase, no vendor prefix, no slashes
- `provider` is a canonical slug from `KNOWN_PROVIDER_SLUGS` — aliases resolved at ingress via `PROVIDER_ALIAS_MAP`
- Recommended models pass `isCodingCandidate()` — tools=true, no audioInput/videoInput/imageOutput, no modality markers in ID (-image-, -audio-, -omni-, -tts-, -embedding-)
- Parameter-count suffixes (-32b, -70b, -405b, -8x7b, -a3b) are stripped before version parsing — prevents `qwq-32b` from outranking `qwen3-max`
- Trailing date stamps (-YYYY-MM-DD) are stripped before version parsing — prevents `qwen-max-2025-01-25` from outranking `qwen3.6-plus`
