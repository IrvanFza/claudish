import SwiftUI
import UniformTypeIdentifiers

/// Profiles tab in Settings window
struct ProfilesSettingsView: View {
    @ObservedObject var profileManager: ProfileManager
    @State private var selectedProfile: ModelProfile?
    @State private var showingProfileEditor = false
    @State private var showingImportDialog = false
    @State private var showingExportDialog = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Header with actions
                HStack {
                    Text("Model Profiles")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.themeText)

                    Spacer()

                    HStack(spacing: 12) {
                        Button(action: {
                            showingImportDialog = true
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "square.and.arrow.down")
                                Text("Import")
                            }
                            .font(.system(size: 13))
                        }

                        Button(action: {
                            showingExportDialog = true
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "square.and.arrow.up")
                                Text("Export")
                            }
                            .font(.system(size: 13))
                        }

                        Button(action: {
                            selectedProfile = nil
                            showingProfileEditor = true
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "plus.circle.fill")
                                Text("New Profile")
                            }
                            .font(.system(size: 13, weight: .medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.themeAccent)
                        .cornerRadius(6)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)

                // Error message
                if let error = errorMessage {
                    ThemeCard {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.themeAccent)
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundColor(.themeText)
                        }
                    }
                    .padding(.horizontal, 24)
                }

                // Preset profiles
                VStack(alignment: .leading, spacing: 12) {
                    Text("PRESET PROFILES")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(.themeTextMuted)
                        .padding(.horizontal, 24)

                    ForEach(profileManager.profiles.filter { $0.isPreset }) { profile in
                        ProfileRow(
                            profile: profile,
                            isSelected: profileManager.selectedProfileId == profile.id,
                            onSelect: {
                                profileManager.selectProfile(id: profile.id)
                            },
                            onEdit: nil,
                            onDuplicate: {
                                if let duplicate = profileManager.duplicateProfile(id: profile.id) {
                                    selectedProfile = duplicate
                                    showingProfileEditor = true
                                }
                            },
                            onDelete: nil
                        )
                        .padding(.horizontal, 24)
                    }
                }

                // Custom profiles
                let customProfiles = profileManager.profiles.filter { !$0.isPreset }
                if !customProfiles.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("CUSTOM PROFILES")
                            .font(.system(size: 11, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)
                            .padding(.horizontal, 24)

                        ForEach(customProfiles) { profile in
                            ProfileRow(
                                profile: profile,
                                isSelected: profileManager.selectedProfileId == profile.id,
                                onSelect: {
                                    profileManager.selectProfile(id: profile.id)
                                },
                                onEdit: {
                                    selectedProfile = profile
                                    showingProfileEditor = true
                                },
                                onDuplicate: {
                                    if let duplicate = profileManager.duplicateProfile(id: profile.id) {
                                        selectedProfile = duplicate
                                        showingProfileEditor = true
                                    }
                                },
                                onDelete: {
                                    profileManager.deleteProfile(id: profile.id)
                                }
                            )
                            .padding(.horizontal, 24)
                        }
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.bottom, 24)
        }
        .background(Color.themeBg)
        .sheet(isPresented: $showingProfileEditor) {
            ProfileEditorSheet(
                profileManager: profileManager,
                profile: selectedProfile
            )
        }
        .fileImporter(
            isPresented: $showingImportDialog,
            allowedContentTypes: [.json]
        ) { result in
            handleImport(result)
        }
        .fileExporter(
            isPresented: $showingExportDialog,
            document: ProfilesDocument(profiles: profileManager.profiles),
            contentType: .json,
            defaultFilename: "claudish-profiles.json"
        ) { result in
            handleExport(result)
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            do {
                try profileManager.importProfiles(from: url)
                errorMessage = nil
            } catch {
                errorMessage = "Import failed: \(error.localizedDescription)"
            }
        case .failure(let error):
            errorMessage = "Import failed: \(error.localizedDescription)"
        }
    }

    private func handleExport(_ result: Result<URL, Error>) {
        switch result {
        case .success:
            errorMessage = nil
        case .failure(let error):
            errorMessage = "Export failed: \(error.localizedDescription)"
        }
    }
}

