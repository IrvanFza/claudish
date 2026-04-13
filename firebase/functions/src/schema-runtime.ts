import { z } from "zod";
import type {
  RawModel as RawModelType,
  RecommendedModelsDoc as RecommendedModelsDocType,
  RecommendedModelEntry as RecommendedModelEntryType,
} from "./schema.js";

// ─────────────────────────────────────────────────────────────
// Canonical provider slugs
//
// This is the AUTHORITATIVE list of valid provider slugs that may
// appear anywhere in the pipeline. Everything else gets rejected or
// aliased at ingress (see PROVIDER_ALIAS_MAP below).
//
// Adding a new provider? You MUST update this list.
// ─────────────────────────────────────────────────────────────
export const KNOWN_PROVIDER_SLUGS = [
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "qwen",
  "z-ai",
  "moonshotai",
  "minimax",
  "openrouter",
  "togethercomputer",
  "mistralai",
  "deepseek",
  "fireworks-ai",
  "opencode-zen",
  "meta-llama",
  "nvidia",
  "black-forest-labs",
  "bytedance",
  "alibaba",
  "baidu",
  "tencent",
  "01-ai",
  "stability-ai",
  "perplexity",
  "cohere",
  "ai21",
] as const;

export type CanonicalProviderSlug = typeof KNOWN_PROVIDER_SLUGS[number];

export const ProviderSlugEnum = z.enum(KNOWN_PROVIDER_SLUGS);

/**
 * Maps known provider aliases to canonical slugs.
 * Add a new entry here when a collector emits a non-canonical name.
 */
export const PROVIDER_ALIAS_MAP: Record<string, CanonicalProviderSlug> = {
  minimaxai: "minimax",
  moonshot: "moonshotai",
  kimi: "moonshotai",
  xai: "x-ai",
  zhipu: "z-ai",
  zai: "z-ai",
  glm: "z-ai",
  "together-ai": "togethercomputer",
  together: "togethercomputer",
  mistral: "mistralai",
};

const KNOWN_PROVIDER_SET: Set<string> = new Set(KNOWN_PROVIDER_SLUGS);

/**
 * Canonicalize a raw provider string to a CanonicalProviderSlug.
 * Returns null if the provider cannot be recognized.
 */
export function canonicalizeProviderSlug(
  raw: string | undefined | null,
): CanonicalProviderSlug | null {
  if (!raw) return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return null;

  // Direct match
  if (KNOWN_PROVIDER_SET.has(lowered)) return lowered as CanonicalProviderSlug;

  // Alias match
  const aliased = PROVIDER_ALIAS_MAP[lowered];
  if (aliased) return aliased;

  return null;
}

// ─────────────────────────────────────────────────────────────
// Canonical model ID
// ─────────────────────────────────────────────────────────────

/**
 * Canonicalize a raw model ID to the form stored in Firestore and
 * emitted to the recommended-models doc.
 *
 * Rules:
 *  1. Lowercase
 *  2. Strip `:free` suffix
 *  3. Strip vendor prefix (everything up to and including the LAST `/`)
 *
 * This is the ONE place in the system where this logic lives. All
 * ingress goes through RawModelSchema.transform() below.
 */
export function canonicalizeModelId(raw: string): string {
  let id = raw.toLowerCase().trim();
  // Strip :free suffix
  id = id.replace(/:free$/, "");
  // Strip everything up to the last slash (handles nested prefixes)
  const lastSlash = id.lastIndexOf("/");
  if (lastSlash >= 0) id = id.slice(lastSlash + 1);
  return id;
}

/**
 * Returns true if the given ID is already in canonical form:
 * lowercase, no `/`, no `:free` suffix.
 */
