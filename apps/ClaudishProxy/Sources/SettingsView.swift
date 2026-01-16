import SwiftUI

/// Settings window for configuring model mappings
struct SettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @ObservedObject var profileManager: ProfileManager
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            // General settings
            GeneralSettingsView(bridgeManager: bridgeManager)
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }
                .tag(0)

            // Model mappings
            ModelMappingsView(bridgeManager: bridgeManager)
                .tabItem {
                    Label("Mappings", systemImage: "arrow.left.arrow.right")
                }
                .tag(1)

            // Profiles tab
            ProfilesSettingsView(profileManager: profileManager)
                .tabItem {
                    Label("Profiles", systemImage: "slider.horizontal.3")
                }
                .tag(2)

            // API Keys
            ApiKeysView()
                .tabItem {
                    Label("API Keys", systemImage: "key")
                }
                .tag(3)

            // About
            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
                .tag(4)
        }
        .frame(width: 600, height: 500)
        .background(Color.themeBg)
    }
}

/// General settings tab
struct GeneralSettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @AppStorage("enableProxyOnLaunch") private var enableProxyOnLaunch = false
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @State private var selectedDefaultModel = TargetModel.gpt4o.rawValue

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Stats Card
                StatsPanel()

                // Proxy Settings Card
                ThemeCard {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("PROXY SETTINGS")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Toggle("Enable proxy on launch", isOn: $enableProxyOnLaunch)
                            .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                            .font(.system(size: 14))
                            .foregroundColor(.themeText)

                        Toggle("Launch at login", isOn: $launchAtLogin)
                            .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                            .font(.system(size: 14))
                            .foregroundColor(.themeTextMuted)
                            .disabled(true)
                    }
                }

                // Default Model Card
                ThemeCard {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("DEFAULT MODEL")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Picker("Target Model", selection: $selectedDefaultModel) {
                            ForEach(TargetModel.allCases) { model in
                                Text(model.displayName).tag(model.rawValue)
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: selectedDefaultModel) { _, newValue in
                            Task {
                                await updateDefaultModel(newValue)
                            }
                        }
                        .onAppear {
                            if let config = bridgeManager.config, let defaultModel = config.defaultModel {
                                selectedDefaultModel = defaultModel
                            }
                        }

                        Text("This model will be used when no app-specific mapping exists.")
                            .font(.system(size: 13))
                            .foregroundColor(.themeTextMuted)
                    }
                }
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }

    private func updateDefaultModel(_ model: String) async {
        guard var config = bridgeManager.config else { return }
        config.defaultModel = model
        await bridgeManager.updateConfig(config)
    }
}

