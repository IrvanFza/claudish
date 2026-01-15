import SwiftUI

/// Settings window for configuring model mappings
struct SettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
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

            // API Keys
            ApiKeysView()
                .tabItem {
                    Label("API Keys", systemImage: "key")
                }
                .tag(2)

            // About
            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
                .tag(3)
        }
        .frame(width: 500, height: 400)
        .padding()
    }
}

/// General settings tab
struct GeneralSettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @AppStorage("enableProxyOnLaunch") private var enableProxyOnLaunch = false
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @State private var selectedDefaultModel = TargetModel.gpt4o.rawValue

    var body: some View {
        Form {
            Section("Proxy") {
                Toggle("Enable proxy on launch", isOn: $enableProxyOnLaunch)

                Toggle("Launch at login", isOn: $launchAtLogin)
                    .disabled(true)  // TODO: Implement LaunchAtLogin

                if let config = bridgeManager.config {
                    Toggle("Proxy enabled", isOn: .constant(config.enabled))
                        .disabled(true)
                }
            }

            Section("Default Model") {
                Picker("Target Model:", selection: $selectedDefaultModel) {
                    ForEach(TargetModel.allCases) { model in
                        Text(model.displayName).tag(model.rawValue)
                    }
                }
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
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Section("Bridge") {
                HStack {
                    Text("Status:")
                    Spacer()
                    if bridgeManager.bridgeConnected {
                        Text("Connected")
                            .foregroundColor(.green)
                    } else {
                        Text("Disconnected")
                            .foregroundColor(.red)
                    }
                }

                HStack {
                    Text("Version:")
                    Spacer()
                    Text("1.0.0")
                        .foregroundColor(.secondary)
                }
            }
        }
        .formStyle(.grouped)
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
        VStack(alignment: .leading, spacing: 16) {
            // App selector
            Picker("Application:", selection: $selectedApp) {
                ForEach(bridgeManager.config?.apps.keys.sorted() ?? [], id: \.self) { app in
                    Text(app).tag(app)
                }
            }
            .pickerStyle(.menu)

            // Current mappings
            if let config = bridgeManager.config,
               let appConfig = config.apps[selectedApp] {
                GroupBox("Model Mappings") {
                    if appConfig.modelMap.isEmpty {
                        Text("No mappings configured")
                            .foregroundColor(.secondary)
                            .padding()
                    } else {
                        List {
                            ForEach(appConfig.modelMap.sorted(by: { $0.key < $1.key }), id: \.key) { source, target in
                                HStack {
                                    Text(source)
                                        .lineLimit(1)
                                    Image(systemName: "arrow.right")
                                        .foregroundColor(.secondary)
                                    Text(target)
                                        .lineLimit(1)
                                        .foregroundColor(.blue)
                                    Spacer()
                                    Button(action: {
                                        // Remove mapping
                                        Task {
                                            await removeMapping(source: source)
                                        }
                                    }) {
                                        Image(systemName: "trash")
                                            .foregroundColor(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .frame(height: 150)
                    }
                }

                // Add new mapping
                GroupBox("Add Mapping") {
                    HStack {
                        Picker("From:", selection: Binding(
                            get: { newMapping?.source ?? ClaudeModel.opus.rawValue },
                            set: { newMapping = ($0, newMapping?.target ?? TargetModel.gpt4o.rawValue) }
                        )) {
                            ForEach(ClaudeModel.allCases, id: \.rawValue) { model in
                                Text(model.displayName).tag(model.rawValue)
                            }
                        }
                        .frame(maxWidth: .infinity)

                        Image(systemName: "arrow.right")
                            .foregroundColor(.secondary)

                        Picker("To:", selection: Binding(
                            get: { newMapping?.target ?? TargetModel.gpt4o.rawValue },
                            set: { newMapping = (newMapping?.source ?? ClaudeModel.opus.rawValue, $0) }
                        )) {
                            ForEach(TargetModel.allCases) { model in
                                Text(model.displayName).tag(model.rawValue)
                            }
                        }
                        .frame(maxWidth: .infinity)

                        Button("Add") {
                            Task {
                                await addMapping()
                            }
                        }
                        .disabled(newMapping == nil)
                    }
                }
            }

            Spacer()
        }
        .padding()
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
    @State private var openrouterKey = ""
    @State private var openaiKey = ""
    @State private var geminiKey = ""

    var body: some View {
        Form {
            Section("API Keys") {
                Text("API keys are read from environment variables.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                HStack {
                    Text("OPENROUTER_API_KEY")
                        .font(.system(.body, design: .monospaced))
                    Spacer()
                    if ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"] != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                    } else {
                        Image(systemName: "xmark.circle")
                            .foregroundColor(.red)
                    }
                }

                HStack {
                    Text("OPENAI_API_KEY")
                        .font(.system(.body, design: .monospaced))
                    Spacer()
                    if ProcessInfo.processInfo.environment["OPENAI_API_KEY"] != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                    } else {
                        Image(systemName: "xmark.circle")
                            .foregroundColor(.red)
                    }
                }

                HStack {
                    Text("GEMINI_API_KEY")
                        .font(.system(.body, design: .monospaced))
                    Spacer()
                    if ProcessInfo.processInfo.environment["GEMINI_API_KEY"] != nil {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                    } else {
                        Image(systemName: "xmark.circle")
                            .foregroundColor(.red)
                    }
                }
            }

            Section("Note") {
                Text("To set API keys, add them to your shell profile (~/.zshrc) or use the terminal to export them before launching the app.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

/// About tab
struct AboutView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "arrow.left.arrow.right.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(.accentColor)

            Text("Claudish Proxy")
                .font(.title)
                .fontWeight(.bold)

            Text("Version 1.0.0")
                .foregroundColor(.secondary)

            Text("A macOS menu bar app for dynamic AI model switching.\nReroute Claude Desktop requests to any model.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding()

            Link("GitHub Repository", destination: URL(string: "https://github.com/MadAppGang/claudish")!)

            Spacer()
        }
        .padding()
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
            HStack {
                Text("Request Logs")
                    .font(.title2)
                    .fontWeight(.bold)

                Spacer()

                Toggle("Auto-refresh", isOn: $autoRefresh)
                    .toggleStyle(.switch)

                Button("Refresh") {
                    Task {
                        await fetchLogs()
                    }
                }
                .disabled(isLoading)

                Button("Clear") {
                    logs = []
                }
            }
            .padding()

            Divider()

            // Logs table
            if logs.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "tray")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)
                    Text("No logs yet")
                        .font(.headline)
                        .foregroundColor(.secondary)
                    Text("Logs will appear here when the proxy handles requests")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(logs) {
                    TableColumn("Time") { log in
                        Text(formatTimestamp(log.timestamp))
                            .font(.system(.caption, design: .monospaced))
                    }
                    .width(80)

                    TableColumn("App") { log in
                        HStack(spacing: 4) {
                            Text(log.app)
                            if log.confidence < 0.8 {
                                Image(systemName: "questionmark.circle")
                                    .foregroundColor(.orange)
                                    .help("Low confidence: \(String(format: "%.0f%%", log.confidence * 100))")
                            }
                        }
                    }
                    .width(120)

                    TableColumn("Requested") { log in
                        Text(log.requestedModel)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                    }
                    .width(150)

                    TableColumn("Target") { log in
                        Text(log.targetModel)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.blue)
                            .lineLimit(1)
                    }
                    .width(150)

                    TableColumn("Status") { log in
                        Text("\(log.status)")
                            .foregroundColor(log.status == 200 ? .green : .red)
                    }
                    .width(60)

                    TableColumn("Latency") { log in
                        Text("\(log.latency)ms")
                            .font(.system(.caption, design: .monospaced))
                    }
                    .width(70)

                    TableColumn("Tokens") { log in
                        Text("\(log.inputTokens) → \(log.outputTokens)")
                            .font(.system(.caption, design: .monospaced))
                    }
                    .width(100)

                    TableColumn("Cost") { log in
                        Text(String(format: "$%.4f", log.cost))
                            .font(.system(.caption, design: .monospaced))
                    }
                    .width(70)
                }
            }
        }
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
    SettingsView(bridgeManager: BridgeManager())
}
