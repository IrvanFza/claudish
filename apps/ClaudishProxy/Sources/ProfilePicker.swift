import SwiftUI

/// Profile picker for menu bar dropdown
struct ProfilePicker: View {
    @ObservedObject var profileManager: ProfileManager
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PROFILE")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .tracking(1.0)
                .foregroundColor(.themeTextMuted)

            Menu {
                // Preset profiles section
                Section("Presets") {
                    ForEach(profileManager.profiles.filter { $0.isPreset }) { profile in
                        Button(action: {
                            profileManager.selectProfile(id: profile.id)
                        }) {
                            HStack {
                                Text(profile.name)
                                if profileManager.selectedProfileId == profile.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }

                // Custom profiles section (if any exist)
                let customProfiles = profileManager.profiles.filter { !$0.isPreset }
                if !customProfiles.isEmpty {
                    Divider()
                    Section("Custom") {
                        ForEach(customProfiles) { profile in
                            Button(action: {
                                profileManager.selectProfile(id: profile.id)
                            }) {
                                HStack {
                                    Text(profile.name)
                                    if profileManager.selectedProfileId == profile.id {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    }
                }

                Divider()

                // Edit profiles action (opens Settings window)
                Button(action: {
                    // Open settings window and activate app
                    NSApp.setActivationPolicy(.regular)
                    openWindow(id: "settings")
                    NSApp.activate(ignoringOtherApps: true)
                }) {
                    HStack {
                        Image(systemName: "slider.horizontal.3")
                        Text("Edit Profiles...")
                    }
                }
            } label: {
                HStack {
                    Text(profileManager.selectedProfile?.name ?? "No Profile")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.themeText)

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.themeTextMuted)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.themeHover)
                .cornerRadius(8)
            }
            .menuStyle(BorderlessButtonMenuStyle())

            // Show selected profile description
            if let description = profileManager.selectedProfile?.description {
                Text(description)
                    .font(.system(size: 11))
                    .foregroundColor(.themeTextMuted)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }
}