/// Model mappings configuration tab
struct ModelMappingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @State private var selectedApp = "Claude Desktop"
    @State private var newMapping: (source: String, target: String)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // App selector card
                ThemeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("APPLICATION")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Picker("", selection: $selectedApp) {
                            ForEach(bridgeManager.config?.apps.keys.sorted() ?? [], id: \.self) { app in
                                Text(app).tag(app)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                    }
                }

                // Current mappings
                if let config = bridgeManager.config,
                   let appConfig = config.apps[selectedApp] {
                    ThemeCard {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("MODEL MAPPINGS")
                                .font(.system(size: 11, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(1.0)
                                .foregroundColor(.themeTextMuted)

                            if appConfig.modelMap.isEmpty {
                                Text("No mappings configured")
                                    .font(.system(size: 13))
                                    .foregroundColor(.themeTextMuted)
                                    .padding(.vertical, 8)
                            } else {
                                VStack(spacing: 8) {
                                    ForEach(appConfig.modelMap.sorted(by: { $0.key < $1.key }), id: \.key) { source, target in
                                        HStack(spacing: 12) {
                                            Text(source)
                                                .font(.system(size: 13))
                                                .foregroundColor(.themeText)
                                                .lineLimit(1)
                                            Image(systemName: "arrow.right")
                                                .font(.system(size: 10))
                                                .foregroundColor(.themeTextMuted)
                                            Text(target)
                                                .font(.system(size: 13))
                                                .foregroundColor(.themeAccent)
                                                .lineLimit(1)
                                            Spacer()
                                            Button(action: {
                                                Task {
                                                    await removeMapping(source: source)
                                                }
                                            }) {
                                                Image(systemName: "trash")
                                                    .font(.system(size: 13))
                                                    .foregroundColor(.themeDestructive)
                                            }
                                            .buttonStyle(.plain)
                                        }
                                        .padding(.vertical, 8)
                                        .padding(.horizontal, 12)
                                        .background(Color.themeHover)
                                        .cornerRadius(6)
                                    }
                                }
                            }
                        }
                    }

                    // Add new mapping
                    ThemeCard {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("ADD NEW MAPPING")
                                .font(.system(size: 11, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(1.0)
                                .foregroundColor(.themeTextMuted)

                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("From")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(.themeTextMuted)
                                    Picker("", selection: Binding(
                                        get: { newMapping?.source ?? ClaudeModel.opus.rawValue },
                                        set: { newMapping = ($0, newMapping?.target ?? TargetModel.gpt4o.rawValue) }
                                    )) {
                                        ForEach(ClaudeModel.allCases, id: \.rawValue) { model in
                                            Text(model.displayName).tag(model.rawValue)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                }
                                .frame(maxWidth: .infinity)

                                Image(systemName: "arrow.right")
                                    .font(.system(size: 14))
                                    .foregroundColor(.themeTextMuted)
                                    .padding(.top, 16)

                                VStack(alignment: .leading, spacing: 6) {
                                    Text("To")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(.themeTextMuted)
                                    Picker("", selection: Binding(
                                        get: { newMapping?.target ?? TargetModel.gpt4o.rawValue },
                                        set: { newMapping = (newMapping?.source ?? ClaudeModel.opus.rawValue, $0) }
                                    )) {
                                        ForEach(TargetModel.allCases) { model in
                                            Text(model.displayName).tag(model.rawValue)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                }
                                .frame(maxWidth: .infinity)
                            }

                            Button(action: {
                                Task {
                                    await addMapping()
                                }
                            }) {
                                HStack {
                                    Image(systemName: "plus.circle.fill")
                                    Text("Add Mapping")
                                }
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.themeText)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                            }
                            .buttonStyle(.plain)
                            .background(Color.themeAccent)
                            .cornerRadius(6)
                            .disabled(newMapping == nil)
                        }
                    }
                }
            }
            .padding(24)
        }
        .background(Color.themeBg)
        .onAppear {
            newMapping = (ClaudeModel.opus.rawValue, TargetModel.gpt4o.rawValue)
        }
    }

    private func addMapping() async {
        guard let mapping = newMapping,
              var config = bridgeManager.config else { return }

        if config.apps[selectedApp] == nil {
            config.apps[selectedApp] = AppModelMapping(
                modelMap: [:],
                enabled: true,
                notes: nil
            )
        }

        config.apps[selectedApp]?.modelMap[mapping.source] = mapping.target
        await bridgeManager.updateConfig(config)
    }

    private func removeMapping(source: String) async {
        guard var config = bridgeManager.config else { return }
        config.apps[selectedApp]?.modelMap.removeValue(forKey: source)
        await bridgeManager.updateConfig(config)
    }
}

/// API Keys configuration tab
struct ApiKeysView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ThemeCard {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("API KEYS")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Text("API keys are read from environment variables.")
                            .font(.system(size: 13))
                            .foregroundColor(.themeTextMuted)

                        VStack(spacing: 12) {
                            APIKeyRow(
                                keyName: "OPENROUTER_API_KEY",
                                isSet: ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"] != nil
                            )

                            APIKeyRow(
                                keyName: "OPENAI_API_KEY",
                                isSet: ProcessInfo.processInfo.environment["OPENAI_API_KEY"] != nil
                            )

                            APIKeyRow(
                                keyName: "GEMINI_API_KEY",
                                isSet: ProcessInfo.processInfo.environment["GEMINI_API_KEY"] != nil
                            )
                        }
                    }
                }

                ThemeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            Image(systemName: "info.circle.fill")
                                .font(.system(size: 14))
                                .foregroundColor(.themeInfo)
                            Text("HOW TO SET API KEYS")
                                .font(.system(size: 11, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(1.0)
                                .foregroundColor(.themeTextMuted)
                        }

                        Text("To set API keys, add them to your shell profile (~/.zshrc) or use the terminal to export them before launching the app.")
                            .font(.system(size: 13))
                            .foregroundColor(.themeTextMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }
}

struct APIKeyRow: View {
    let keyName: String
    let isSet: Bool

    var body: some View {
        HStack(spacing: 12) {
            Text(keyName)
                .font(.system(.body, design: .monospaced))
                .font(.system(size: 13))
                .foregroundColor(.themeText)
            Spacer()
            if isSet {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.themeSuccess)
                    Text("Set")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.themeSuccess)
                }
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "xmark.circle")
                        .foregroundColor(.themeDestructive)
                    Text("Not Set")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.themeDestructive)
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(Color.themeHover)
        .cornerRadius(6)
    }
}

