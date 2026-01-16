import SwiftUI

// MARK: - Components

struct DropdownSelector: View {
    @Binding var selection: String
    let options: [String]

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option) {
                    selection = option
                }
            }
        } label: {
            HStack(spacing: 8) {
                Text(selection)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.themeText)

                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.themeTextMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.themeHover)
            .cornerRadius(6)
        }
        .menuStyle(BorderlessButtonMenuStyle())
    }
}

struct DataTableRow: View {
    let date: String
    let model: String
    let credits: String
    let cost: String

    var body: some View {
        HStack(spacing: 16) {
            Text(date)
                .font(.system(size: 14))
                .foregroundColor(.themeTextMuted)
                .frame(width: 100, alignment: .leading)

            Text(model)
                .font(.system(size: 14))
                .foregroundColor(.themeText)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(credits)
                .font(.system(size: 14).monospacedDigit())
                .foregroundColor(.themeText)
                .frame(width: 80, alignment: .trailing)

            Text(cost)
                .font(.system(size: 14).monospacedDigit())
                .foregroundColor(.themeText)
                .frame(width: 80, alignment: .trailing)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - Models

struct Activity: Identifiable {
    let id = UUID()
    let date: String
    let model: String
    let credits: String
    let cost: String
}

// MARK: - Main View

struct StatsPanel: View {
    @State private var usagePercentage: Double = 0.564
    @State private var creditsUsed: Int = 564_000
    @State private var creditsTotal: Int = 1_000_000
    @State private var timeRange = "30 Days"

    // Mock data
    let recentActivity = [
        Activity(date: "Jan 15, 2026", model: "claude-3-opus", credits: "14,500", cost: "$0.22"),
        Activity(date: "Jan 14, 2026", model: "claude-3-sonnet", credits: "8,200", cost: "$0.03"),
        Activity(date: "Jan 14, 2026", model: "gpt-4", credits: "2,100", cost: "$0.06"),
        Activity(date: "Jan 13, 2026", model: "claude-3-haiku", credits: "45,000", cost: "$0.01")
    ]

    var body: some View {
        ThemeCard {
            VStack(alignment: .leading, spacing: 20) {
                // Header with time range
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
                }

                // Big percentage
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(String(format: "%.1f%%", usagePercentage * 100))
                        .font(.system(size: 48, weight: .bold))
                        .foregroundColor(.themeText)
                        .monospacedDigit()

                    Text("\(creditsUsed.formatted()) / \(creditsTotal.formatted())")
                        .font(.system(size: 14))
                        .foregroundColor(.themeTextMuted)
                }

                // Progress bar
                SegmentedProgressBar(progress: usagePercentage)
                    .frame(height: 8)

                // Dashed divider
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundColor(.themeBorder)
                    .frame(height: 1)

                // Recent activity table
                VStack(alignment: .leading, spacing: 12) {
                    Text("RECENT ACTIVITY")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(.themeTextMuted)

                    // Table header
                    HStack(spacing: 16) {
                        Text("DATE")
                            .frame(width: 100, alignment: .leading)
                        Text("MODEL")
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("CREDITS")
                            .frame(width: 80, alignment: .trailing)
                        Text("COST")
                            .frame(width: 80, alignment: .trailing)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.themeTextMuted)

                    // Table rows
                    ForEach(recentActivity) { activity in
                        DataTableRow(
                            date: activity.date,
                            model: activity.model,
                            credits: activity.credits,
                            cost: activity.cost
                        )
                    }
                }

                // Footer
                HStack {
                    HStack(spacing: 12) {
                        Button(action: refreshData) {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 14))
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                    .foregroundColor(.themeTextMuted)

                    Spacer()

                    // Using PillButton as per design review recommendation
                    PillButton(title: "View all") {
                        viewAllActivity()
                    }
                }
            }
        }
        .frame(maxWidth: 600)
    }

    // MARK: - Actions

    private func refreshData() {
        // Mock refresh action
        print("Refreshing data...")
    }

    private func viewAllActivity() {
        // Mock view all action
        print("View all activity...")
    }
}
