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

/**
 * Defense-in-depth — strips internal search-bag fields from any object
 * before it's serialized to an API consumer. toPublicModel() already
 * uses a whitelist, but this is called on EVERY returned shape
 * (top100 entries, search results, raw ModelDocs) in case anyone
 * accidentally spreads a full doc into a response.
 */
function stripInternalFields<T extends object>(doc: T): T {
  const clone = { ...doc } as Record<string, unknown>;
  delete clone.searchBag;
  delete clone.searchBagHash;
  delete clone.searchBagGeneratedAt;
  delete clone.searchBagModel;
  return clone as T;
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
      // Slim projection is a whitelist — searchBag can't leak here by
      // construction, but the explicit field pick keeps it that way.
      const models = snap.docs.map(d => {
        const data = d.data() as ModelDoc;
        return {
          modelId: data.modelId,
          aliases: data.aliases,
          sources: data.sources,
          ...(data.aggregators && data.aggregators.length > 0
            ? { aggregators: data.aggregators }
            : {}),
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
      // Defense-in-depth — recommended entries don't carry searchBag fields
      // today, but strip anyway so a future regression can't leak them.
      const sanitized = {
        ...recDoc,
        models: (recDoc.models ?? []).map(m =>
          stripInternalFields(m as unknown as Record<string, unknown>)
        ),
      };
      res.status(200).json(sanitized);
    } catch (err) {
      console.error("[catalog] Recommended models query failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  // ── Providers catalog: ?catalog=providers ────────────────────────────────
  // Returns every provider slug in the catalog with its active-model count,
  // sorted desc by count. Powers the CLI `--list-providers` command.
  if (req.query.catalog === "providers") {
    try {
      const snap = await db
        .collection("models")
        .where("status", "==", "active")
        .get();

      const counts = new Map<string, number>();
      for (const d of snap.docs) {
        const p = (d.data() as ModelDoc).provider;
        if (!p) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      const providers = Array.from(counts.entries())
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => b.count - a.count);

      res.status(200).json({ providers, total: providers.length });
    } catch (err) {
      console.error("[catalog] Providers query failed:", err);
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
        return stripInternalFields(base);
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

  const searchTerm = req.query.search ? String(req.query.search).toLowerCase() : null;
  const requestedLimit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);

  // ── Search: token-based scoring against LLM-generated searchBag ──────────
  // On ?search=<q>:
  //   1. Tokenize the query (lowercase, split on whitespace)
  //   2. Fetch a wide pool (500) using the filters already applied above
  //   3. Score each doc in-memory (modelId exact/prefix, alias match,
  //      searchBag token hits, substring match on id/displayName)
  //   4. Return the top N by score, stripped of internal fields
  //
  // The search bag is populated by the writer at ingest time (see
  // writer.ts / search-bag-builder.ts). Docs without a bag fall back to
  // substring matches only — so the new path never regresses vs. the
  // old substring-only implementation.
  if (searchTerm) {
    const queryTokens = searchTerm.split(/\s+/).filter(Boolean);
    const fetchLimit = 500;
    query = query.limit(fetchLimit);

    try {
      const snap = await query.get();
      const docs = snap.docs.map(d => d.data() as ModelDoc);

      const scored = docs.map(m => {
        let score = 0;
        const bag = new Set((m.searchBag ?? []).map(t => t.toLowerCase()));
        const idLower = m.modelId.toLowerCase();
        const nameLower = (m.displayName ?? "").toLowerCase();

        // Exact match on modelId or alias — strongest signal
        if (idLower === searchTerm) score += 100;
        if (idLower.startsWith(searchTerm)) score += 30;
        if ((m.aliases ?? []).some(a => a.toLowerCase() === searchTerm)) score += 30;

        // Per-token contributions
        for (const tok of queryTokens) {
          if (bag.has(tok)) score += 10;
          if (idLower.includes(tok)) score += 3;
          if (nameLower.includes(tok)) score += 2;
          if ((m.aliases ?? []).some(a => a.toLowerCase().includes(tok))) score += 2;
        }

        return { doc: m, score };
      });

      const results = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, requestedLimit)
        .map(s => stripInternalFields(toPublicModel(s.doc) as unknown as Record<string, unknown>));

      res.status(200).json({ models: results, total: results.length });
    } catch (err) {
      console.error("[catalog] Search query failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
    return;
  }

  // Non-search path — apply the caller's requested limit directly.
  query = query.limit(requestedLimit);

  try {
    const snap = await query.get();
    const docs = snap.docs.map(d => d.data() as ModelDoc);
    const models = docs.map(d =>
      stripInternalFields(toPublicModel(d) as unknown as Record<string, unknown>)
    );
    res.status(200).json({ models, total: models.length });
  } catch (err) {
    console.error("[catalog] Firestore query failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
}
