import { Timestamp } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────
// Source confidence tier (higher index = higher trust)
// ─────────────────────────────────────────────────────────────
export type ConfidenceTier =
  | "scrape_unverified"   // scraped but not cross-validated
  | "scrape_verified"     // scraped and confirmed by API or cross-source
  | "aggregator_reported" // OpenRouter, Fireworks (not billing-authoritative)
  | "gateway_official"    // OpenCode Zen (authoritative for that gateway's billing)
  | "api_official";       // direct provider /v1/models API

export const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  scrape_unverified:   1,
  scrape_verified:     2,
  aggregator_reported: 3,
  gateway_official:    4,
  api_official:        5,
};

// ─────────────────────────────────────────────────────────────
// Pricing map (USD per million tokens)
// ─────────────────────────────────────────────────────────────
export interface PricingData {
  input: number;
  output: number;
  cachedRead?: number;
  cachedWrite?: number;
  imageInput?: number;       // USD per image
  audioInput?: number;       // USD per second
  batchDiscountPct?: number; // e.g., 50 means 50% off
}

// ─────────────────────────────────────────────────────────────
// Capability flags
// ─────────────────────────────────────────────────────────────
export interface CapabilityFlags {
  vision: boolean;
  thinking: boolean;           // extended reasoning / thinking mode
  tools: boolean;              // function calling
  streaming: boolean;
  batchApi: boolean;
  jsonMode: boolean;
  structuredOutput: boolean;
  citations: boolean;
  codeExecution: boolean;
  pdfInput: boolean;
  fineTuning: boolean;
  audioInput?: boolean;
  videoInput?: boolean;
  imageOutput?: boolean;
  promptCaching?: boolean;     // supports prompt/context caching
  contextManagement?: boolean; // Anthropic context management
  effortLevels?: string[];     // e.g. ["low", "medium", "high", "max"] for Anthropic
  adaptiveThinking?: boolean;  // supports adaptive thinking mode
}

// ─────────────────────────────────────────────────────────────
// Per-field provenance — tracks where each field value came from
// ─────────────────────────────────────────────────────────────
export interface FieldSource {
  collectorId: string;        // e.g. "google-api", "anthropic-pricing-scrape", "openrouter-api"
  confidence: ConfidenceTier;
  sourceUrl?: string;
  fetchedAt: string;          // ISO timestamp
}

// ─────────────────────────────────────────────────────────────
// Per-source attribution record (stored in sources map)
// ─────────────────────────────────────────────────────────────
export interface SourceRecord {
  confidence: ConfidenceTier;
  externalId: string;          // the ID this provider uses for the model
  lastSeen: Timestamp;
  sourceUrl?: string;          // URL where data was fetched
}

// ─────────────────────────────────────────────────────────────
// CLI-friendly aggregator entry — a flattened view of `sources` keyed by the
// canonical CLI provider name (without the "-api" or "-scrape" suffix).
//
// This is derived from `sources` at merge time. CLI consumers should prefer
// reading this field over walking `sources` directly so they don't have to
// encode the `collectorId → provider` mapping client-side.
// ─────────────────────────────────────────────────────────────
export interface AggregatorEntry {
  /** Canonical CLI provider name (e.g. "openrouter", "fireworks", "together-ai") */
  provider: string;
  /** The model ID this aggregator uses (vendor-qualified, e.g. "qwen/qwen3-coder") */
  externalId: string;
  /** Confidence tier, copied from the underlying SourceRecord */
  confidence: ConfidenceTier;
}

// ─────────────────────────────────────────────────────────────
// Changelog subcollection documents (models/{id}/changelog)
// ─────────────────────────────────────────────────────────────

// A single recorded change to one field of a model's data
export interface FieldChange {
  field: string;    // e.g. "pricing.input", "contextWindow", "capabilities.thinking", "status"
  oldValue: unknown; // previous value (null if field was added)
  newValue: unknown; // new value (null if field was removed)
}

// Change log entry — stored in models/{id}/changelog subcollection
export interface ModelChangeDoc {
  detectedAt: Timestamp;
  collectorId: string;        // which collector detected this change
  confidence: ConfidenceTier;
  sourceUrl?: string;
  changes: FieldChange[];     // all fields that changed in this update
  changeType: "created" | "updated" | "deprecated" | "reactivated";
}

// ─────────────────────────────────────────────────────────────
// Main models collection document
// ─────────────────────────────────────────────────────────────
export interface ModelDoc {
  // Identity
  modelId: string;             // canonical ID, e.g. "claude-opus-4-6"
  displayName: string;
  provider: string;            // primary provider slug, e.g. "anthropic"
  family?: string;             // model family, e.g. "claude-3"
  description?: string;        // human-readable description from provider API
  releaseDate?: string;        // ISO date string, e.g. "2026-02-17"

