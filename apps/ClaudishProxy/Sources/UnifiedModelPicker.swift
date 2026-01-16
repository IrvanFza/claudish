import SwiftUI

/// Unified picker for profiles and models with search
struct UnifiedModelPicker: View {
    @ObservedObject var profileManager: ProfileManager
    @ObservedObject var bridgeManager: BridgeManager
    @StateObject private var modelProvider = ModelProvider.shared
    @Environment(\.openWindow) private var openWindow

    @State private var searchText = ""
    @State private var isExpanded = false

    // Current selection display
    private var selectionDisplay: String {
        if let profile = profileManager.selectedProfile {
            return profile.name
        }
        return "Select..."
    }

    // Current selection description
    private var selectionDescription: String? {
        if let profile = profileManager.selectedProfile {
            if profile.isPreset {
                return profile.description
            }
            // For single-model selection, show the model
            if profile.slots.opus == profile.slots.sonnet &&
               profile.slots.opus == profile.slots.haiku &&
               profile.slots.opus == profile.slots.subagent {
                return profile.slots.opus
            }
            return profile.description
        }
        return nil
    }

    // Filtered profiles based on search
    private var filteredProfiles: [ModelProfile] {
        if searchText.isEmpty {
            return profileManager.profiles
        }
        return profileManager.profiles.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.description?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    // Filtered models based on search
    private var filteredModels: [AvailableModel] {
        modelProvider.models(matching: searchText)
    }

    // Group filtered models by provider
    private var filteredModelsByProvider: [(provider: ModelProviderType, models: [AvailableModel])] {
        let filtered = filteredModels
        var result: [(ModelProviderType, [AvailableModel])] = []

        // Direct APIs first
        let directOrder: [ModelProviderType] = [.openai, .gemini, .kimi, .minimax, .glm]
        for provider in directOrder {
            let providerModels = filtered.filter { $0.provider == provider }
            if !providerModels.isEmpty {
                result.append((provider, providerModels))
            }
        }

        // OpenRouter last
        let openRouterModels = filtered.filter { $0.provider == .openrouter }
        if !openRouterModels.isEmpty {
            result.append((.openrouter, openRouterModels))
        }

        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("MODEL")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .tracking(1.0)
                .foregroundColor(.themeTextMuted)

            // Main dropdown button
            Button(action: { isExpanded.toggle() }) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectionDisplay)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(.themeText)

                        if let desc = selectionDescription {
                            Text(desc)
                                .font(.system(size: 10))
                                .foregroundColor(.themeTextMuted)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.themeTextMuted)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.themeHover)
                .cornerRadius(8)
            }
            .buttonStyle(PlainButtonStyle())

            // Expanded dropdown content
            if isExpanded {
                VStack(spacing: 0) {
                    // Search field
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 12))
                            .foregroundColor(.themeTextMuted)

                        TextField("Search models...", text: $searchText)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .foregroundColor(.themeText)

                        if modelProvider.isLoading {
                            ProgressView()
                                .scaleEffect(0.7)
                        }
                    }
                    .padding(10)
                    .background(Color.themeBg)

                    Divider()
                        .background(Color.themeBorder)

                    // Scrollable content with fixed height
                    ScrollView(.vertical, showsIndicators: true) {
                        VStack(alignment: .leading, spacing: 0) {
                            // Profiles section
                            SectionHeader(title: "Profiles")

                            ForEach(filteredProfiles.filter { $0.isPreset }) { profile in
                                PickerRow(
                                    title: profile.name,
                                    subtitle: profile.description,
                                    isSelected: profileManager.selectedProfileId == profile.id,
                                    action: {
                                        profileManager.selectProfile(id: profile.id)
                                        isExpanded = false
                                        searchText = ""
                                    }
                                )
                            }

                            // Custom profiles section
                            if filteredProfiles.contains(where: { !$0.isPreset }) {
                                SectionHeader(title: "Custom Profiles")

                                ForEach(filteredProfiles.filter { !$0.isPreset }) { profile in
                                    PickerRow(
                                        title: profile.name,
                                        subtitle: profile.description,
                                        isSelected: profileManager.selectedProfileId == profile.id,
                                        action: {
                                            profileManager.selectProfile(id: profile.id)
                                            isExpanded = false
                                            searchText = ""
                                        }
                                    )
                                }
                            }

                            // Models grouped by provider
                            ForEach(filteredModelsByProvider, id: \.provider) { group in
                                ProviderSection(
                                    provider: group.provider,
                                    models: group.models,
                                    isSingleModelSelected: isSingleModelSelected,
                                    onSelect: { model in
                                        selectSingleModel(model)
                                        isExpanded = false
                                        searchText = ""
                                    }
                                )
                            }

                            // Edit profiles action
                            Divider()
                                .background(Color.themeBorder)
                                .padding(.vertical, 4)

                            Button(action: {
                                NSApp.setActivationPolicy(.regular)
                                openWindow(id: "settings")
                                NSApp.activate(ignoringOtherApps: true)
                                isExpanded = false
                            }) {
                                HStack(spacing: 8) {
                                    Image(systemName: "slider.horizontal.3")
                                        .font(.system(size: 12))
                                    Text("Edit Profiles...")
                                        .font(.system(size: 13))
                                    Spacer()
                                }
                                .foregroundColor(.themeTextMuted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                            }
                            .buttonStyle(PlainButtonStyle())
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 350)
                }
                .background(Color.themeCard)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.themeBorder, lineWidth: 1)
                )
                .onAppear {
                    // Fetch OpenRouter models when dropdown opens
                    if modelProvider.lastFetchDate == nil {
                        Task {
                            await modelProvider.fetchOpenRouterModels()
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    // Check if a single model is currently selected for all slots
    private func isSingleModelSelected(_ modelId: String) -> Bool {
        guard let profile = profileManager.selectedProfile else { return false }
        return profile.slots.opus == modelId &&
               profile.slots.sonnet == modelId &&
               profile.slots.haiku == modelId &&
               profile.slots.subagent == modelId
    }

    // Select a single model for all slots
    private func selectSingleModel(_ model: AvailableModel) {
        let slots = ProfileSlots(
            opus: model.id,
            sonnet: model.id,
            haiku: model.id,
            subagent: model.id
        )

        // Check if we already have this as a custom profile
        let existingProfile = profileManager.profiles.first { profile in
            !profile.isPreset &&
            profile.slots == slots
        }

        if let existing = existingProfile {
            profileManager.selectProfile(id: existing.id)
        } else {
            // Create a new profile for this model
            let newProfile = profileManager.createProfile(
                name: model.displayName,
                description: "All requests use \(model.displayName)",
                slots: slots
            )
            profileManager.selectProfile(id: newProfile.id)
        }
    }
}

// MARK: - Provider Section

struct ProviderSection: View {
    let provider: ModelProviderType
    let models: [AvailableModel]
    let isSingleModelSelected: (String) -> Bool
    let onSelect: (AvailableModel) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Provider header with icon
            HStack(spacing: 6) {
                Image(systemName: provider.icon)
                    .font(.system(size: 10))
                Text(provider.rawValue.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.5)
            }
            .foregroundColor(.themeTextSubtle)
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 6)

            ForEach(models) { model in
                PickerRow(
                    title: model.displayName,
                    subtitle: model.description ?? model.id,
                    isSelected: isSingleModelSelected(model.id),
                    action: { onSelect(model) }
                )
            }
        }
    }
}

// MARK: - Helper Views

struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.5)
            .foregroundColor(.themeTextSubtle)
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 6)
    }
}

struct PickerRow: View {
    let title: String
    let subtitle: String?
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                        .foregroundColor(.themeText)

                    if let subtitle = subtitle {
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundColor(.themeTextMuted)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.themeAccent)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(isHovered || isSelected ? Color.themeHover : Color.clear)
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { hovering in
            isHovered = hovering
        }
    }
}
