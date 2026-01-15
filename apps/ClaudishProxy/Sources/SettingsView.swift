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
    @State private var launchAtLogin = false

    var body: some View {
        Form {
            Section("Proxy") {
                Toggle("Enable proxy on launch", isOn: .constant(false))
                    .disabled(true)  // TODO: Implement

                Toggle("Launch at login", isOn: $launchAtLogin)
                    .disabled(true)  // TODO: Implement

                if let config = bridgeManager.config {
                    Toggle("Proxy enabled", isOn: .constant(config.enabled))
                        .disabled(true)
                }
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

#Preview {
    SettingsView(bridgeManager: BridgeManager())
}
