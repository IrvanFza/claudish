# Stats Panel Design Specification

**Purpose**: Design reference for implementing credit usage and statistics panels in ClaudishProxy settings.

**Target Platform**: SwiftUI (macOS)

**Design Theme**: Dark mode with subtle depth, clean data visualization, modern UI elements

---

## Color Palette

### Background Colors

```swift
// Main background
Color(hex: "#1a1a1e")

// Card/panel background
Color(hex: "#252529")

// Hover/interactive states
Color(hex: "#2a2a2e")
```

### Text Colors

```swift
// Primary text (headings, key data)
Color(hex: "#ffffff")

// Secondary text (labels, descriptions)
Color(hex: "#8b8b8f")

// Muted text (table headers, metadata)
Color(hex: "#6b6b6f")
```

### Accent Colors

```swift
// Progress/active state (orange)
Color(hex: "#f97316")

// Success/enabled state (green)
Color(hex: "#22c55e")

// Destructive actions (red)
Color(hex: "#ef4444")

// Info/neutral accent (blue)
Color(hex: "#3b82f6")
```

### Borders & Dividers

```swift
// Default border
Color(hex: "#3f3f46")

// Subtle divider
Color(hex: "#2a2a2e")

// Dashed divider (use with strokeStyle)
Color(hex: "#3f3f46")
  .strokeStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
```

---

## Typography Scale

### Display Numbers (Large Stats)

```swift
// 56.4% usage, credit totals
.font(.system(size: 48, weight: .bold))
.foregroundColor(.white)
.monospacedDigit() // For numeric stability
```

### Section Labels

```swift
// "CREDITS USED", "RECENT ACTIVITY"
.font(.system(size: 11, weight: .semibold))
.textCase(.uppercase)
.tracking(1.0) // Letter spacing
.foregroundColor(Color(hex: "#8b8b8f"))
```

### Table Headers

```swift
// "Date", "Model", "Credits", "Cost"
.font(.system(size: 12, weight: .medium))
.textCase(.uppercase)
.foregroundColor(Color(hex: "#8b8b8f"))
```

### Table Data

```swift
// Regular table content
.font(.system(size: 14, weight: .regular))
.foregroundColor(.white)

// Numeric columns (credits, costs)
.font(.system(size: 14, weight: .regular).monospacedDigit())
.foregroundColor(.white)
```

### Body Text

```swift
// Descriptions, help text
.font(.system(size: 13, weight: .regular))
.foregroundColor(Color(hex: "#8b8b8f"))
```

### Button Text

```swift
// "View all", "Manage plan"
.font(.system(size: 13, weight: .medium))
.foregroundColor(.white)
```

---

## Component Specifications

### Stats Card

**Visual Style**: Elevated card with subtle shadow and rounded corners

```swift
struct StatsCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(24)
        .background(Color(hex: "#252529"))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 2)
    }
}
```

**Usage**:
- Card padding: 24px all sides
- Corner radius: 12px
- Shadow: 2px vertical offset, 8px blur, 20% opacity

---

### Progress Bar (Segmented)

**Visual Style**: Striped progress indicator with vertical bars

```swift
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
                              Color(hex: "#f97316") :
                              Color(hex: "#3f3f46"))
                        .frame(width: (geometry.size.width - CGFloat(segments - 1) * 2) / CGFloat(segments))
                }
            }
        }
        .frame(height: 8)
        .cornerRadius(4)
    }
}
```

