import SwiftUI

/// The Recall visual system: one black canvas, pink accents, Sora for words,
/// Geist Mono for source lines and status captions.
enum Theme {
    static let background = Color(hex: 0x000000)
    static let card = Color(hex: 0x141416)
    static let surface = Color(hex: 0x232326)
    static let text = Color(hex: 0xFFFFFF)
    static let textSoft = Color(hex: 0xE6E6EA)
    static let secondary = Color(hex: 0xB4B4BA)
    static let caption = Color(hex: 0x8A8A92)
    static let pink = Color(hex: 0xFF7EC4)
    static let pinkLight = Color(hex: 0xFFA6D9)
    static let pinkTile = Color(hex: 0x3A1830)

    /// Cards rise from the orb with a soft spring that never bounces.
    static let rise = Animation.spring(response: 0.35, dampingFraction: 0.85)
    static let minButtonHeight: CGFloat = 56
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

// MARK: - Type

enum SoraWeight: String {
    case light = "Sora-Light"
    case regular = "Sora-Regular"
    case medium = "Sora-Medium"
    case semibold = "Sora-SemiBold"

    var system: Font.Weight {
        switch self {
        case .light: .light
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semibold
        }
    }
}

extension Font {
    /// Sora at a Dynamic Type–relative size. Falls back to the system font if
    /// the bundled file is missing so text never disappears.
    static func sora(_ size: CGFloat, _ weight: SoraWeight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        if UIFont(name: weight.rawValue, size: size) != nil {
            return .custom(weight.rawValue, size: size, relativeTo: style)
        }
        return .system(size: size, weight: weight.system)
    }

    /// Geist Mono for source lines: 12pt, scaled with captions.
    static func mono(_ size: CGFloat = 12, medium: Bool = false) -> Font {
        let name = medium ? "GeistMono-Medium" : "GeistMono-Regular"
        if UIFont(name: name, size: size) != nil {
            return .custom(name, size: size, relativeTo: .caption)
        }
        return .system(size: size, weight: medium ? .medium : .regular, design: .monospaced)
    }
}

/// The small uppercase mono line under every card and status caption.
struct MonoCaption: View {
    let text: String
    var color: Color = Theme.caption

    var body: some View {
        Text(text.uppercased())
            .font(.mono())
            .tracking(1)
            .foregroundStyle(color)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Buttons

struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    var kind: Kind = .primary
    var height: CGFloat = 60

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.sora(18, kind == .primary ? .semibold : .medium))
            .foregroundStyle(kind == .primary ? Color.black : Theme.text)
            .frame(maxWidth: .infinity)
            .frame(minHeight: max(height, Theme.minButtonHeight))
            .background(kind == .primary ? Theme.text : Theme.surface, in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var primaryPill: PillButtonStyle { PillButtonStyle(kind: .primary) }
    static var secondaryPill: PillButtonStyle { PillButtonStyle(kind: .secondary) }
    static func pill(_ kind: PillButtonStyle.Kind, height: CGFloat = 56) -> PillButtonStyle {
        PillButtonStyle(kind: kind, height: height)
    }
}

/// Quiet text link used under primary buttons ("I already have an account").
struct QuietLinkStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.sora(17))
            .foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Round letter avatar on the deep pink tile ("P" for Priya).
struct LetterAvatar: View {
    let name: String
    var size: CGFloat = 56

    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
            .font(.sora(size * 0.36, .semibold))
            .foregroundStyle(Theme.pinkLight)
            .frame(width: size, height: size)
            .background(Theme.pinkTile, in: Circle())
            .accessibilityHidden(true)
    }
}

/// A Card surface: #141416, 28pt corners, generous padding.
struct CardSurface<Content: View>: View {
    var padding: CGFloat = 24
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 20) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}
