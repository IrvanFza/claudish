import Foundation
import Combine

/// Manages the claudish-bridge Node.js process and HTTP communication
///
/// Responsibilities:
/// - Start/stop the bridge process
/// - Parse stdout for port and token
/// - HTTP API communication with authentication
/// - Proxy state management (per-instance via --proxy-server flag)
@MainActor
class BridgeManager: ObservableObject {
    // MARK: - Published State

    @Published var bridgeConnected = false
    @Published var isAttemptingRecovery = false
    @Published var isProxyEnabled = false {
        didSet {
            if oldValue != isProxyEnabled {
                Task {
                    if isProxyEnabled {
                        await enableProxy()
                    } else {
                        await disableProxy()
                    }
                }
            }
        }
    }
    @Published var totalRequests = 0
    @Published var lastDetectedApp: String?
    @Published var lastTargetModel: String?
    @Published var detectedApps: [DetectedApp] = []
    @Published var config: BridgeConfig?
    @Published var errorMessage: String?
    @Published var debugState: DebugState?

    /// Current HTTPS proxy port (set when proxy is enabled)
    @Published private(set) var proxyPort: Int?

    // Statistics manager
    let statsManager: StatsManager

    // MARK: - Private State

    private var bridgeProcess: Process?
    private var bridgePort: Int?
    private var bridgeToken: String?
    private var statusTimer: Timer?

    // Path to claudish-bridge executable
    // TODO: Bundle this with the app or locate via npm
    private let bridgePath: String

    // API key manager for secure key storage
    private let apiKeyManager: ApiKeyManager

    // Auto-recovery state
    private var recoveryAttempts = 0
    private let maxRecoveryAttempts = 3
    private var isRecovering = false
    private var isShuttingDown = false

    // MARK: - Initialization

    init(apiKeyManager: ApiKeyManager) {
        self.apiKeyManager = apiKeyManager
        self.statsManager = StatsManager()

        // Try to find claudish-bridge in common locations
        let possiblePaths = [
            "/usr/local/bin/claudish-bridge",
            "/opt/homebrew/bin/claudish-bridge",
            Bundle.main.bundlePath + "/Contents/Resources/claudish-bridge",
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("mag/claudish/packages/macos-bridge/dist/index.js").path
        ]

        self.bridgePath = possiblePaths.first { FileManager.default.fileExists(atPath: $0) }
            ?? possiblePaths.last!

        Task { [weak self] in
            guard let self = self else { return }

            await self.startBridge()

            // Poll bridge connection state with timeout (max 3 seconds)
            var attempts = 0
            while !self.bridgeConnected && attempts < 30 {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                attempts += 1
            }

            await self.checkAutoStartPreference()
        }
    }

    /// Check if proxy should be auto-enabled on launch
    private func checkAutoStartPreference() async {
        let enableProxyOnLaunch = UserDefaults.standard.bool(forKey: "enableProxyOnLaunch")
        if enableProxyOnLaunch && bridgeConnected && !isProxyEnabled {
            await MainActor.run {
                isProxyEnabled = true
            }
        }
    }

    // MARK: - Bridge Process Management

    /// Start the Node.js bridge process
    func startBridge() async {
        guard bridgeProcess == nil else {
            print("[BridgeManager] Bridge already running")
            return
        }

        print("[BridgeManager] Starting bridge from: \(bridgePath)")

        let process = Process()

        // Set up environment with common node paths (NVM, Homebrew, etc.)
        // GUI apps don't inherit shell PATH, so we need to include node locations
        var env = ProcessInfo.processInfo.environment
        let homePath = FileManager.default.homeDirectoryForCurrentUser.path
        let additionalPaths = [
            "\(homePath)/.nvm/versions/node/v24.11.0/bin",  // NVM
            "\(homePath)/.nvm/versions/node/v22.0.0/bin",   // NVM fallback
            "\(homePath)/.nvm/versions/node/v20.0.0/bin",   // NVM fallback
            "/opt/homebrew/bin",                             // Homebrew ARM
            "/usr/local/bin",                                // Homebrew Intel
            "/usr/bin"
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = additionalPaths.joined(separator: ":") + ":" + currentPath
        process.environment = env

        // Determine how to run the bridge
        if bridgePath.hasSuffix(".js") {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", bridgePath]
        } else {
            process.executableURL = URL(fileURLWithPath: bridgePath)
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Handle stdout (contains PORT and TOKEN)
        let stdout = stdoutPipe.fileHandleForReading
        stdout.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }

            if let output = String(data: data, encoding: .utf8) {
                Task { @MainActor in
                    self?.parseStdout(output)
                }
            }
        }

        // Handle stderr (for logging)
        let stderr = stderrPipe.fileHandleForReading
        stderr.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }

            if let output = String(data: data, encoding: .utf8) {
                print("[Bridge] \(output)", terminator: "")
            }
        }

        // Handle process termination
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self = self else { return }
                self.bridgeConnected = false
                self.bridgeProcess = nil
                self.bridgePort = nil
                self.bridgeToken = nil
                print("[BridgeManager] Bridge process terminated with code: \(process.terminationStatus)")

                // Attempt auto-recovery if not intentionally shutting down
                if !self.isShuttingDown {
                    await self.attemptRecovery()
                }
            }
        }

        do {
            try process.run()
            bridgeProcess = process
            print("[BridgeManager] Bridge process started with PID: \(process.processIdentifier)")

            // Start status polling once connected
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.startStatusPolling()
            }
        } catch {
            print("[BridgeManager] Failed to start bridge: \(error)")
            await MainActor.run {
                errorMessage = "Failed to start bridge: \(error.localizedDescription)"
            }
        }
    }

    /// Attempt to recover from bridge disconnection
    private func attemptRecovery() async {
        guard !isRecovering else {
            print("[BridgeManager] Recovery already in progress")
            return
        }

        guard recoveryAttempts < maxRecoveryAttempts else {
            print("[BridgeManager] Max recovery attempts (\(maxRecoveryAttempts)) reached, giving up")
            isAttemptingRecovery = false
            errorMessage = "Bridge disconnected. Please restart the app."
            return
        }

        isRecovering = true
        isAttemptingRecovery = true
        recoveryAttempts += 1

        // Exponential backoff: 1s, 2s, 4s
        let delay = pow(2.0, Double(recoveryAttempts - 1))
        print("[BridgeManager] Attempting recovery in \(delay)s (attempt \(recoveryAttempts)/\(maxRecoveryAttempts))")

        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))

        // Check if shutdown was requested during the delay
        guard !isShuttingDown else {
            print("[BridgeManager] Shutdown requested, aborting recovery")
            isRecovering = false
            isAttemptingRecovery = false
            return
        }

        print("[BridgeManager] Starting recovery attempt \(recoveryAttempts)")
        await startBridge()

        // Wait for connection with timeout
        var attempts = 0
        while !bridgeConnected && attempts < 30 && !isShuttingDown {
            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            attempts += 1
        }

        if bridgeConnected {
            print("[BridgeManager] Recovery successful!")
            isRecovering = false
            isAttemptingRecovery = false
            // Re-enable proxy if it was enabled before
            await checkAutoStartPreference()
        } else if !isShuttingDown {
            print("[BridgeManager] Recovery attempt \(recoveryAttempts) failed")
            isRecovering = false
            // Will retry on next termination or try again now
            if recoveryAttempts < maxRecoveryAttempts {
                await attemptRecovery()
            } else {
                isAttemptingRecovery = false
            }
        }
    }

    /// Parse stdout for port and token
    private func parseStdout(_ output: String) {
        let lines = output.split(separator: "\n")

        for line in lines {
            if line.hasPrefix("CLAUDISH_BRIDGE_PORT=") {
                let portStr = String(line.dropFirst("CLAUDISH_BRIDGE_PORT=".count))
                if let port = Int(portStr) {
                    Task { @MainActor in
                        self.bridgePort = port
                        print("[BridgeManager] Bridge port: \(port)")
                        self.checkConnection()
                    }
                }
            } else if line.hasPrefix("CLAUDISH_BRIDGE_TOKEN=") {
                let token = String(line.dropFirst("CLAUDISH_BRIDGE_TOKEN=".count))
                Task { @MainActor in
                    self.bridgeToken = token
                    print("[BridgeManager] Bridge token received")
                    self.checkConnection()
                }
            }
        }
    }

    /// Check if we have both port and token, then verify connection
    private func checkConnection() {
        guard bridgePort != nil, bridgeToken != nil else { return }

        Task {
            let connected = await verifyConnection()
            await MainActor.run {
                bridgeConnected = connected
                if !connected {
                    errorMessage = "Failed to connect to bridge. Check that the bridge process is running."
                } else {
                    errorMessage = nil
                    // Reset recovery state on successful connection
                    recoveryAttempts = 0
                    isRecovering = false
                }
            }

            if connected {
                await fetchConfig()
            }
        }
    }

    /// Verify connection to bridge
    private func verifyConnection() async -> Bool {
        guard let port = bridgePort else { return false }

        let url = URL(string: "http://127.0.0.1:\(port)/health")!

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                return false
            }

            // Parse health response
            if let json = try? JSONDecoder().decode(HealthResponse.self, from: data) {
                return json.status == "ok"
            }
            return false
        } catch {
            print("[BridgeManager] Health check failed: \(error)")
            return false
        }
    }

    /// Stop the bridge process
    func shutdown() async {
        // Prevent auto-recovery during intentional shutdown
        isShuttingDown = true

        stopStatusPolling()

        if isProxyEnabled {
            await disableProxy()
        }

        bridgeProcess?.terminate()
        bridgeProcess = nil
        bridgePort = nil
        bridgeToken = nil
        proxyPort = nil
        bridgeConnected = false
    }

    // MARK: - HTTP API

    /// Make authenticated API request (public for use by views)
    func apiRequest<T: Decodable>(
        method: String,
        path: String,
        body: Data? = nil
    ) async throws -> T {
        guard let port = bridgePort, let token = bridgeToken else {
            throw BridgeError.notConnected
        }

        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw BridgeError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            throw BridgeError.unauthorized
        }

        guard httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 else {
            throw BridgeError.apiError(status: httpResponse.statusCode)
        }

        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Fetch current configuration
    func fetchConfig() async {
        do {
            let config: BridgeConfig = try await apiRequest(method: "GET", path: "/config")
            await MainActor.run {
                self.config = config
            }
        } catch {
            print("[BridgeManager] Failed to fetch config: \(error)")
        }
    }

    /// Fetch debug state (routing config, proxy state)
    func fetchDebugState() async {
        do {
            let state: DebugState = try await apiRequest(method: "GET", path: "/debug/state")
            await MainActor.run {
                self.debugState = state
            }
        } catch {
            print("[BridgeManager] Failed to fetch debug state: \(error)")
        }
    }

    /// Fetch current status
    func fetchStatus() async {
        do {
            let status: ProxyStatus = try await apiRequest(method: "GET", path: "/status")
            await MainActor.run {
                self.totalRequests = status.totalRequests
                self.detectedApps = status.detectedApps
                self.lastDetectedApp = status.detectedApps.first?.name
                // Sync proxy state
                if self.isProxyEnabled != status.running {
                    self.isProxyEnabled = status.running
                }
                // Update proxy port from status
                if let port = status.proxyPort {
                    self.proxyPort = port
                }
            }

            // Fetch last log entry to get last target model
            await fetchLastTargetModel()
        } catch {
            print("[BridgeManager] Failed to fetch status: \(error)")
        }
    }

    /// Fetch the last target model from logs and update stats
    private func fetchLastTargetModel() async {
        do {
            let logResponse: LogResponse = try await apiRequest(method: "GET", path: "/logs?limit=1")
            await MainActor.run {
                if let lastLog = logResponse.logs.first {
                    self.lastTargetModel = lastLog.targetModel

                    // Record this request in stats if it's new
                    // Check if we already have this request by comparing timestamp
                    let exists = self.statsManager.recentRequests.contains { stat in
                        abs(stat.timestamp.timeIntervalSince(self.parseTimestamp(lastLog.timestamp))) < 1.0
                    }

                    if !exists {
                        self.statsManager.recordFromLogEntry(lastLog)
                    }
                }
            }
        } catch {
            print("[BridgeManager] Failed to fetch last target model: \(error)")
        }
    }

    /// Helper to parse ISO8601 timestamp
    private func parseTimestamp(_ timestamp: String) -> Date {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: timestamp) ?? Date()
    }

    /// Enable the proxy
    private func enableProxy() async {
        // Get API keys from ApiKeyManager (respects mode and fallback logic)
        let apiKeys = ApiKeys(
            openrouter: apiKeyManager.getApiKey(for: .openrouter),
            openai: apiKeyManager.getApiKey(for: .openai),
            gemini: apiKeyManager.getApiKey(for: .gemini),
            anthropic: apiKeyManager.getApiKey(for: .anthropic),
            minimax: apiKeyManager.getApiKey(for: .minimax),
            kimi: apiKeyManager.getApiKey(for: .kimi),
            glm: apiKeyManager.getApiKey(for: .glm)
        )

        let options = BridgeStartOptions(apiKeys: apiKeys)

        do {
            let encoder = JSONEncoder()
            let body = try encoder.encode(options)

            let response: ProxyEnableResponse = try await apiRequest(
                method: "POST",
                path: "/proxy/enable",
                body: body
            )
            print("[BridgeManager] Proxy enabled on port \(response.proxyPort ?? 0)")

            await MainActor.run {
                self.proxyPort = response.proxyPort
            }
        } catch {
            print("[BridgeManager] Failed to enable proxy: \(error)")
            await MainActor.run {
                self.isProxyEnabled = false
                self.errorMessage = "Failed to enable proxy: \(error.localizedDescription)"
            }
        }
    }

    /// Disable the proxy
    private func disableProxy() async {
        do {
            let _: ApiResponse = try await apiRequest(
                method: "POST",
                path: "/proxy/disable"
            )
            await MainActor.run {
                self.proxyPort = nil
            }
            print("[BridgeManager] Proxy disabled")
        } catch {
            print("[BridgeManager] Failed to disable proxy: \(error)")
        }
    }

    /// Update configuration
    func updateConfig(_ config: BridgeConfig) async {
        do {
            let encoder = JSONEncoder()
            let body = try encoder.encode(config)

            let response: ApiResponse = try await apiRequest(
                method: "POST",
                path: "/config",
                body: body
            )

            if response.success {
                await fetchConfig()
            }
        } catch {
            print("[BridgeManager] Failed to update config: \(error)")
        }
    }

    /// Set debug mode (enable/disable traffic logging to file)
    /// Returns the current log file path when enabled, nil otherwise
    @discardableResult
    func setDebugMode(_ enabled: Bool) async -> String? {
        do {
            let body = try JSONEncoder().encode(["enabled": enabled])
            let response: DebugResponse = try await apiRequest(
                method: "POST",
                path: "/debug",
                body: body
            )
            print("[BridgeManager] Debug mode \(enabled ? "enabled" : "disabled")")
            return response.data?.logPath
        } catch {
            print("[BridgeManager] Failed to set debug mode: \(error)")
            return nil
        }
    }

    // MARK: - Status Polling

    private func startStatusPolling() {
        guard statusTimer == nil else { return }

        statusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task {
                await self?.fetchStatus()
                await self?.fetchDebugState()
            }
        }
    }

    private func stopStatusPolling() {
        statusTimer?.invalidate()
        statusTimer = nil
    }
}

// MARK: - Errors

enum BridgeError: Error, LocalizedError {
    case notConnected
    case unauthorized
    case invalidResponse
    case apiError(status: Int)

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Bridge not connected"
        case .unauthorized:
            return "Authentication failed"
        case .invalidResponse:
            return "Invalid response from bridge"
        case .apiError(let status):
            return "API error: \(status)"
        }
    }
}
