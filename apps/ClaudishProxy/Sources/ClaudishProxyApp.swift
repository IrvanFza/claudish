import SwiftUI

/// Claudish Proxy - macOS Menu Bar Application
///
/// This app lives in the macOS status bar and provides:
/// - Dynamic model switching for AI requests
/// - Per-app model remapping configuration
/// - Request logging and statistics
///
/// Architecture:
/// - Swift/SwiftUI frontend for native macOS experience
/// - Spawns claudish-bridge Node.js process for proxy logic
/// - Communicates via HTTP API with token-based auth

@main
struct ClaudishProxyApp: App {
    @StateObject private var bridgeManager = BridgeManager()
    @State private var showSettings = false

    var body: some Scene {
        // Menu bar extra (status bar icon)
        MenuBarExtra {
            MenuBarContent(
                bridgeManager: bridgeManager,
                showSettings: $showSettings
            )
        } label: {
            // Status bar icon
            if bridgeManager.isProxyEnabled {
                Image(systemName: "arrow.left.arrow.right.circle.fill")
            } else {
                Image(systemName: "arrow.left.arrow.right.circle")
            }
        }
        .menuBarExtraStyle(.menu)

        // Settings window
        Settings {
            SettingsView(bridgeManager: bridgeManager)
        }
    }
}

/// Menu bar dropdown content
struct MenuBarContent: View {
    @ObservedObject var bridgeManager: BridgeManager
    @Binding var showSettings: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status header
            HStack {
                Circle()
                    .fill(bridgeManager.bridgeConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(bridgeManager.bridgeConnected ? "Bridge Connected" : "Bridge Disconnected")
                    .font(.headline)
            }
            .padding(.bottom, 4)

            Divider()

            // Proxy toggle
            Toggle("Enable Proxy", isOn: $bridgeManager.isProxyEnabled)
                .toggleStyle(.switch)
                .disabled(!bridgeManager.bridgeConnected)

            // Stats
            if bridgeManager.isProxyEnabled {
                HStack {
                    Text("Requests:")
                    Spacer()
                    Text("\(bridgeManager.totalRequests)")
                        .monospacedDigit()
                }
                .font(.caption)

                if let lastApp = bridgeManager.lastDetectedApp {
                    HStack {
                        Text("Last App:")
                        Spacer()
                        Text(lastApp)
                            .lineLimit(1)
                    }
                    .font(.caption)
                }
            }

            Divider()

            // Detected Apps
            if !bridgeManager.detectedApps.isEmpty {
                Text("Detected Apps")
                    .font(.caption)
                    .foregroundColor(.secondary)

                ForEach(bridgeManager.detectedApps, id: \.name) { app in
                    HStack {
                        Text(app.name)
                        Spacer()
                        Text("\(app.requestCount) reqs")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .font(.caption)
                }

                Divider()
            }

            // Actions
            Button("Settings...") {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            }
            .keyboardShortcut(",", modifiers: .command)

            Button("View Logs...") {
                // TODO: Open logs window
            }

            Divider()

            Button("Quit Claudish Proxy") {
                Task {
                    await bridgeManager.shutdown()
                    NSApplication.shared.terminate(nil)
                }
            }
            .keyboardShortcut("q", modifiers: .command)
        }
        .padding()
        .frame(width: 250)
    }
}