/// Individual profile row
struct ProfileRow: View {
    let profile: ModelProfile
    let isSelected: Bool
    let onSelect: () -> Void
    let onEdit: (() -> Void)?
    let onDuplicate: () -> Void
    let onDelete: (() -> Void)?

    var body: some View {
        ThemeCard {
            HStack(spacing: 16) {
                // Selection indicator
                Button(action: onSelect) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20))
                        .foregroundColor(isSelected ? .themeAccent : .themeTextMuted)
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(profile.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.themeText)

                        if profile.isPreset {
                            Text("PRESET")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(.themeAccent)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.themeAccent.opacity(0.2))
                                .cornerRadius(4)
                        }
                    }

                    if let description = profile.description {
                        Text(description)
                            .font(.system(size: 12))
                            .foregroundColor(.themeTextMuted)
                    }

                    // Show slot mappings
                    HStack(spacing: 16) {
                        SlotBadge(label: "Opus", model: profile.slots.opus)
                        SlotBadge(label: "Sonnet", model: profile.slots.sonnet)
                        SlotBadge(label: "Haiku", model: profile.slots.haiku)
                        SlotBadge(label: "Subagent", model: profile.slots.subagent)
                    }
                    .padding(.top, 4)
                }

                Spacer()

                // Actions
                HStack(spacing: 8) {
                    if let onEdit = onEdit {
                        Button(action: onEdit) {
                            Image(systemName: "pencil")
                                .font(.system(size: 14))
                                .foregroundColor(.themeTextMuted)
                        }
                        .buttonStyle(.plain)
                    }

                    Button(action: onDuplicate) {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 14))
                            .foregroundColor(.themeTextMuted)
                    }
                    .buttonStyle(.plain)

                    if let onDelete = onDelete {
                        Button(action: onDelete) {
                            Image(systemName: "trash")
                                .font(.system(size: 14))
                                .foregroundColor(.themeDestructive)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

/// Small badge showing a slot mapping
struct SlotBadge: View {
    let label: String
    let model: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(.themeTextMuted)
            Text(modelDisplayName(model))
                .font(.system(size: 10))
                .foregroundColor(.themeText)
                .lineLimit(1)
        }
    }

    private func modelDisplayName(_ modelId: String) -> String {
        // Extract short name from model ID
        if let lastComponent = modelId.split(separator: "/").last {
            return String(lastComponent)
        }
        return modelId
    }
}

/// Sheet for creating or editing a profile
struct ProfileEditorSheet: View {
    @ObservedObject var profileManager: ProfileManager
    let profile: ModelProfile?

    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var description: String
    @State private var opusSlot: String
    @State private var sonnetSlot: String
    @State private var haikuSlot: String
    @State private var subagentSlot: String

    init(profileManager: ProfileManager, profile: ModelProfile?) {
        self.profileManager = profileManager
        self.profile = profile

        // Initialize state from profile or defaults
        if let profile = profile {
            _name = State(initialValue: profile.name)
            _description = State(initialValue: profile.description ?? "")
            _opusSlot = State(initialValue: profile.slots.opus)
            _sonnetSlot = State(initialValue: profile.slots.sonnet)
            _haikuSlot = State(initialValue: profile.slots.haiku)
            _subagentSlot = State(initialValue: profile.slots.subagent)
        } else {
            _name = State(initialValue: "New Profile")
            _description = State(initialValue: "")
            // Default to Gemini 2.5 Flash for new profiles (good balance)
            _opusSlot = State(initialValue: "g/gemini-2.5-flash")
            _sonnetSlot = State(initialValue: "g/gemini-2.5-flash")
            _haikuSlot = State(initialValue: "g/gemini-2.5-flash-lite")
            _subagentSlot = State(initialValue: "g/gemini-2.5-flash-lite")
        }
    }

