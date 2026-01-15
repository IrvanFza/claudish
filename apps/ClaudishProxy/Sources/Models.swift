import Foundation

// MARK: - API Response Types

/// Health check response from bridge
struct HealthResponse: Codable {
    let status: String
    let version: String
    let uptime: Double
}

/// Proxy status response
struct ProxyStatus: Codable {
    let running: Bool
    let port: Int?
    let detectedApps: [DetectedApp]
    let totalRequests: Int
    let activeConnections: Int
    let uptime: Double
    let version: String
}

/// Detected application info
struct DetectedApp: Codable, Identifiable {
    let name: String
    let confidence: Double
    let userAgent: String
    let lastSeen: String
    let requestCount: Int

    var id: String { name }
}

/// Log entry
struct LogEntry: Codable, Identifiable {
    let timestamp: String
    let app: String
    let confidence: Double
    let requestedModel: String
    let targetModel: String
    let status: Int
    let latency: Int
    let inputTokens: Int
    let outputTokens: Int
    let cost: Double

    var id: String { timestamp }
}

/// Log response
struct LogResponse: Codable {
    let logs: [LogEntry]
    let total: Int
    let hasMore: Bool
    let nextOffset: Int?
}

/// Generic API response
struct ApiResponse: Codable {
    let success: Bool
    let error: String?
}

// MARK: - Configuration Types

/// Bridge configuration
struct BridgeConfig: Codable {
    var defaultModel: String?
    var apps: [String: AppModelMapping]
    var enabled: Bool
}

/// Per-app model mapping
struct AppModelMapping: Codable {
    var modelMap: [String: String]
    var enabled: Bool
    var notes: String?
}

/// API keys for enabling proxy
struct ApiKeys: Codable {
    var openrouter: String?
    var openai: String?
    var gemini: String?
    var anthropic: String?
    var minimax: String?
    var kimi: String?
    var glm: String?
}

/// Options for starting the bridge proxy
struct BridgeStartOptions: Codable {
    let apiKeys: ApiKeys
    var port: Int?
}

// MARK: - Model Constants

/// Known Claude model names for mapping
enum ClaudeModel: String, CaseIterable {
    case opus = "claude-3-opus-20240229"
    case sonnet = "claude-3-sonnet-20240229"
    case haiku = "claude-3-haiku-20240307"
    case opus4 = "claude-sonnet-4-20250514"  // Claude 4 naming

    var displayName: String {
        switch self {
        case .opus: return "Claude 3 Opus"
        case .sonnet: return "Claude 3 Sonnet"
        case .haiku: return "Claude 3 Haiku"
        case .opus4: return "Claude 4 Sonnet"
        }
    }
}

/// Common target models for mapping
enum TargetModel: String, CaseIterable, Identifiable {
    // OpenRouter models
    case gpt4o = "openai/gpt-4o"
    case gpt4oMini = "openai/gpt-4o-mini"
    case geminiPro = "google/gemini-pro-1.5"

    // Direct API models
    case geminiFlash = "g/gemini-2.0-flash-exp"
    case openaiGpt5 = "oai/gpt-5.2"
    case minimaxM2 = "mm/minimax-m2.1"
    case kimiK2 = "kimi/kimi-k2-0711-preview"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .gpt4o: return "GPT-4o"
        case .gpt4oMini: return "GPT-4o Mini"
        case .geminiPro: return "Gemini Pro 1.5"
        case .geminiFlash: return "Gemini 2.0 Flash"
        case .openaiGpt5: return "GPT-5.2"
        case .minimaxM2: return "MiniMax M2.1"
        case .kimiK2: return "Kimi K2"
        }
    }
}
