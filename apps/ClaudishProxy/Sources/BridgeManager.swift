import Foundation
import Combine

/// Manages the claudish-bridge Node.js process and HTTP communication
///
/// Responsibilities:
/// - Start/stop the bridge process
/// - Parse stdout for port and token
/// - HTTP API communication with authentication
/// - Proxy state management
@MainActor
class BridgeManager: ObservableObject {
    // MARK: - Published State

    @Published var bridgeConnected = false
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

    // MARK: - Private State

    private var bridgeProcess: Process?
    private var bridgePort: Int?
    private var bridgeToken: String?
    private var statusTimer: Timer?

    // Path to claudish-bridge executable
    // TODO: Bundle this with the app or locate via npm
    private let bridgePath: String

    // MARK: - Initialization

    init() {
        // Try to find claudish-bridge in common locations
        let possiblePaths = [
            "/usr/local/bin/claudish-bridge",
            "/opt/homebrew/bin/claudish-bridge",
            Bundle.main.bundlePath + "/Contents/Resources/claudish-bridge",
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("mag/claudish/packages/macos-bridge/dist/index.js").path
        ]

        bridgePath = possiblePaths.first { FileManager.default.fileExists(atPath: $0) }
            ?? possiblePaths.last!

        Task {
            await startBridge()

            // Poll bridge connection state with timeout (max 3 seconds)
            var attempts = 0
            while !bridgeConnected && attempts < 30 {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                attempts += 1
            }

            await checkAutoStartPreference()
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
                self?.bridgeConnected = false
                self?.bridgeProcess = nil
                self?.bridgePort = nil
                self?.bridgeToken = nil
                print("[BridgeManager] Bridge process terminated with code: \(process.terminationStatus)")
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
    /// Returns true if cleanup was successful, false if manual intervention is needed
    @discardableResult
    func shutdown() async -> Bool {
        stopStatusPolling()

        if isProxyEnabled {
            await disableProxy()
        }

        // Always clean up system proxy on shutdown, even if proxy wasn't "officially" enabled
        let cleanupSuccess = await unconfigureSystemProxy()

        bridgeProcess?.terminate()
        bridgeProcess = nil
        bridgePort = nil
        bridgeToken = nil
        bridgeConnected = false

        return cleanupSuccess
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
            }

            // Fetch last log entry to get last target model
            await fetchLastTargetModel()
        } catch {
            print("[BridgeManager] Failed to fetch status: \(error)")
        }
    }

    /// Fetch the last target model from logs
    private func fetchLastTargetModel() async {
        do {
            let logResponse: LogResponse = try await apiRequest(method: "GET", path: "/logs?limit=1")
            await MainActor.run {
                if let lastLog = logResponse.logs.first {
                    self.lastTargetModel = lastLog.targetModel
                }
            }
        } catch {
            print("[BridgeManager] Failed to fetch last target model: \(error)")
        }
    }

    /// Enable the proxy
    private func enableProxy() async {
        // Get API keys from environment/keychain
        let apiKeys = ApiKeys(
            openrouter: ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"],
            openai: ProcessInfo.processInfo.environment["OPENAI_API_KEY"],
            gemini: ProcessInfo.processInfo.environment["GEMINI_API_KEY"],
            minimax: ProcessInfo.processInfo.environment["MINIMAX_API_KEY"],
            kimi: ProcessInfo.processInfo.environment["MOONSHOT_API_KEY"],
            glm: ProcessInfo.processInfo.environment["ZHIPU_API_KEY"]
        )

        let options = BridgeStartOptions(apiKeys: apiKeys)

        do {
            let encoder = JSONEncoder()
            let body = try encoder.encode(options)

            let _: ApiResponse = try await apiRequest(
                method: "POST",
                path: "/proxy/enable",
                body: body
            )
            print("[BridgeManager] Proxy enabled")

            // Configure system proxy to route traffic through our proxy
            await configureSystemProxy()
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
        // Remove system proxy configuration first
        await unconfigureSystemProxy()

        do {
            let _: ApiResponse = try await apiRequest(
                method: "POST",
                path: "/proxy/disable"
            )
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

    // MARK: - Status Polling

    private func startStatusPolling() {
        guard statusTimer == nil else { return }

        statusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task {
                await self?.fetchStatus()
            }
        }
    }

    private func stopStatusPolling() {
        statusTimer?.invalidate()
        statusTimer = nil
    }

    // MARK: - System Proxy Configuration

    /// Get the active network service (Wi-Fi, Ethernet, etc.)
    private func getActiveNetworkService() async -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
        process.arguments = ["-listnetworkserviceorder"]

        let pipe = Pipe()
        process.standardOutput = pipe

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8) else { return nil }

            // Parse the output to find the first active service
            // Format: (1) Ethernet\n(Hardware Port: Ethernet, Device: en0)
            let lines = output.components(separatedBy: "\n")
            for i in 0..<lines.count {
                let line = lines[i].trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("(") && line.contains(")") {
                    // Extract service name between () and newline
                    if let startIndex = line.firstIndex(of: ")"),
                       startIndex < line.endIndex {
                        let serviceName = String(line[line.index(after: startIndex)...])
                            .trimmingCharacters(in: .whitespaces)
                        if !serviceName.isEmpty && serviceName != "*" {
                            return serviceName
                        }
                    }
                }
            }
        } catch {
            print("[BridgeManager] Failed to get network services: \(error)")
        }