    var isEditing: Bool {
        profile != nil
    }

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text(isEditing ? "Edit Profile" : "New Profile")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(.themeText)

                Spacer()

                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.themeTextMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            .background(Color.themeCard)

            Divider()

            // Form
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Basic info
                    ThemeCard {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("BASIC INFORMATION")
                                .font(.system(size: 11, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(1.0)
                                .foregroundColor(.themeTextMuted)

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Name")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(.themeText)
                                TextField("Profile name", text: $name)
                                    .textFieldStyle(.plain)
                                    .padding(10)
                                    .background(Color.themeHover)
                                    .cornerRadius(6)
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Description (optional)")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(.themeText)
                                TextField("Profile description", text: $description)
                                    .textFieldStyle(.plain)
                                    .padding(10)
                                    .background(Color.themeHover)
                                    .cornerRadius(6)
                            }
                        }
                    }

                    // Model slots
                    ThemeCard {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("MODEL SLOTS")
                                .font(.system(size: 11, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(1.0)
                                .foregroundColor(.themeTextMuted)

                            SlotPicker(label: "Opus", selection: $opusSlot)
                            SlotPicker(label: "Sonnet", selection: $sonnetSlot)
                            SlotPicker(label: "Haiku", selection: $haikuSlot)
                            SlotPicker(label: "Subagent", selection: $subagentSlot)
                        }
                    }
                }
                .padding(20)
            }

            Divider()

            // Footer actions
            HStack(spacing: 12) {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(.themeTextMuted)

                Spacer()

                Button(isEditing ? "Save Changes" : "Create Profile") {
                    saveProfile()
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(isValid ? Color.themeAccent : Color.themeTextMuted)
                .cornerRadius(6)
                .disabled(!isValid)
            }
            .padding(20)
            .background(Color.themeCard)
        }
        .frame(width: 500, height: 600)
        .background(Color.themeBg)
    }

    private func saveProfile() {
        let slots = ProfileSlots(
            opus: opusSlot,
            sonnet: sonnetSlot,
            haiku: haikuSlot,
            subagent: subagentSlot
        )

        if let profile = profile {
            // Update existing
            profileManager.updateProfile(
                id: profile.id,
                name: name,
                description: description.isEmpty ? nil : description,
                slots: slots
            )
        } else {
            // Create new
            profileManager.createProfile(
                name: name,
                description: description.isEmpty ? nil : description,
                slots: slots
            )
        }
    }
}

/// Picker for a model slot using ModelProvider
struct SlotPicker: View {
    let label: String
    @Binding var selection: String
    @StateObject private var modelProvider = ModelProvider.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.themeText)

            Menu {
                // Group models by provider
                ForEach(modelProvider.modelsByProvider, id: \.provider) { group in
                    Section(group.provider.rawValue) {
                        ForEach(group.models) { model in
                            Button(action: { selection = model.id }) {
                                HStack {
                                    Text(model.displayName)
                                    if selection == model.id {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                }
            } label: {
                HStack {
                    Text(modelDisplayName(selection))
                        .font(.system(size: 13))
                        .foregroundColor(.themeText)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10))
                        .foregroundColor(.themeTextMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.themeHover)
                .cornerRadius(6)
            }
            .menuStyle(BorderlessButtonMenuStyle())
        }
    }

    private func modelDisplayName(_ modelId: String) -> String {
        if let model = modelProvider.allModels.first(where: { $0.id == modelId }) {
            return model.displayName
        }
        // Fallback: extract name from ID
        if let lastComponent = modelId.split(separator: "/").last {
            return String(lastComponent)
        }
        return modelId
    }
}

/// Document type for exporting profiles
struct ProfilesDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }

    let profiles: [ModelProfile]

    init(profiles: [ModelProfile]) {
        self.profiles = profiles
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.profiles = try JSONDecoder().decode([ModelProfile].self, from: data)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(profiles)
        return FileWrapper(regularFileWithContents: data)
    }
}
