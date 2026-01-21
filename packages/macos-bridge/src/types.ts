/**
 * Type definitions for the macOS Bridge HTTP API
 */

/**
 * API keys for different providers
 */
export interface ApiKeys {
  openrouter?: string;
  openai?: string;
  gemini?: string;
  anthropic?: string;
  minimax?: string;
  kimi?: string;
  glm?: string;
}

/**
 * Per-app model mapping configuration
 */
export interface AppModelMapping {
  /** Map from original model to target model */
  modelMap: Record<string, string>;
  /** Whether this app is enabled for proxying */
  enabled: boolean;
  /** Optional notes about this app configuration */
  notes?: string;
}

/**
 * Bridge configuration
 */
export interface BridgeConfig {
  /** Default model to use when no mapping exists */
  defaultModel?: string;
  /** Per-app configurations */
  apps: Record<string, AppModelMapping>;
  /** Global enabled state */
  enabled: boolean;
}

/**
 * Options for starting the bridge/proxy
 */
export interface BridgeStartOptions {
  apiKeys: ApiKeys;
  port?: number;
}

/**
 * Detected application information
 */
export interface DetectedApp {
  name: string;
  confidence: number;
  userAgent: string;
  lastSeen: string;
  requestCount: number;
}

/**
 * Proxy status response
 */
export interface ProxyStatus {
  running: boolean;
  port?: number;
  /** HTTPS proxy port for --proxy-server flag (same as port, explicit for clarity) */
  proxyPort?: number;
  detectedApps: DetectedApp[];
  totalRequests: number;
  activeConnections: number;
  uptime: number;
  version: string;
}

/**
 * Proxy enable response
 */
export interface ProxyEnableResponse {
  success: boolean;
  /** HTTPS proxy port to use with --proxy-server flag */
  proxyPort?: number;
  message?: string;
}

/**
 * Log entry for request tracking
 */
export interface LogEntry {
  timestamp: string;
  app: string;
  confidence: number;
  requestedModel: string;
  targetModel: string;
  status: number;
  latency: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Raw traffic entry for all intercepted requests
 */
export interface RawTrafficEntry {
  timestamp: string;
  method: string;
  host: string;
  path: string;
  userAgent: string;
  origin?: string;
  contentType?: string;
  contentLength?: number;
  detectedApp: string;
  confidence: number;
}

/**
 * Log filter options
 */
export interface LogFilter {
  limit?: number;
  offset?: number;
  filter?: string;
  since?: string;
}

/**
 * Log response
 */
export interface LogResponse {
  logs: LogEntry[];
  total: number;
  hasMore: boolean;
  nextOffset?: number;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: "ok" | "error";
  version: string;
  uptime: number;
}

/**
 * User-Agent detection result
 */
export interface UserAgentDetection {
  name: string;
  confidence: number;
  version?: string;
  platform?: string;
}

/**
 * Generic API response
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Process information from ps command
 */
export interface ProcessInfo {
  pid: number;
  command: string;
  startTime: string;
}

/**
 * PID file data structure
 */
export interface PidFileData {
  pid: number;
  port?: number;
  startTime: string;
  nodeVersion?: string;
  bunVersion?: string;
}
