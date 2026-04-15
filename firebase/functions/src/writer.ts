import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { ModelDoc, FieldChange, ModelChangeDoc } from "./schema.js";
import { buildSearchBag, computeBagHash, SEARCH_BAG_MODEL } from "./search-bag-builder.js";

export class FirestoreWriter {
  private db = getFirestore();

  /**
   * Write merged docs to Firestore. Returns IDs of newly created models.
   *
   * @param docs   The merged model docs to write.
   * @param apiKey Optional Gemini API key. When provided, each doc's
   *               identity is hashed and a search bag is (re)generated
   *               iff the hash changed since the last write. Pass ""
   *               to skip search-bag maintenance entirely (tests, etc).
   */
  async write(docs: ModelDoc[], apiKey = ""): Promise<string[]> {
    const writer = this.db.bulkWriter();
    const newModelIds: string[] = [];

    for (const doc of docs) {
      // Post-refactor, modelId is always canonical (lowercase, no `/`, no `:free`)
      // because the schema gate in BaseCollector.makeResult enforces it.
      // This assertion is a paranoid regression check — if it ever fires, a
      // collector bypassed makeResult or the schema was loosened.
      if (doc.modelId.includes("/")) {
        throw new Error(
          `[writer] non-canonical modelId reached writer: "${doc.modelId}" — ` +
          `contains "/". Schema gate bypassed?`,
        );
      }
      const docId = doc.modelId;
      const ref = this.db.collection("models").doc(docId);

      // Read existing doc to detect changes (individual reads, not in bulkWriter)
      const existing = await ref.get();
      const existingData = existing.data() as ModelDoc | undefined;

      // ── Search bag maintenance ──────────────────────────────────────
      // Regenerate only when identity hash changed (or bag is missing).
      // Skip entirely if apiKey is empty — the LLM call is optional here.
      if (apiKey) {
        const newHash = computeBagHash(doc);
        const existingHash = existingData?.searchBagHash;
        if (newHash !== existingHash || !existingData?.searchBag) {
          try {
            const bag = await buildSearchBag(doc, apiKey);
            doc.searchBag = bag;
            doc.searchBagHash = newHash;
            doc.searchBagGeneratedAt = Timestamp.now();
            doc.searchBagModel = SEARCH_BAG_MODEL;
          } catch (err) {
            // buildSearchBag shouldn't throw (it has its own fallback) —
            // but if it somehow does, keep existing bag and log.
            console.warn(
              `[writer] search bag regeneration failed for ${doc.modelId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (existingData?.searchBag) {
              doc.searchBag = existingData.searchBag;
              doc.searchBagHash = existingData.searchBagHash;
              doc.searchBagGeneratedAt = existingData.searchBagGeneratedAt;
              doc.searchBagModel = existingData.searchBagModel;
            }
          }
        } else {
          // Preserve existing bag (merge:true would anyway, but be explicit)
          doc.searchBag = existingData.searchBag;
          doc.searchBagHash = existingData.searchBagHash;
          doc.searchBagGeneratedAt = existingData.searchBagGeneratedAt;
          doc.searchBagModel = existingData.searchBagModel;
        }
      }

      // Upsert main document
      writer.set(ref, doc, { merge: true });

      if (!existingData) {
        newModelIds.push(doc.modelId);
        // New model — write a "created" changelog entry (no field-level diffs)
        const changelogRef = ref.collection("changelog").doc();
        const changeDoc: ModelChangeDoc = {
          detectedAt: doc.lastUpdated,
          collectorId: doc.fieldSources?.pricing?.collectorId
            ?? doc.fieldSources?.displayName?.collectorId
            ?? "unknown",
          confidence: doc.fieldSources?.pricing?.confidence
            ?? doc.fieldSources?.displayName?.confidence
            ?? "scrape_unverified",
          sourceUrl: doc.fieldSources?.pricing?.sourceUrl
            ?? doc.fieldSources?.displayName?.sourceUrl,
          changes: [],
          changeType: "created",
        };
        writer.set(changelogRef, changeDoc);
      } else {
        // Existing model — detect all field changes
        const changes = detectChanges(existingData, doc);

        if (changes.length > 0) {
          // Determine changeType
          let changeType: ModelChangeDoc["changeType"] = "updated";
          const statusChange = changes.find(c => c.field === "status");
          if (statusChange) {
            if (statusChange.newValue === "deprecated") {
              changeType = "deprecated";
            } else if (statusChange.oldValue === "deprecated") {
              changeType = "reactivated";
            }
          }

          // Determine the best collectorId / confidence for this entry
          // Use pricing source as primary, fall back to displayName or unknown
          const collectorId = doc.fieldSources?.pricing?.collectorId
            ?? doc.fieldSources?.displayName?.collectorId
            ?? "unknown";
          const confidence = doc.fieldSources?.pricing?.confidence
            ?? doc.fieldSources?.displayName?.confidence
            ?? "scrape_unverified";
          const sourceUrl = doc.fieldSources?.pricing?.sourceUrl
            ?? doc.fieldSources?.displayName?.sourceUrl;

          const changelogRef = ref.collection("changelog").doc();
          const changeDoc: ModelChangeDoc = {
            detectedAt: doc.lastUpdated,
            collectorId,
            confidence,
            sourceUrl,
            changes,
            changeType,
          };
          writer.set(changelogRef, changeDoc);
        }
      }

    }

    await writer.close();
    return newModelIds;
  }

  /**
   * Mark models not in the current merged set as deprecated.
   * This cleans up stale docs from previous runs where collector IDs changed
   * (e.g. xAI versioned IDs → clean aliases).
   */
  async cleanupStale(currentModelIds: Set<string>): Promise<number> {
    const snap = await this.db.collection("models")
      .where("status", "in", ["active", "preview"])
      .get();

    const writer = this.db.bulkWriter();
    let count = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data() as ModelDoc;
      // If this doc's modelId wasn't produced by the current merge, mark it stale
      if (!currentModelIds.has(data.modelId)) {
        // Only mark stale if it hasn't been updated recently (avoid race conditions)
        const lastUpdated = data.lastUpdated?.toMillis() ?? 0;
        const ageHours = (Date.now() - lastUpdated) / (1000 * 60 * 60);
        if (ageHours > 48) {
          writer.update(docSnap.ref, {
            status: "deprecated",
            dataFreshnessWarning: true,
          });
          count++;
        }
      }
    }

    await writer.close();
    if (count > 0) {
      console.log(`[catalog] marked ${count} stale models as deprecated`);
    }
    return count;
  }
}

/**
 * Detect all meaningful field changes between an existing ModelDoc and an incoming one.
 * Returns an array of FieldChange entries for every field that differs.
 */
function detectChanges(existing: ModelDoc, incoming: ModelDoc): FieldChange[] {
  const changes: FieldChange[] = [];

  // ── Pricing fields (individual granularity) ──────────────────────────────
  if (existing.pricing?.input !== incoming.pricing?.input)
    changes.push({ field: "pricing.input", oldValue: existing.pricing?.input ?? null, newValue: incoming.pricing?.input ?? null });
  if (existing.pricing?.output !== incoming.pricing?.output)
    changes.push({ field: "pricing.output", oldValue: existing.pricing?.output ?? null, newValue: incoming.pricing?.output ?? null });
  if (existing.pricing?.cachedRead !== incoming.pricing?.cachedRead)
    changes.push({ field: "pricing.cachedRead", oldValue: existing.pricing?.cachedRead ?? null, newValue: incoming.pricing?.cachedRead ?? null });
  if (existing.pricing?.cachedWrite !== incoming.pricing?.cachedWrite)
    changes.push({ field: "pricing.cachedWrite", oldValue: existing.pricing?.cachedWrite ?? null, newValue: incoming.pricing?.cachedWrite ?? null });
  if (existing.pricing?.imageInput !== incoming.pricing?.imageInput)
    changes.push({ field: "pricing.imageInput", oldValue: existing.pricing?.imageInput ?? null, newValue: incoming.pricing?.imageInput ?? null });
  if (existing.pricing?.audioInput !== incoming.pricing?.audioInput)
    changes.push({ field: "pricing.audioInput", oldValue: existing.pricing?.audioInput ?? null, newValue: incoming.pricing?.audioInput ?? null });
  if (existing.pricing?.batchDiscountPct !== incoming.pricing?.batchDiscountPct)
    changes.push({ field: "pricing.batchDiscountPct", oldValue: existing.pricing?.batchDiscountPct ?? null, newValue: incoming.pricing?.batchDiscountPct ?? null });

  // ── Context / output limits ───────────────────────────────────────────────
  if (existing.contextWindow !== incoming.contextWindow)
    changes.push({ field: "contextWindow", oldValue: existing.contextWindow ?? null, newValue: incoming.contextWindow ?? null });
  if (existing.maxOutputTokens !== incoming.maxOutputTokens)
    changes.push({ field: "maxOutputTokens", oldValue: existing.maxOutputTokens ?? null, newValue: incoming.maxOutputTokens ?? null });

  // ── Lifecycle / status ────────────────────────────────────────────────────
  if (existing.status !== incoming.status)
    changes.push({ field: "status", oldValue: existing.status, newValue: incoming.status });

  // ── Capability flags (each key individually) ──────────────────────────────
  const allCapKeys = new Set([
    ...Object.keys(existing.capabilities ?? {}),
    ...Object.keys(incoming.capabilities ?? {}),
  ]);
  for (const key of allCapKeys) {
    const oldVal = (existing.capabilities as Record<string, unknown>)?.[key] ?? null;
    const newVal = (incoming.capabilities as Record<string, unknown>)?.[key] ?? null;
    // Use JSON.stringify to handle arrays (e.g. effortLevels) and booleans uniformly
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: `capabilities.${key}`, oldValue: oldVal, newValue: newVal });
    }
  }

  // ── Display metadata ──────────────────────────────────────────────────────
  if (existing.displayName !== incoming.displayName)
    changes.push({ field: "displayName", oldValue: existing.displayName, newValue: incoming.displayName });
  if (existing.description !== incoming.description)
    changes.push({ field: "description", oldValue: existing.description ?? null, newValue: incoming.description ?? null });

  return changes;
}

/**
 * Mark models from failed collectors as having stale data.
 * Called when a collector returns an error but previously had data in Firestore.
 */
export async function markStaleProviderData(
  providerCollectorId: string
): Promise<void> {
  const db = getFirestore();
  const writer = db.bulkWriter();
  const now = Timestamp.now();

  // Query for all models that have this collector as a source
  // (Firestore doesn't support querying map keys directly, so we use a collection scan)
  // In practice this is a small collection — acceptable for now
  const snap = await db.collection("models").get();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as ModelDoc;
    if (data.sources && data.sources[providerCollectorId]) {
      writer.update(docSnap.ref, {
        dataFreshnessWarning: true,
        lastChecked: now,
      });
    }
  }

  await writer.close();
}