export function isCanonicalModelId(id: string): boolean {
  if (id !== id.toLowerCase()) return false;
  if (id.includes("/")) return false;
  if (id.endsWith(":free")) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────

// Model ID character class: lowercase letters, digits, dot, underscore, dash
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_ID_MIN = 1;
const MODEL_ID_MAX = 100;

// Pricing bounds (USD per million tokens)
const PRICING_INPUT_MAX = 1000;
const PRICING_OUTPUT_MAX = 2000;

// Context window bounds
const CONTEXT_MIN = 1000;
const CONTEXT_MAX = 10_000_000;

export const ConfidenceTierSchema = z.enum([
  "scrape_unverified",
  "scrape_verified",
  "aggregator_reported",
  "gateway_official",
  "api_official",
]);

export const PricingDataSchema = z.object({
  input: z.number().min(0).max(PRICING_INPUT_MAX),
  output: z.number().min(0).max(PRICING_OUTPUT_MAX),
  cachedRead: z.number().optional(),
  cachedWrite: z.number().optional(),
  imageInput: z.number().optional(),
  audioInput: z.number().optional(),
  batchDiscountPct: z.number().optional(),
});

export const CapabilityFlagsSchema = z.object({
  vision: z.boolean().optional(),
  thinking: z.boolean().optional(),
  tools: z.boolean().optional(),
  streaming: z.boolean().optional(),
  batchApi: z.boolean().optional(),
  jsonMode: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  citations: z.boolean().optional(),
  codeExecution: z.boolean().optional(),
  pdfInput: z.boolean().optional(),
  fineTuning: z.boolean().optional(),
  audioInput: z.boolean().optional(),
  videoInput: z.boolean().optional(),
  imageOutput: z.boolean().optional(),
  promptCaching: z.boolean().optional(),
  contextManagement: z.boolean().optional(),
  effortLevels: z.array(z.string()).optional(),
  adaptiveThinking: z.boolean().optional(),
}).passthrough();

const CanonicalIdSchema = z
  .string()
  .min(MODEL_ID_MIN)
  .max(MODEL_ID_MAX)
  .regex(
    MODEL_ID_RE,
    "modelId must be lowercase, no vendor prefix (no slashes), and match /^[a-z0-9][a-z0-9._-]*$/",
  );

/**
 * RawModelSchema — validates AND normalizes raw collector output.
 *
 * On parse:
 *  - externalId is left as-is (that's the upstream id, never mutated)
 *  - canonicalId is derived via canonicalizeModelId(canonicalId ?? externalId)
 *  - provider is canonicalized via canonicalizeProviderSlug()
 *    (unknown providers become null — caller decides to skip/warn)
 *  - pricing / contextWindow are bounds-checked
 */
export const RawModelSchema = z.object({
  collectorId: z.string().min(1),
  confidence: ConfidenceTierSchema,
  sourceUrl: z.string(),

  externalId: z.string().min(1),
  canonicalId: z.string().optional(),
  displayName: z.string().optional(),
  provider: z.string().optional(),

  pricing: PricingDataSchema.optional(),
  contextWindow: z
    .number()
    .int()
    .min(CONTEXT_MIN)
    .max(CONTEXT_MAX)
    .optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: CapabilityFlagsSchema.optional(),
  aliases: z.array(z.string()).optional(),
  status: z.enum(["active", "deprecated", "preview", "unknown"]).optional(),
  description: z.string().optional(),
  releaseDate: z.string().optional(),
  apiVersion: z.string().optional(),
}).transform((raw, ctx) => {
  // Canonicalize model id
  const rawCandidate = raw.canonicalId ?? raw.externalId;
  const canonicalId = canonicalizeModelId(rawCandidate);
  if (!MODEL_ID_RE.test(canonicalId) || canonicalId.length < MODEL_ID_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalId"],
      message: `canonicalId "${canonicalId}" (from "${rawCandidate}") is not a valid canonical model id`,
    });
    return z.NEVER;
  }

  // Canonicalize provider
  const canonicalProvider = canonicalizeProviderSlug(raw.provider);
  if (raw.provider && !canonicalProvider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `unknown provider "${raw.provider}" — not in KNOWN_PROVIDER_SLUGS or PROVIDER_ALIAS_MAP`,
    });
    return z.NEVER;
  }

  return {
    ...raw,
    canonicalId,
    provider: canonicalProvider ?? undefined,
  };
});

export type RawModelParsed = z.infer<typeof RawModelSchema>;

// ─────────────────────────────────────────────────────────────
// Recommended doc schemas
// ─────────────────────────────────────────────────────────────

export const RecommendedPricingSchema = z.object({
  input: z.string(),
  output: z.string(),
  average: z.string(),
});

export const RecommendedSubscriptionSchema = z.object({
  prefix: z.string().min(1),
  plan: z.string().min(1),
  command: z.string().min(1),
});

export const RecommendedModelEntrySchema = z.object({
  id: CanonicalIdSchema,
  openrouterId: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string().min(1),
  category: z.string().min(1),
  priority: z.number().int().min(1),
  pricing: RecommendedPricingSchema,
  context: z.string(),
  maxOutputTokens: z.number().int().nullable(),
  modality: z.string(),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsVision: z.boolean(),
  isModerated: z.boolean(),
  recommended: z.literal(true),
  subscription: RecommendedSubscriptionSchema.optional(),
});

export const RecommendedModelsDocSchema = z.object({
  version: z.string(),
  lastUpdated: z.string(),
  generatedAt: z.string(),
  source: z.literal("firebase-auto"),
  models: z.array(RecommendedModelEntrySchema),
});

// ─────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────

export type ValidateRawModelResult =
  | { ok: true; model: RawModelType }
  | { ok: false; error: string; raw: unknown };

/**
 * Validate and normalize a raw collector output.
 *
 * Never throws. Returns a discriminated union so callers can
 * decide to skip the model, log a warning, or surface an error.
 */
export function validateRawModel(
  raw: unknown,
  collectorId: string,
): ValidateRawModelResult {
  const result = RawModelSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `[${collectorId}] invalid RawModel — ${issues}`,
      raw,
    };
  }
  // The parsed result is structurally a RawModel (canonicalId/provider normalized)
  return { ok: true, model: result.data as unknown as RawModelType };
}

export type ValidateRecommendedDocResult =
  | { ok: true; doc: RecommendedModelsDocType }
  | { ok: false; errors: string[] };

export function validateRecommendedDoc(
  doc: unknown,
): ValidateRecommendedDocResult {
  const result = RecommendedModelsDocSchema.safeParse(doc);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return { ok: false, errors };
  }
  return {
    ok: true,
    doc: result.data as unknown as RecommendedModelsDocType,
  };
}

// Re-export type for convenience
export type { RecommendedModelEntryType as RecommendedModelEntry };
