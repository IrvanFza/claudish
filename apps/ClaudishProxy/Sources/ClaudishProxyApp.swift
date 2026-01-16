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
    @StateObject private var profileManager = ProfileManager()

    var body: some Scene {
        // Menu bar extra (status bar icon)
        MenuBarExtra {
            MenuBarContent(bridgeManager: bridgeManager, profileManager: profileManager)
                .onAppear {
                    // Connect profile manager to bridge manager
                    profileManager.setBridgeManager(bridgeManager)
                    // Apply profile when bridge connects
                    if bridgeManager.bridgeConnected {
                        profileManager.applySelectedProfile()
                    }
                }
        } label: {
            // Status bar icon
            if bridgeManager.isProxyEnabled {
                Image(systemName: "arrow.left.arrow.right.circle.fill")
            } else {
                Image(systemName: "arrow.left.arrow.right.circle")
            }
        }
        .menuBarExtraStyle(.window)

        // Settings window (using Window instead of Settings for menu bar apps)
        Window("Claudish Proxy Settings", id: "settings") {
            SettingsView(bridgeManager: bridgeManager, profileManager: profileManager)
        }
        .defaultSize(width: 550, height: 450)
        .windowResizability(.contentSize)

        // Logs window
        Window("Request Logs", id: "logs") {
            LogsView(bridgeManager: bridgeManager)
        }
        .defaultSize(width: 800, height: 600)
    }
}

/// Menu bar dropdown content using StatsPanel implementation
struct MenuBarContent: View {
    @ObservedObject var bridgeManager: BridgeManager
    @ObservedObject var profileManager: ProfileManager
    @Environment(\.openWindow) private var openWindow
    @State private var showErrorAlert = false
    @State private var showCleanupAlert = false
    @State private var timeRange = "30 Days"

    // Calculate usage percentage from bridge manager data
    private var usagePercentage: Double {
        min(Double(bridgeManager.totalRequests) / 1000.0, 1.0)
    }