        return nil
    }

    /// Configure system proxy to use our PAC file
    private func configureSystemProxy() async {
        guard let port = bridgePort else {
            print("[BridgeManager] Cannot configure proxy: no bridge port")
            return
        }

        guard let networkService = await getActiveNetworkService() else {
            print("[BridgeManager] Cannot configure proxy: no active network service")
            await MainActor.run {
                errorMessage = "Cannot configure system proxy: no active network service found"
            }
            return
        }

        // Validate network service name to prevent command injection
        guard networkService.range(of: "^[a-zA-Z0-9 -]+$", options: .regularExpression) != nil else {
            print("[BridgeManager] Invalid network service name: \(networkService)")
            await MainActor.run {
                errorMessage = "Invalid network service name detected"
            }
            return
        }

        let pacURL = "http://127.0.0.1:\(port)/proxy.pac"
        print("[BridgeManager] Configuring system proxy for \(networkService) with PAC: \(pacURL)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
        process.arguments = ["-setautoproxyurl", networkService, pacURL]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            if process.terminationStatus == 0 {
                print("[BridgeManager] System proxy configured successfully")
            } else {
                print("[BridgeManager] Failed to configure system proxy: \(output)")
                await MainActor.run {
                    errorMessage = "Failed to configure system proxy. May need admin privileges."
                }
            }
        } catch {
            print("[BridgeManager] Error configuring system proxy: \(error)")
            await MainActor.run {
                errorMessage = "Error configuring system proxy: \(error.localizedDescription)"
            }
        }
    }

    /// Remove system proxy configuration
    /// Returns true if cleanup was successful, false if manual intervention is needed
    @discardableResult
    private func unconfigureSystemProxy() async -> Bool {
        guard let networkService = await getActiveNetworkService() else {
            print("[BridgeManager] Cannot unconfigure proxy: no active network service")
            return false
        }

        // Validate network service name to prevent command injection
        guard networkService.range(of: "^[a-zA-Z0-9 -]+$", options: .regularExpression) != nil else {
            print("[BridgeManager] Invalid network service name: \(networkService)")
            await MainActor.run {
                errorMessage = "Invalid network service name detected during cleanup"
            }
            return false
        }

        print("[BridgeManager] Disabling system proxy for \(networkService)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
        process.arguments = ["-setautoproxystate", networkService, "off"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            if process.terminationStatus == 0 {
                print("[BridgeManager] System proxy disabled successfully")
                return true
            } else {
                print("[BridgeManager] Failed to disable system proxy: \(output)")
                await MainActor.run {
                    errorMessage = "Failed to disable system proxy. You may need to manually disable it in System Settings > Network."
                }
                return false
            }
        } catch {
            print("[BridgeManager] Error disabling system proxy: \(error)")
            await MainActor.run {
                errorMessage = "Error disabling system proxy: \(error.localizedDescription). Please check System Settings > Network."
            }
            return false
        }
    }
}

// MARK: - Errors

enum BridgeError: Error, LocalizedError {
    case notConnected
    case unauthorized
    case invalidResponse
    case apiError(status: Int)
    case invalidNetworkService

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
        case .invalidNetworkService:
            return "Invalid network service name"
        }
    }
}
