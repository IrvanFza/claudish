import type { CollectorResult, RawModel } from "../schema.js";
import { validateRawModel } from "../schema-runtime.js";

export abstract class BaseCollector {
  abstract readonly collectorId: string;

  /** Run collection. Never throws — errors are captured in result.error. */
  abstract collect(): Promise<CollectorResult>;

  /**
   * Package collector output into a CollectorResult, running every raw
   * model through the schema gate (validation + canonicalization).
   *
   * Models that fail validation are dropped and logged as warnings.
   * This is the ONE place where raw collector data enters the pipeline,
   * so any downstream code can trust that:
   *   - `canonicalId` is already canonical (lowercase, no `/`, no `:free`)
   *   - `provider` is already a CanonicalProviderSlug (or undefined)
   *   - pricing/context bounds are already enforced
   */
  protected makeResult(
    models: CollectorResult["models"],
    error?: string
  ): CollectorResult {
    const validated: RawModel[] = [];
    for (const raw of models) {
      const result = validateRawModel(raw, this.collectorId);
      if (result.ok) {
        validated.push(result.model);
      } else {
        console.warn(`[${this.collectorId}] dropped invalid model: ${result.error}`);
      }
    }
    return {
      collectorId: this.collectorId,
      models: validated,
      error,
      fetchedAt: new Date(),
    };
  }
}