/// About tab
struct AboutView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Spacer()
                    .frame(height: 20)

                Image(systemName: "arrow.left.arrow.right.circle.fill")
                    .font(.system(size: 72))
                    .foregroundColor(.themeAccent)

                VStack(spacing: 8) {
                    Text("Claudish Proxy")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.themeText)

                    Text("Version 1.0.0")
                        .font(.system(size: 14))
                        .foregroundColor(.themeTextMuted)
                }

                ThemeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("ABOUT")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Text("A macOS menu bar app for dynamic AI model switching. Reroute Claude Desktop requests to any model.")
                            .font(.system(size: 14))
                            .foregroundColor(.themeText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Button(action: {
                    if let url = URL(string: "https://github.com/MadAppGang/claudish") {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    HStack(spacing: 8) {
                        Image(systemName: "link.circle.fill")
                            .font(.system(size: 14))
                        Text("GitHub Repository")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .foregroundColor(.themeText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.plain)
                .background(Color.themeAccent)
                .cornerRadius(8)
                .padding(.horizontal, 24)

                Spacer()
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }
}

/// Logs viewer window
struct LogsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @State private var logs: [LogEntry] = []
    @State private var isLoading = false
    @State private var autoRefresh = true

    var body: some View {
        VStack(spacing: 0) {
            // Header with controls
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Request Logs")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.themeText)
                    Text("\(logs.count) entries")
                        .font(.system(size: 12))
                        .foregroundColor(.themeTextMuted)
                }

                Spacer()

                Toggle("Auto-refresh", isOn: $autoRefresh)
                    .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                    .font(.system(size: 13))
                    .foregroundColor(.themeText)

                Button(action: {
                    Task {
                        await fetchLogs()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                        Text("Refresh")
                            .font(.system(size: 13))
                    }
                    .foregroundColor(.themeText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(Color.themeHover)
                .cornerRadius(6)
                .disabled(isLoading)

                Button(action: {
                    logs = []
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "trash")
                            .font(.system(size: 12))
                        Text("Clear")
                            .font(.system(size: 13))
                    }
                    .foregroundColor(.themeDestructive)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(Color.themeDestructive.opacity(0.1))
                .cornerRadius(6)
            }
            .padding(16)
            .background(Color.themeCard)

            Divider()
                .background(Color.themeBorder)

            // Logs table
            if logs.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "tray")
                        .font(.system(size: 48))
                        .foregroundColor(.themeTextMuted)
                    Text("No logs yet")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.themeText)
                    Text("Logs will appear here when the proxy handles requests")
                        .font(.system(size: 13))
                        .foregroundColor(.themeTextMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.themeBg)
            } else {
                Table(logs) {
                    TableColumn("Time") { log in
                        Text(formatTimestamp(log.timestamp))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeTextMuted)
                    }
                    .width(80)

                    TableColumn("App") { log in
                        HStack(spacing: 4) {
                            Text(log.app)
                                .foregroundColor(.themeText)
                            if log.confidence < 0.8 {
                                Image(systemName: "questionmark.circle")
                                    .foregroundColor(.themeAccent)
                                    .help("Low confidence: \(String(format: "%.0f%%", log.confidence * 100))")
                            }
                        }
                    }
                    .width(120)

                    TableColumn("Requested") { log in
                        Text(log.requestedModel)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeText)
                            .lineLimit(1)
                    }
                    .width(150)

                    TableColumn("Target") { log in
                        Text(log.targetModel)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeAccent)
                            .lineLimit(1)
                    }
                    .width(150)

                    TableColumn("Status") { log in
                        Text("\(log.status)")
                            .foregroundColor(log.status == 200 ? .themeSuccess : .themeDestructive)
                    }
                    .width(60)

                    TableColumn("Latency") { log in
                        Text("\(log.latency)ms")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeText)
                    }
                    .width(70)

                    TableColumn("Tokens") { log in
                        Text("\(log.inputTokens) → \(log.outputTokens)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeText)
                    }
                    .width(100)

                    TableColumn("Cost") { log in
                        Text(String(format: "$%.4f", log.cost))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.themeText)
                    }
                    .width(70)
                }
                .background(Color.themeBg)
            }
        }
        .background(Color.themeBg)
        .frame(minWidth: 800, minHeight: 400)
        .onAppear {
            Task {
                await fetchLogs()
            }
        }
        .task {
            // Auto-refresh every 2 seconds
            while autoRefresh {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if autoRefresh && bridgeManager.bridgeConnected {
                    await fetchLogs()
                }
            }
        }
    }

    private func fetchLogs() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let logResponse: LogResponse = try await bridgeManager.apiRequest(
                method: "GET",
                path: "/logs?limit=100"
            )
            await MainActor.run {
                logs = logResponse.logs
            }
        } catch {
            print("[LogsView] Failed to fetch logs: \(error)")
        }
    }

    private func formatTimestamp(_ timestamp: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        guard let date = formatter.date(from: timestamp) else {
            return timestamp
        }

        let displayFormatter = DateFormatter()
        displayFormatter.dateFormat = "HH:mm:ss"
        return displayFormatter.string(from: date)
    }
}

#Preview {
    SettingsView(bridgeManager: BridgeManager(), profileManager: ProfileManager())
}
