import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { CollectionReference, Query } from "firebase-admin/firestore";
import type { ModelDoc, ModelChangeDoc, RecommendedModelsDoc } from "./schema.js";

export async function handleQueryModels(req: Request, res: Response): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const db = getFirestore();

  // ── Changelog query: ?changes=true&modelId=xxx ──────────────────────────
  // Returns the last N changelog entries for a specific model.
  if (req.query.changes === "true") {
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    if (!modelId) {
      res.status(400).json({ error: "modelId is required when changes=true" });
      return;
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);

    try {
      const changelogSnap = await db
        .collection("models")
        .doc(modelId)
        .collection("changelog")
        .orderBy("detectedAt", "desc")
        .limit(limit)
        .get();

      const changelog = changelogSnap.docs.map(d => d.data() as ModelChangeDoc);
      res.status(200).json({ modelId, changelog, total: changelog.length });
    } catch (err) {
      console.error("[catalog] Changelog query failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  // ── Slim catalog query: ?catalog=slim ────────────────────────────────────
  // Returns a slim projection for CLI model resolution (modelId, aliases, sources).
  // Higher limit (1000) since this powers the catalog resolver, not user-facing display.
  if (req.query.catalog === "slim") {
    const catalogLimit = Math.min(parseInt(String(req.query.limit ?? "1000"), 10), 2000);
    let catalogQuery: Query = db.collection("models") as CollectionReference;
    catalogQuery = catalogQuery.where("status", "==", "active");
    catalogQuery = catalogQuery.limit(catalogLimit);

    try {
      const snap = await catalogQuery.get();
      const models = snap.docs.map(d => {
        const data = d.data() as ModelDoc;
        return {
          modelId: data.modelId,
          aliases: data.aliases,
          sources: data.sources,
        };
      });
      res.status(200).json({ models, total: models.length });
    } catch (err) {
      console.error("[catalog] Slim catalog query failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  // ── Recommended catalog query: ?catalog=recommended ──────────────────────
  // Returns the auto-generated recommended models list (scoring-based).
  if (req.query.catalog === "recommended") {
    try {
      const recSnap = await db.collection("config").doc("recommended-models").get();
      if (!recSnap.exists) {
        res.status(200).json({
          version: "0.0.0",
          lastUpdated: "1970-01-01",
          source: "firebase-auto",
          models: [],
        });
        return;
      }
      const recDoc = recSnap.data() as RecommendedModelsDoc;
      res.status(200).json(recDoc);
    } catch (err) {
      console.error("[catalog] Recommended models query failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  // ── Standard model list query ────────────────────────────────────────────
  let query: Query = db.collection("models") as CollectionReference;

  // Filter: ?provider=anthropic
  if (req.query.provider) {
    query = query.where("provider", "==", String(req.query.provider));
  }

  // Filter: ?status=active (default: active only)
  const statusFilter = req.query.status ?? "active";
  if (statusFilter !== "all") {
    query = query.where("status", "==", String(statusFilter));
  }

  // Filter: ?maxPriceInput=5.0 (USD per MTok)
  if (req.query.maxPriceInput) {
    const max = parseFloat(String(req.query.maxPriceInput));
    if (!isNaN(max)) {
      query = query.where("pricing.input", "<=", max);
    }
  }

  // Filter: ?minContext=100000
  if (req.query.minContext) {
    const min = parseInt(String(req.query.minContext), 10);
    if (!isNaN(min)) {
      query = query.where("contextWindow", ">=", min);
    }
  }

  // Filter: ?search=gpt (case-insensitive substring match on modelId / displayName)
  // Firestore doesn't support native substring search — handled client-side after fetch
  const searchTerm = req.query.search ? String(req.query.search).toLowerCase() : null;

  // Limit (max 200)
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  query = query.limit(limit);

  try {
    const snap = await query.get();
    let models = snap.docs.map(d => d.data() as ModelDoc);

    // Apply client-side search filter if specified
    if (searchTerm) {
      models = models.filter(m =>
        m.modelId.toLowerCase().includes(searchTerm) ||
        m.displayName.toLowerCase().includes(searchTerm) ||
        m.aliases.some(a => a.toLowerCase().includes(searchTerm))
      );
    }

    res.status(200).json({ models, total: models.length });
  } catch (err) {
    console.error("[catalog] Firestore query failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
}
