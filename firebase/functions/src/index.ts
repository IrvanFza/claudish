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
import { alertCatalogResults, alertNewModels } from "./slack-alert.js";

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

      const successCount = results.filter(r => !r.error).length;
      const failureCount = results.filter(r => r.error).length;

      res.status(200).json({
        ok: true,
        modelsCollected: results.reduce((s, r) => s + r.models.length, 0),
        modelsMerged: merged.length,
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
