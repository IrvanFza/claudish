import SwiftUI

/// Theme colors and styling constants for ClaudishProxy
/// Based on the dark theme design from stats-panel-style.md

extension Color {
    /// Initialize Color from hex string (e.g., "#1a1a1e" or "1a1a1e")
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }

    // MARK: - Background Colors

    /// Main background color (#1a1a1e)
    static let themeBg = Color(hex: "#1a1a1e")

    /// Card/panel background color (#252529)
    static let themeCard = Color(hex: "#252529")

    /// Hover/interactive state background (#2a2a2e)
    static let themeHover = Color(hex: "#2a2a2e")

    // MARK: - Text Colors

    /// Primary text color for headings and key data (#ffffff)
    static let themeText = Color(hex: "#ffffff")

    /// Secondary text color for labels and descriptions (#8b8b8f)
    static let themeTextMuted = Color(hex: "#8b8b8f")

    /// Muted text color for table headers and metadata (#6b6b6f)
    static let themeTextSubtle = Color(hex: "#6b6b6f")

    // MARK: - Accent Colors

    /// Progress/active state color (orange #f97316)
    static let themeAccent = Color(hex: "#f97316")

    /// Success/enabled state color (green #22c55e)
    static let themeSuccess = Color(hex: "#22c55e")

    /// Destructive action color (red #ef4444)
    static let themeDestructive = Color(hex: "#ef4444")

    /// Info/neutral accent color (blue #3b82f6)
    static let themeInfo = Color(hex: "#3b82f6")

    // MARK: - Borders & Dividers

    /// Default border color (#3f3f46)
    static let themeBorder = Color(hex: "#3f3f46")

    /// Subtle divider color (#2a2a2e)
    static let themeDivider = Color(hex: "#2a2a2e")
}

// MARK: - Reusable Components

/// Card component with dark theme styling
struct ThemeCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(24)
        .background(Color.themeCard)
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 2)
    }
}

/// Segmented progress bar with vertical bars
struct SegmentedProgressBar: View {
    let progress: Double // 0.0 to 1.0
    let segments: Int = 20

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 2) {
                ForEach(0..<segments, id: \.self) { index in
                    let segmentProgress = Double(index) / Double(segments)
                    Rectangle()
                        .fill(segmentProgress < progress ?
                              Color.themeAccent :
                              Color.themeBorder)
                        .frame(width: (geometry.size.width - CGFloat(segments - 1) * 2) / CGFloat(segments))
                }
            }
        }
        .frame(height: 8)
        .cornerRadius(4)
    }
}

/// Pill button with outline style
struct PillButton: View {
    let title: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.themeText)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .buttonStyle(PlainButtonStyle())
        .background(Color.clear)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isHovered ? Color(hex: "#4f4f56") : Color.themeBorder, lineWidth: 1)
        )
        .cornerRadius(16)
        .onHover { hovering in
            isHovered = hovering
        }
    }
}

