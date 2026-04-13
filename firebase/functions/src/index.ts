import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { CollectorOrchestrator } from "./orchestrator.js";
import { mergeResults } from "./merger.js";
import { FirestoreWriter } from "./writer.js";
import { handleQueryModels } from "./query-handler.js";
import { handlePluginDefaults } from "./plugin-defaults-handler.js";
import { alertCatalogResults, alertNewModels, alertProviderDrop } from "./slack-alert.js";
import { generateRecommendedModels } from "./recommender.js";

initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// Required fields in the telemetry report
const REQUIRED_FIELDS = [
  "schema_version",
  "claudish_version",
  "error_class",
  "error_code",
  "provider_name",
  "model_id",
  "stream_format",
  "timestamp",
  "platform",
  "node_runtime",
  "install_method",
  "session_id",
  "error_message_template",
] as const;

// Valid error classes
const VALID_ERROR_CLASSES = new Set([
  "http_error", "auth", "rate_limit", "connection",
  "stream", "config", "overload", "unknown",
]);

// Max payload size (8KB — generous; client caps at 4KB)
const MAX_PAYLOAD_BYTES = 8192;

// TTL: 90 days in milliseconds
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const telemetryIngest = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    cors: true,
  },
  async (req, res) => {
    // Only accept POST
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Validate Content-Type
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.status(400).json({ error: "Content-Type must be application/json" });
      return;
    }

    // Validate payload size
    const rawBody = JSON.stringify(req.body);
    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }

    const body = req.body;

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (body[field] === undefined || body[field] === null) {
        res.status(400).json({ error: `Missing required field: ${field}` });
        return;
      }
    }

    // Validate schema_version
    if (body.schema_version !== 1) {
      res.status(400).json({ error: `Unsupported schema_version: ${body.schema_version}` });
      return;
    }

    // Validate error_class
    if (!VALID_ERROR_CLASSES.has(body.error_class)) {
      res.status(400).json({ error: `Invalid error_class: ${body.error_class}` });
      return;
    }

    // Build document (only copy known fields — defense in depth)
    const now = Timestamp.now();
    const doc = {
      // Server-set metadata
      ingested_at: now,
      expires_at: Timestamp.fromMillis(now.toMillis() + TTL_MS),
      schema_version: body.schema_version,

      // Required fields
      claudish_version: String(body.claudish_version).slice(0, 20),
      error_class: String(body.error_class).slice(0, 30),
      error_code: String(body.error_code).slice(0, 50),
      provider_name: String(body.provider_name).slice(0, 50),
      model_id: String(body.model_id).slice(0, 100),
      stream_format: String(body.stream_format).slice(0, 30),
      timestamp: String(body.timestamp).slice(0, 30),
      platform: String(body.platform).slice(0, 10),
      node_runtime: String(body.node_runtime).slice(0, 20),
      install_method: String(body.install_method).slice(0, 20),
      session_id: String(body.session_id).slice(0, 32),
      error_message_template: String(body.error_message_template).slice(0, 500),
      http_status: typeof body.http_status === "number" ? body.http_status : null,
      is_streaming: Boolean(body.is_streaming),
      retry_attempted: Boolean(body.retry_attempted),

      // Optional fields (only include if present)
      ...(body.model_mapping_role && { model_mapping_role: String(body.model_mapping_role).slice(0, 20) }),
      ...(body.concurrency !== undefined && { concurrency: Number(body.concurrency) }),
      ...(body.adapter_name && { adapter_name: String(body.adapter_name).slice(0, 50) }),
      ...(body.auth_type && { auth_type: String(body.auth_type).slice(0, 20) }),
      ...(body.context_window !== undefined && { context_window: Number(body.context_window) }),
      ...(body.provider_error_type && { provider_error_type: String(body.provider_error_type).slice(0, 50) }),
    };

    // Write to Firestore — DO NOT log request.ip
    try {
      await db.collection("error_reports").add(doc);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Firestore write failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Error reports — from report_error MCP tool
// ─────────────────────────────────────────────────────────────

// Valid error types from the MCP tool
const VALID_ERROR_TYPES = new Set([
  "provider_failure", "team_failure", "stream_error", "adapter_error", "other",
]);

// Max error report size (64KB — reports include session data)
const MAX_ERROR_REPORT_BYTES = 65536;

export const errorReportIngest = onRequest(
  {
    region: "us-central1",
    maxInstances: 5,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.status(400).json({ error: "Content-Type must be application/json" });
      return;
    }

    const rawBody = JSON.stringify(req.body);
    if (rawBody.length > MAX_ERROR_REPORT_BYTES) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }

    const body = req.body;

    // Validate required field
    if (!body.error_type || !VALID_ERROR_TYPES.has(body.error_type)) {
      res.status(400).json({ error: `Invalid or missing error_type: ${body.error_type}` });
      return;
    }

    const now = Timestamp.now();

    // Truncate session data values to prevent oversized documents
    let sessionData: Record<string, string> = {};
    if (body.session && typeof body.session === "object") {
      for (const [key, value] of Object.entries(body.session)) {
        if (typeof value === "string") {
          sessionData[String(key).slice(0, 100)] = String(value).slice(0, 2000);
        }
      }
    }

    const doc = {
      ingested_at: now,
      expires_at: Timestamp.fromMillis(now.toMillis() + TTL_MS),

      // Report fields (sanitized on client side, but we truncate defensively)
      version: String(body.version || "unknown").slice(0, 20),
      timestamp: String(body.timestamp || "").slice(0, 30),
      error_type: String(body.error_type).slice(0, 30),
      model: String(body.model || "unknown").slice(0, 100),
      command: String(body.command || "").slice(0, 500),
      stderr: String(body.stderr || "").slice(0, 5000),
      exit_code: typeof body.exit_code === "number" ? body.exit_code : null,
      platform: String(body.platform || "").slice(0, 10),
      arch: String(body.arch || "").slice(0, 10),
      runtime: String(body.runtime || "").slice(0, 30),
      context: String(body.context || "").slice(0, 5000),
      session: sessionData,
    };

    try {
      await db.collection("error_reports_mcp").add(doc);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Firestore write failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Model catalog — secrets required by collectors
// ─────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const FIRECRAWL_API_KEY = defineSecret("FIRECRAWL_API_KEY");
const GOOGLE_GEMINI_API_KEY = defineSecret("GOOGLE_GEMINI_API_KEY");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const TOGETHER_API_KEY = defineSecret("TOGETHER_API_KEY");
const MISTRAL_API_KEY = defineSecret("MISTRAL_API_KEY");
const DEEPSEEK_API_KEY = defineSecret("DEEPSEEK_API_KEY");
const FIREWORKS_API_KEY = defineSecret("FIREWORKS_API_KEY");
const OPENCODE_ZEN_API_KEY = defineSecret("OPENCODE_ZEN_API_KEY");
const SLACK_WEBHOOK_URL = defineSecret("SLACK_WEBHOOK_URL");
const XAI_API_KEY = defineSecret("XAI_API_KEY");
const MOONSHOT_API_KEY = defineSecret("MOONSHOT_API_KEY");
const MINIMAX_API_KEY = defineSecret("MINIMAX_API_KEY");
const ZHIPU_API_KEY = defineSecret("ZHIPU_API_KEY");
const DASHSCOPE_API_KEY = defineSecret("DASHSCOPE_API_KEY");
const BROWSERBASE_API_KEY = defineSecret("BROWSERBASE_API_KEY");
const BROWSERBASE_PROJECT_ID = defineSecret("BROWSERBASE_PROJECT_ID");

const CATALOG_SECRETS = [
  ANTHROPIC_API_KEY,
  FIRECRAWL_API_KEY,
  GOOGLE_GEMINI_API_KEY,
  OPENAI_API_KEY,
  TOGETHER_API_KEY,
  MISTRAL_API_KEY,
  DEEPSEEK_API_KEY,
  FIREWORKS_API_KEY,
  OPENCODE_ZEN_API_KEY,
  SLACK_WEBHOOK_URL,
  XAI_API_KEY,
  MOONSHOT_API_KEY,
  MINIMAX_API_KEY,
  ZHIPU_API_KEY,
  DASHSCOPE_API_KEY,
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
];

// ─────────────────────────────────────────────────────────────
// Scheduled collector — daily at 03:00 UTC
// ─────────────────────────────────────────────────────────────
export const collectModelCatalog = onSchedule(
  {
    schedule: "0 3 * * *",
    region: "us-central1",
    timeoutSeconds: 540,       // 9 minutes — plenty for all collectors in parallel
    memory: "512MiB",
    secrets: CATALOG_SECRETS,
  },
  async (_event) => {
    const start = Date.now();
    console.log("[catalog] starting model catalog collection");

    const orchestrator = new CollectorOrchestrator();
    const results = await orchestrator.runAll();

    const successCount = results.filter(r => !r.error).length;
    const failureCount = results.filter(r => r.error).length;
    console.log(
      `[catalog] collectors done: ${successCount} ok, ${failureCount} failed`
    );

    const merged = mergeResults(results);
    console.log(`[catalog] merged to ${merged.length} unique models`);

    const writer = new FirestoreWriter();
    const newModelIds = await writer.write(merged);

    // Clean up stale docs from previous runs (changed IDs, removed models)
    const currentIds = new Set(merged.map(m => m.modelId));
    await writer.cleanupStale(currentIds);

    // Auto-generate recommended models from scored catalog
    const recommended = await generateRecommendedModels();
    console.log(`[catalog] recommended models updated: ${recommended.length} picks`);

    const duration = Date.now() - start;
    console.log(`[catalog] write complete — ${newModelIds.length} new models — total duration: ${duration}ms`);

    // Slack alerts
    const webhook = SLACK_WEBHOOK_URL.value();
    await alertCatalogResults(webhook, results, merged.length, duration);

    // Alert for newly discovered models from major providers
    if (newModelIds.length > 0) {
      const providerMap: Record<string, string> = {};
      for (const doc of merged) {
        providerMap[doc.modelId] = doc.provider;
      }
      await alertNewModels(webhook, newModelIds, providerMap);
    }

    // ── Provider drop detection ─────────────────────────────────────
    // Compare per-provider counts vs the previous run and alert on
    // catastrophic drops. Uses config/provider-counts-history as a
    // single-doc snapshot (overwritten each run).
    try {
      const histRef = db.collection("config").doc("provider-counts-history");
      const prevSnap = await histRef.get();
      const prev = prevSnap.exists
        ? ((prevSnap.data() ?? {}) as { counts?: Record<string, number> }).counts ?? {}
        : {};

      const current: Record<string, number> = {};
      for (const doc of merged) {
        const p = (doc.provider ?? "").toLowerCase();
        if (!p) continue;
        current[p] = (current[p] ?? 0) + 1;
      }

      const drops: Array<{ provider: string; before: number; after: number }> = [];
      for (const [provider, before] of Object.entries(prev)) {
        const after = current[provider] ?? 0;
        // Fire alert when a provider with >=5 models yesterday has 0 today,
        // OR when any provider drops by 50% or more.
        if (before >= 5 && after === 0) {
          drops.push({ provider, before, after });
        } else if (before > 0 && after <= before * 0.5) {
          drops.push({ provider, before, after });
        }
      }

      if (drops.length > 0) {
        await alertProviderDrop(webhook, drops);
      }

      // Persist today's counts for tomorrow's comparison
      await histRef.set({ counts: current, updatedAt: Timestamp.now() });
    } catch (err) {
      console.warn("[catalog] provider-drop check failed:", err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// HTTP query function — GET /models
// ─────────────────────────────────────────────────────────────
export const queryModels = onRequest(
  {
    region: "us-central1",
    maxInstances: 5,
    cors: true,
  },
  handleQueryModels
);

// ─────────────────────────────────────────────────────────────
// Plugin defaults — GET /plugin-defaults
// ─────────────────────────────────────────────────────────────
export const queryPluginDefaults = onRequest(
  {
    region: "us-central1",
    maxInstances: 5,
    cors: true,
  },
  handlePluginDefaults
);

// ─────────────────────────────────────────────────────────────
// Manual trigger — HTTP POST to run collection on demand
// ─────────────────────────────────────────────────────────────
export const collectModelCatalogManual = onRequest(
  {
    region: "us-central1",
    maxInstances: 1,
    timeoutSeconds: 540,
    memory: "512MiB",
    cors: true,
    secrets: CATALOG_SECRETS,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed — use POST" });
      return;
    }

    console.log("[catalog] manual collection triggered");

    try {
      const orchestrator = new CollectorOrchestrator();
      const results = await orchestrator.runAll();

      const merged = mergeResults(results);
      const writer = new FirestoreWriter();
      await writer.write(merged);

      // Clean up stale docs
      const currentIds = new Set(merged.map(m => m.modelId));
      await writer.cleanupStale(currentIds);

      // Auto-generate recommended models
      const recommended = await generateRecommendedModels();

      const successCount = results.filter(r => !r.error).length;
      const failureCount = results.filter(r => r.error).length;

      res.status(200).json({
        ok: true,
        modelsCollected: results.reduce((s, r) => s + r.models.length, 0),
        modelsMerged: merged.length,
        recommendedModels: recommended.length,
        collectorsOk: successCount,
        collectorsFailed: failureCount,
        errors: results.filter(r => r.error).map(r => ({
          collectorId: r.collectorId,
          error: r.error,
        })),
      });
    } catch (err) {
      console.error("[catalog] manual collection failed:", err);
      res.status(500).json({ error: String(err) });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// One-off migration: delete stale vendor-prefixed model docs
// These are duplicates of cleanly-named docs created by Fix F.
// ─────────────────────────────────────────────────────────────
export const cleanupStalePrefixedDocs = onRequest(
  {
    region: "us-central1",
    maxInstances: 1,
    timeoutSeconds: 120,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed — use POST" });
      return;
    }

    try {
      const snap = await db.collection("models").get();
      const toDelete: string[] = [];

      for (const doc of snap.docs) {
        const data = doc.data() as { modelId?: string };
        // Firestore doc IDs have "/" replaced with "__", check both the doc ID and the modelId field
        if (doc.id.includes("__") || (data.modelId && data.modelId.includes("/"))) {
          toDelete.push(doc.id);
        }
      }

      const writer = db.bulkWriter();
      for (const id of toDelete) {
        writer.delete(db.collection("models").doc(id));
      }
      await writer.close();

      console.log(`[cleanup] deleted ${toDelete.length} stale prefixed docs`);
      res.status(200).json({ ok: true, deleted: toDelete.length, ids: toDelete });
    } catch (err) {
      console.error("[cleanup] failed:", err);
      res.status(500).json({ error: String(err) });
    }
  }
);