    // Recent activity from bridge manager logs (mock data for now)
    private var recentActivity: [Activity] {
        [
            Activity(date: "Jan 15, 2026", model: "claude-3-opus", credits: "14,500", cost: "$0.22"),
            Activity(date: "Jan 14, 2026", model: "claude-3-sonnet", credits: "8,200", cost: "$0.03"),
            Activity(date: "Jan 14, 2026", model: "gpt-4", credits: "2,100", cost: "$0.06"),
            Activity(date: "Jan 13, 2026", model: "claude-3-haiku", credits: "45,000", cost: "$0.01")
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with time range and proxy toggle
            HStack {
                Text("CREDITS USED")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(1.0)
                    .foregroundColor(.themeTextMuted)

                Spacer()

                DropdownSelector(
                    selection: $timeRange,
                    options: ["7 Days", "30 Days", "90 Days", "All Time"]
                )

                // Proxy toggle
                Toggle("", isOn: $bridgeManager.isProxyEnabled)
                    .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                    .labelsHidden()
                    .disabled(!bridgeManager.bridgeConnected)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            // Big percentage display
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(String(format: "%.1f%%", usagePercentage * 100))
                    .font(.system(size: 48, weight: .bold))
                    .foregroundColor(.themeText)
                    .monospacedDigit()

                Text("\(bridgeManager.totalRequests.formatted()) / 1,000")
                    .font(.system(size: 14))
                    .foregroundColor(.themeTextMuted)
            }
            .padding(.horizontal, 20)

            // Progress bar
            SegmentedProgressBar(progress: usagePercentage)
                .frame(height: 8)
                .padding(.horizontal, 20)
                .padding(.top, 12)

            // Connection status row
            HStack {
                Text("\(bridgeManager.totalRequests)")
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundColor(.themeAccent)
                + Text(" REQUESTS")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.themeTextSubtle)

                Spacer()

                if bridgeManager.bridgeConnected {
                    Circle()
                        .fill(Color.themeSuccess)
                        .frame(width: 6, height: 6)
                    Text("CONNECTED")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundColor(.themeSuccess)
                } else {
                    Circle()
                        .fill(Color.themeDestructive)
                        .frame(width: 6, height: 6)
                    Text("DISCONNECTED")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundColor(.themeDestructive)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 16)

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Recent activity table (from StatsPanel)
            VStack(alignment: .leading, spacing: 12) {
                Text("RECENT ACTIVITY")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(1.0)
                    .foregroundColor(.themeTextMuted)

                // Table header
                HStack(spacing: 12) {
                    Text("DATE")
                        .frame(width: 70, alignment: .leading)
                    Text("MODEL")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("CREDITS")
                        .frame(width: 60, alignment: .trailing)
                    Text("COST")
                        .frame(width: 50, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.themeTextMuted)

                // Table rows
                ForEach(recentActivity) { activity in
                    HStack(spacing: 12) {
                        Text(activity.date)
                            .font(.system(size: 11))
                            .foregroundColor(.themeTextMuted)
                            .frame(width: 70, alignment: .leading)

                        Text(activity.model)
                            .font(.system(size: 11))
                            .foregroundColor(.themeText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(1)

                        Text(activity.credits)
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundColor(.themeText)
                            .frame(width: 60, alignment: .trailing)

                        Text(activity.cost)
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundColor(.themeText)
                            .frame(width: 50, alignment: .trailing)
                    }
                    .padding(.vertical, 4)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Unified Model/Profile Picker
            UnifiedModelPicker(profileManager: profileManager, bridgeManager: bridgeManager)

            // Error message banner (if any)
            if let errorMessage = bridgeManager.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.themeAccent)
                    Text(errorMessage)
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextMuted)
                        .lineLimit(2)
                }
                .padding(12)
                .background(Color.themeAccent.opacity(0.1))
                .cornerRadius(6)
                .padding(.horizontal, 20)
                .onTapGesture {
                    showErrorAlert = true
                }
            }

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Footer with actions (matches StatsPanel footer style)
            HStack {
                HStack(spacing: 12) {
                    Button(action: {
                        NSApp.setActivationPolicy(.regular)
                        openWindow(id: "settings")
                        NSApp.activate(ignoringOtherApps: true)
                    }) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(PlainButtonStyle())
                    .keyboardShortcut(",", modifiers: .command)

                    Button(action: {
                        NSApp.setActivationPolicy(.regular)
                        openWindow(id: "logs")
                        NSApp.activate(ignoringOtherApps: true)
                    }) {
                        Image(systemName: "list.bullet.rectangle")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                .foregroundColor(.themeTextMuted)

                Spacer()

                PillButton(title: "Quit") {
                    Task {
                        let cleanupSuccess = await bridgeManager.shutdown()
                        if !cleanupSuccess {
                            await MainActor.run {
                                showCleanupAlert = true
                            }
                            try? await Task.sleep(nanoseconds: 500_000_000)
                        }
                        NSApplication.shared.terminate(nil)
                    }
                }
                .keyboardShortcut("q", modifiers: .command)
            }
            .padding(20)
        }
        .background(Color.themeCard)
        .cornerRadius(12)
        .frame(width: 380)
        .alert("Error", isPresented: $showErrorAlert) {
            Button("OK") {
                bridgeManager.errorMessage = nil
            }
        } message: {
            Text(bridgeManager.errorMessage ?? "Unknown error")
        }
        .alert("Proxy Cleanup Failed", isPresented: $showCleanupAlert) {
            Button("Open Network Settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.network") {
                    NSWorkspace.shared.open(url)
                }
            }
            Button("Quit Anyway", role: .destructive) {}
        } message: {
            Text("Failed to disable system proxy. Your internet may not work until you manually disable the proxy in System Settings > Network.")
        }
    }
}
