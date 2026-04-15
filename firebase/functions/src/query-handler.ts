import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { CollectionReference, Query } from "firebase-admin/firestore";
import type { ModelDoc, ModelChangeDoc, RecommendedModelsDoc } from "./schema.js";
import { computeGenerationScores, scoreForTop100 } from "./popularity-scores.js";

// ─────────────────────────────────────────────────────────────
// Public model projection
//
// The full ModelDoc stored in Firestore carries internal provenance
// tracking (sources, fieldSources, lastUpdated, lastChecked, staleness
// flags) that's relevant to the data pipeline but NOT to API consumers.
// Exposing those fields creates a leaky contract — clients may start
// depending on collector IDs and source URLs, blocking any future
// refactor of the ingestion layer.
//
// toPublicModel() is the ONE place that shapes model objects for
// public list endpoints (top100, standard list, search). The /?catalog=slim
// endpoint has its own contract used by the CLI catalog resolver and is
// unaffected. /?catalog=recommended also has its own slim shape.
// ─────────────────────────────────────────────────────────────

interface PublicModel {
  modelId: string;
  displayName: string;
  description?: string;
  provider: string;
  family?: string;
  releaseDate?: string;

  pricing?: ModelDoc["pricing"];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelDoc["capabilities"];

  aliases: string[];
  status: ModelDoc["status"];
}

function toPublicModel(doc: ModelDoc): PublicModel {
  const out: PublicModel = {
    modelId: doc.modelId,
    displayName: doc.displayName,
    provider: doc.provider,
    aliases: doc.aliases,
    status: doc.status,
    capabilities: doc.capabilities,
  };
  if (doc.description !== undefined) out.description = doc.description;
  if (doc.family !== undefined) out.family = doc.family;
  if (doc.releaseDate !== undefined) out.releaseDate = doc.releaseDate;
  if (doc.pricing !== undefined) out.pricing = doc.pricing;
  if (doc.contextWindow !== undefined) out.contextWindow = doc.contextWindow;
  if (doc.maxOutputTokens !== undefined) out.maxOutputTokens = doc.maxOutputTokens;
  return out;
}

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

  // ── Top 100 ranked catalog: ?catalog=top100 ──────────────────────────────
  // Returns models ranked by a composite score combining provider popularity,
  // release recency, generation freshness, capabilities, context, and data
  // confidence. Eligibility: status=active AND has pricing.
  //
  // Query params:
  //   ?limit=<n>         — override result count (default 100, max 200)
  //   ?includeScores=1   — include per-model score breakdown
  if (req.query.catalog === "top100") {
    const top100Limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 200);
    const includeScores = req.query.includeScores === "1" || req.query.includeScores === "true";

    try {
      // Eligibility: active + pricing present.
      // Firestore can only filter `pricing.input` server-side (the `!= null`
      // check is cheap and uses the existing pricing index). We fetch a wider
      // pool (500) so the in-memory ranking has enough signal to pick 100.
      const snap = await db
        .collection("models")
        .where("status", "==", "active")
        .limit(500)
        .get();

      const eligible = snap.docs
        .map(d => d.data() as ModelDoc)
        .filter(m => m.pricing && typeof m.pricing.input === "number" && typeof m.pricing.output === "number");

      // Compute generation scores across the whole eligible pool so every
      // model knows where it sits in its family.
      const generationScores = computeGenerationScores(eligible);

      const ranked = eligible
        .map(m => {
          const genScore = generationScores.get(m.modelId) ?? 0.5;
          const score = scoreForTop100(m, genScore);
          return { model: m, score };
        })
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, top100Limit);

      const models = ranked.map((entry, idx) => {
        const base: Record<string, unknown> = {
          ...toPublicModel(entry.model),
          rank: idx + 1,
          score: entry.score.total,
        };
        if (includeScores) {
          base.scoreBreakdown = entry.score;
        }
        return base;
      });

      res.status(200).json({
        models,
        total: models.length,
        poolSize: eligible.length,
        scoring: {
          weights: {
            popularity: 0.25,
            recency: 0.30,
            generation: 0.20,
            capabilities: 0.10,
            context: 0.10,
            confidence: 0.05,
          },
        },
      });
    } catch (err) {
      console.error("[catalog] Top100 query failed:", err);
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
  // Firestore doesn't support native substring search — handled client-side after fetch.
  // When search is present, fetch a wider pool (up to 500) before the substring filter
  // so narrow searches don't miss matches that fall outside the user's requested limit.
  const searchTerm = req.query.search ? String(req.query.search).toLowerCase() : null;

  const requestedLimit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const fetchLimit = searchTerm ? 500 : requestedLimit;
  query = query.limit(fetchLimit);

  try {
    const snap = await query.get();
    let docs = snap.docs.map(d => d.data() as ModelDoc);

    // Apply client-side search filter, then trim to the user's requested limit.
    if (searchTerm) {
      docs = docs
        .filter(m =>
          m.modelId.toLowerCase().includes(searchTerm) ||
          m.displayName.toLowerCase().includes(searchTerm) ||
          m.aliases.some(a => a.toLowerCase().includes(searchTerm))
        )
        .slice(0, requestedLimit);
    }

    const models = docs.map(toPublicModel);
    res.status(200).json({ models, total: models.length });
  } catch (err) {
    console.error("[catalog] Firestore query failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
}
