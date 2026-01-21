import Foundation
import Combine

/// Manages spawning and lifecycle of proxied Claude Desktop instances
///
/// Instead of system-wide proxy configuration, we spawn Claude Desktop
/// with the --proxy-server flag to route traffic through our local proxy.
@MainActor
class ProcessManager: ObservableObject {
    // MARK: - Published State

    /// Whether a proxied Claude Desktop instance is currently running
    @Published var isClaudeRunning = false

    /// PID of the running Claude Desktop process
    @Published var claudePID: Int32?

    /// Error message from last operation
    @Published var errorMessage: String?

    /// Whether we're in the process of launching
    @Published var isLaunching = false

    // MARK: - Private State

    /// Reference to the Claude Desktop process
    private var claudeProcess: Process?

    /// Path to Claude Desktop executable
    private let claudeDesktopPath = "/Applications/Claude.app/Contents/MacOS/Claude"

    /// Reference to BridgeManager for proxy port
    private weak var bridgeManager: BridgeManager?

    // MARK: - Initialization

    func setBridgeManager(_ manager: BridgeManager) {
        self.bridgeManager = manager
    }

    // MARK: - Public API

    /// Launch a proxied Claude Desktop instance
    ///
    /// - Parameters:
    ///   - skipCertValidation: If true, adds --ignore-certificate-errors flag
    ///                         (allows self-signed certs without Keychain install)
    func launchProxiedClaude(skipCertValidation: Bool = false) async throws {
        guard !isClaudeRunning else {
            print("[ProcessManager] Claude Desktop already running")
            return
        }

        guard let bridge = bridgeManager else {
            throw ProcessManagerError.bridgeNotConnected
        }

        guard bridge.bridgeConnected else {
            let message = "Bridge is not connected. Please wait for the bridge to start."
            errorMessage = message
            throw ProcessManagerError.bridgeNotConnected
        }

        // Ensure proxy is enabled on the bridge
        if !bridge.isProxyEnabled {
            print("[ProcessManager] Enabling proxy before launching Claude...")
            bridge.isProxyEnabled = true
            // Wait for proxy to start
            try await Task.sleep(nanoseconds: 500_000_000) // 500ms
        }

        // Get proxy port with health check verification
        guard let proxyPort = await getProxyPort() else {
            let message = "Proxy port health check failed. The bridge may not be running correctly."
            errorMessage = message
            throw ProcessManagerError.proxyNotReady
        }

        print("[ProcessManager] Launching Claude Desktop with proxy port: \(proxyPort)")

        isLaunching = true
        defer { isLaunching = false }

        // Build arguments
        var arguments: [String] = [
            "--proxy-server=http://127.0.0.1:\(proxyPort)"
        ]

        // Optional: Skip certificate validation (for development or simplified UX)
        if skipCertValidation {
            arguments.append("--ignore-certificate-errors")
        }

        print("[ProcessManager] Launching Claude Desktop with args: \(arguments)")

        // Create and configure process
        let process = Process()
        process.executableURL = URL(fileURLWithPath: claudeDesktopPath)
        process.arguments = arguments

        // Inherit environment
        process.environment = ProcessInfo.processInfo.environment

        // Set termination handler
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                print("[ProcessManager] Claude Desktop exited with code: \(proc.terminationStatus)")
                self?.handleProcessTermination()
            }
        }

        // Launch
        do {
            try process.run()
            claudeProcess = process
            claudePID = process.processIdentifier
            isClaudeRunning = true
            errorMessage = nil

            print("[ProcessManager] Claude Desktop launched with PID: \(process.processIdentifier)")
        } catch {
            print("[ProcessManager] Failed to launch Claude Desktop: \(error)")
            throw ProcessManagerError.launchFailed(error.localizedDescription)
        }
    }

    /// Stop the proxied Claude Desktop instance
    func killProxiedClaude() {
        guard let process = claudeProcess, isClaudeRunning else {
            print("[ProcessManager] No Claude Desktop process to kill")
            return
        }

        print("[ProcessManager] Terminating Claude Desktop (PID: \(process.processIdentifier))")

        // Try graceful termination first
        process.terminate()

        // Wait briefly for graceful shutdown
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
            if process.isRunning {
                print("[ProcessManager] Force killing Claude Desktop")
                // Use SIGKILL if still running
                kill(process.processIdentifier, SIGKILL)
            }
            Task { @MainActor in
                self?.handleProcessTermination()
            }
        }
    }

    /// Toggle proxied Claude Desktop (for convenience)
    func toggleProxiedClaude(skipCertValidation: Bool = false) async {
        if isClaudeRunning {
            killProxiedClaude()
        } else {
            do {
                try await launchProxiedClaude(skipCertValidation: skipCertValidation)
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    // MARK: - Private Helpers

    /// Get proxy port from bridge with health check verification
    private func getProxyPort() async -> Int? {
        guard let bridge = bridgeManager else {
            print("[ProcessManager] No bridge manager")
            return nil
        }

        // Get port from bridge
        var port: Int?
        if let bridgePort = bridge.proxyPort {
            port = bridgePort
        } else {
            // Wait for proxy to report its port (up to 3 seconds)
            print("[ProcessManager] Waiting for proxy port...")
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                if let bridgePort = bridge.proxyPort {
                    port = bridgePort
                    break
                }
            }
        }

        // If still no port, use default 8899
        if port == nil {
            print("[ProcessManager] No port from bridge, trying default 8899")
            port = 8899
        }

        guard let finalPort = port else {
            print("[ProcessManager] Failed to determine port")
            return nil
        }

        // CRITICAL: Verify port with health check before launching Claude
        print("[ProcessManager] Verifying port \(finalPort) with health check...")
        let healthy = await performHealthCheck(port: finalPort)

        if !healthy {
            print("[ProcessManager] Health check failed for port \(finalPort)")
            errorMessage = "Proxy not responding on port \(finalPort). Cannot launch Claude."
            return nil
        }

        print("[ProcessManager] Health check passed for port \(finalPort)")
        return finalPort
    }

    /// Perform health check on proxy port
    private func performHealthCheck(port: Int, timeout: TimeInterval = 3.0) async -> Bool {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!

        var request = URLRequest(url: url)
        request.timeoutInterval = timeout

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                return false
            }

            // Parse health response
            struct HealthResponse: Codable {
                let status: String
            }

            if let json = try? JSONDecoder().decode(HealthResponse.self, from: data),
               json.status == "ok" {
                return true
            }

            return false
        } catch {
            print("[ProcessManager] Health check error: \(error)")
            return false
        }
    }

    /// Handle process termination
    private func handleProcessTermination() {
        claudeProcess = nil
        claudePID = nil
        isClaudeRunning = false
        print("[ProcessManager] Process cleanup complete")
    }

    /// Clean up when app is quitting
    func shutdown() {
        if isClaudeRunning {
            print("[ProcessManager] App shutting down, killing Claude Desktop")
            killProxiedClaude()
        }
    }
}

// MARK: - Errors

enum ProcessManagerError: LocalizedError {
    case bridgeNotConnected
    case proxyNotReady
    case launchFailed(String)
    case claudeDesktopNotFound

    var errorDescription: String? {
        switch self {
        case .bridgeNotConnected:
            return "Bridge is not connected. Please wait for the bridge to start."
        case .proxyNotReady:
            return "Proxy server is not ready. Please try again."
        case .launchFailed(let reason):
            return "Failed to launch Claude Desktop: \(reason)"
        case .claudeDesktopNotFound:
            return "Claude Desktop not found at /Applications/Claude.app"
        }
    }
}