  // Pricing (current, highest-confidence available)
  pricing?: PricingData;

  // Context
  contextWindow?: number;      // max input tokens
  maxOutputTokens?: number;

  // Capabilities
  capabilities: Partial<CapabilityFlags>;

  // Aliases (alternative model IDs that route to this model)
  aliases: string[];

  // Lifecycle
  status: "active" | "deprecated" | "preview" | "unknown";
  deprecatedAt?: Timestamp;
  successorId?: string;        // canonical ID of replacement model

  // Per-field provenance — which collector provided each field value
  fieldSources: {
    pricing?: FieldSource;
    contextWindow?: FieldSource;
    maxOutputTokens?: FieldSource;
    capabilities?: FieldSource;      // which source provided the majority of capability flags
    displayName?: FieldSource;
    description?: FieldSource;
    status?: FieldSource;
    releaseDate?: FieldSource;
  };

  // Multi-source tracking
  // key = provider slug (e.g. "anthropic", "openrouter", "together-ai")
  sources: Record<string, SourceRecord>;

  /**
   * Multi-aggregator routing index. Optional, additive.
   * Derived from `sources` at merge time. Field is omitted (not empty) when no
   * aggregator collectors contributed data for this model.
   */
  aggregators?: AggregatorEntry[];

  // Freshness
  lastUpdated: Timestamp;
  lastChecked: Timestamp;

  // Staleness flag (set when a provider API fails but data is retained)
  dataFreshnessWarning?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Raw collected data (intermediate, pre-merge)
// ─────────────────────────────────────────────────────────────
export interface RawModel {
  // Which provider/collector produced this record
  collectorId: string;
  confidence: ConfidenceTier;
  sourceUrl: string;

  // Model identity from this provider
  externalId: string;
  canonicalId?: string;        // if collector can resolve canonical ID
  displayName?: string;
  provider?: string;

  // Raw data fields (all optional — collectors fill what they know)
  pricing?: PricingData;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<CapabilityFlags>;
  aliases?: string[];
  status?: "active" | "deprecated" | "preview" | "unknown";
  description?: string;        // human-readable description from provider API
  releaseDate?: string;        // ISO date string
  apiVersion?: string;         // provider-specific version string (e.g. "001" for Google)
}

// ─────────────────────────────────────────────────────────────
// Collector result envelope
// ─────────────────────────────────────────────────────────────
export interface CollectorResult {
  collectorId: string;
  models: RawModel[];
  error?: string;              // set if collector partially or fully failed
  fetchedAt: Date;
}

// ─────────────────────────────────────────────────────────────
// Recommended model entry (auto-generated by recommender)
// ─────────────────────────────────────────────────────────────
export interface RecommendedModelEntry {
  id: string;                    // canonical short ID (e.g. "minimax-m2.7")
  openrouterId: string;          // vendor-prefixed (e.g. "minimax/minimax-m2.7")
  name: string;                  // display name
  description: string;
  provider: string;              // capitalized provider name
  category: string;              // "programming" | "vision" | "reasoning"
  priority: number;              // 1-indexed rank
  pricing: {
    input: string;               // e.g. "$0.30/1M"
    output: string;
    average: string;
  };
  context: string;               // e.g. "196K"
  maxOutputTokens: number | null;
  modality: string;              // e.g. "text->text", "text+image->text"
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  isModerated: boolean;
  recommended: true;
  /** Subscription access: prefix@model for subscription routing */
  subscription?: {
    prefix: string;      // e.g. "cx", "go", "kc", "mmc", "gc"
    plan: string;        // e.g. "OpenAI Codex", "Gemini Code Assist"
    command: string;     // e.g. "cx@gpt-5.4" — ready to use
  };
}

export interface RecommendedModelsDoc {
  version: string;
  lastUpdated: string;           // ISO date (YYYY-MM-DD)
  generatedAt: string;           // ISO timestamp
  source: "firebase-auto";       // marks this as auto-generated
  models: RecommendedModelEntry[];
}

// ─────────────────────────────────────────────────────────────
// Plugin defaults config document (config/plugin-defaults)
// ─────────────────────────────────────────────────────────────
export interface PluginDefaultsDoc {
  version: string;
  updatedAt: Timestamp;
  updatedBy?: string;
  shortAliases: Record<string, string>;
  roles: Record<string, { modelId: string; fallback?: string }>;
  teams: Record<string, string[]>;
}