**Specifications**:
- Height: 8px
- Segment count: 20
- Gap between segments: 2px
- Filled color: Orange (#f97316)
- Unfilled color: Gray (#3f3f46)
- Corner radius: 4px

---

### Toggle Switch

**Visual Style**: Compact green toggle with smooth animation

```swift
Toggle("Auto-refresh", isOn: $isEnabled)
    .toggleStyle(SwitchToggleStyle(tint: Color(hex: "#22c55e")))
    .font(.system(size: 14))
```

**Specifications**:
- Enabled color: Green (#22c55e)
- Disabled color: System gray
- Label font: 14px regular
- Animation: Spring animation (default)

---

### Data Table

**Visual Style**: Clean rows with aligned columns, monospace numbers

```swift
struct DataTableRow: View {
    let date: String
    let model: String
    let credits: String
    let cost: String

    var body: some View {
        HStack(spacing: 16) {
            Text(date)
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "#8b8b8f"))
                .frame(width: 100, alignment: .leading)

            Text(model)
                .font(.system(size: 14))
                .foregroundColor(.white)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(credits)
                .font(.system(size: 14).monospacedDigit())
                .foregroundColor(.white)
                .frame(width: 80, alignment: .trailing)

            Text(cost)
                .font(.system(size: 14).monospacedDigit())
                .foregroundColor(.white)
                .frame(width: 80, alignment: .trailing)
        }
        .padding(.vertical, 8)
    }
}
```

**Specifications**:
- Row padding: 8px vertical
- Column spacing: 16px
- Date column: 100px, left-aligned, muted gray
- Model column: Flexible width, left-aligned, white
- Credits column: 80px, right-aligned, monospace, white
- Cost column: 80px, right-aligned, monospace, white
- Header: Same layout with uppercase 12px text

---

### Pill Button (Outline Style)

**Visual Style**: Rounded button with border, no fill

```swift
struct PillButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .buttonStyle(PlainButtonStyle())
        .background(Color.clear)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color(hex: "#3f3f46"), lineWidth: 1)
        )
        .cornerRadius(16)
    }
}
```

**Specifications**:
- Horizontal padding: 16px
- Vertical padding: 8px
- Corner radius: 16px (fully rounded)
- Border: 1px solid #3f3f46
- Background: Transparent
- Hover state: Border color brightens to #4f4f56

---

### Dropdown Selector

**Visual Style**: Dark button with chevron indicator

```swift
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
                    .foregroundColor(.white)

                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Color(hex: "#8b8b8f"))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(hex: "#2a2a2e"))
            .cornerRadius(6)
        }
        .menuStyle(BorderlessButtonMenuStyle())
    }
}
```

**Specifications**:
- Horizontal padding: 12px
- Vertical padding: 6px
- Corner radius: 6px
- Background: #2a2a2e
- Chevron: 10px, gray (#8b8b8f)
- Menu background: System (dark mode adaptive)

---

## Layout Patterns

### Section Spacing

```swift
VStack(spacing: 24) {
    // Section 1
    // Section 2
}
```

**Specifications**:
- Between sections: 24px
- Within sections: 12px
- Card internal padding: 24px

---

### Dividers

**Solid Divider**:
```swift
Divider()
    .background(Color(hex: "#3f3f46"))
    .padding(.vertical, 16)
```

**Dashed Divider**:
```swift
Rectangle()
    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
    .foregroundColor(Color(hex: "#3f3f46"))
    .frame(height: 1)
    .padding(.vertical, 16)
```

---

### Footer Action Bar

```swift
HStack {
    HStack(spacing: 12) {
        Button(action: {}) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 14))
        }
        .buttonStyle(PlainButtonStyle())

        Button(action: {}) {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 14))
        }
        .buttonStyle(PlainButtonStyle())
    }

    Spacer()

    Button("View all →") {
        // Action
    }
    .buttonStyle(PlainButtonStyle())
    .foregroundColor(Color(hex: "#f97316"))
}
.foregroundColor(Color(hex: "#8b8b8f"))
```

**Specifications**:
- Icon size: 14px
- Icon color: Muted gray (#8b8b8f)
- Link color: Orange (#f97316)
- Spacing between icons: 12px

---

## Usage Grid Example

**Complete Stats Panel Implementation**:

```swift
struct StatsPanel: View {
    @State private var usagePercentage: Double = 0.564
    @State private var creditsUsed: Int = 564_000
    @State private var creditsTotal: Int = 1_000_000
    @State private var timeRange = "30 Days"

    var body: some View {
        StatsCard {
            VStack(alignment: .leading, spacing: 20) {
                // Header with time range
                HStack {
                    Text("CREDITS USED")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(Color(hex: "#8b8b8f"))

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
                        .foregroundColor(.white)
                        .monospacedDigit()

                    Text("\(creditsUsed.formatted()) / \(creditsTotal.formatted())")
                        .font(.system(size: 14))
                        .foregroundColor(Color(hex: "#8b8b8f"))
                }

                // Progress bar
                SegmentedProgressBar(progress: usagePercentage)
                    .frame(height: 8)

                // Dashed divider
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundColor(Color(hex: "#3f3f46"))
                    .frame(height: 1)

                // Recent activity table
                VStack(alignment: .leading, spacing: 12) {
                    Text("RECENT ACTIVITY")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(Color(hex: "#8b8b8f"))

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
                    .foregroundColor(Color(hex: "#8b8b8f"))

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
                    .foregroundColor(Color(hex: "#8b8b8f"))

                    Spacer()

                    PillButton(title: "View all", action: viewAllActivity)
                }
            }
        }
        .frame(maxWidth: 600)
    }
}
```

---

## Accessibility Guidelines

### Color Contrast
- Text on card background (#ffffff on #252529): 14.8:1 (AAA)
- Secondary text (#8b8b8f on #252529): 4.8:1 (AA)
- Orange accent (#f97316 on #252529): 4.2:1 (AA for large text)

### Keyboard Navigation
- All interactive elements should be keyboard accessible
- Use `.focusable()` modifier on custom buttons
- Provide `.keyboardShortcut()` for primary actions

### Screen Reader Support
```swift
.accessibilityLabel("Credits used: 56.4%")
.accessibilityValue("\(creditsUsed) of \(creditsTotal) credits")
.accessibilityHint("Shows credit usage for the selected time period")
```

---

## Animation Guidelines

### Default Transitions
```swift
// Smooth value changes (progress bar, numbers)
.animation(.easeInOut(duration: 0.3), value: usagePercentage)

// Card appearance
.transition(.opacity.combined(with: .scale(scale: 0.95)))

// Hover states
.animation(.easeOut(duration: 0.15), value: isHovered)
```

### Number Animations
```swift
// Animate number changes smoothly
Text(String(format: "%.1f%%", animatedPercentage))
    .contentTransition(.numericText(value: animatedPercentage))
    .animation(.easeInOut(duration: 0.5), value: animatedPercentage)
```

---

## SwiftUI Helper Extensions

### Color Extension

```swift
extension Color {
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
}
```

---

## Design Principles

1. **Hierarchy through Contrast**: Large bold numbers for key metrics, muted labels for context
2. **Consistent Spacing**: 24px for major sections, 12px within sections, 8px for list items
3. **Monospace for Numbers**: Use `.monospacedDigit()` to prevent layout shifts when values update
4. **Subtle Depth**: Cards elevated with shadow, not excessive borders
5. **Restrained Color**: Orange for emphasis, green for positive actions, white for data
6. **Rounded Corners**: 12px for cards, 16px for pills, 6px for small controls
7. **Responsive Layout**: Use flexible widths where appropriate, fixed widths for numeric columns

---

## Export & Print Styles

For exporting stats panels as images or PDFs:

```swift
.background(Color(hex: "#1a1a1e")) // Ensure background is included
.drawingGroup() // Optimize for rendering
```

For high-resolution exports:
```swift
@Environment(\.displayScale) var displayScale

// Use displayScale * 2 for retina exports
```

---

## Dark Mode Optimization

This design is optimized for dark mode. For light mode adaptation:

**Not recommended** - This design loses its character in light mode. If light mode support is required, create a separate design specification with adjusted colors:
- Background: #ffffff → #f5f5f5
- Cards: #252529 → #ffffff
- Text: Invert hierarchy (dark on light)
- Maintain accent colors (orange, green) for consistency

---

## Performance Considerations

- Use `.drawingGroup()` for complex progress bars with many segments
- Lazy load table rows with `LazyVStack` for large datasets
- Cache formatted number strings to avoid repeated formatting
- Use `@State` sparingly; prefer `@Binding` for nested components
- Profile with Instruments if rendering >100 table rows

---

**Version**: 1.0
**Last Updated**: 2026-01-16
**Designer Reference**: Credit usage panel analysis
**Target App**: ClaudishProxy Settings Panel
