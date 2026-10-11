import SwiftUI
import UIKit

/// What Steph is doing. The orb is the only indicator, so each state has a
/// distinct, calm rhythm.
enum OrbState: String, CaseIterable, Sendable {
    case idle, listening, thinking, replying

    var spokenName: String {
        switch self {
        case .idle: "Resting"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .replying: "Talking"
        }
    }
}

/// A live 0…1 audio level written by an audio thread and sampled by the orb
/// every frame. Not observable on purpose: the orb's timeline already redraws
/// at display rate, so publishing levels would only cause extra view updates.
final class AudioLevel: @unchecked Sendable {
    private let lock = NSLock()
    private var level: Float = 0
    private var updated = Date.distantPast

    func set(_ value: Float) {
        lock.lock()
        level = max(0, min(1, value))
        updated = Date()
        lock.unlock()
    }

    func reset() {
        lock.lock()
        level = 0
        updated = .distantPast
        lock.unlock()
    }

    /// The latest level, or nil when nothing has been measured recently.
    func current(at date: Date) -> Float? {
        lock.lock()
        defer { lock.unlock() }
        return date.timeIntervalSince(updated) < 0.35 ? level : nil
    }

    /// Converts a buffer's RMS to a perceptual 0…1 level.
    static func normalized(rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let db = 20 * log10(rms)
        return max(0, min(1, (db + 50) / 40))
    }
}

/// Steph: a glowing pink orb with two soft, blinking eyes. Reusable at any size.
///
///     StephOrb(size: 240, state: .listening, level: listener.level)
struct StephOrb: View {
    var size: CGFloat
    var state: OrbState
    /// Live microphone level while listening, or TTS level while replying.
    var level: AudioLevel? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var motion = OrbMotion()

    var body: some View {
        TimelineView(.animation) { context in
            let frame = motion.advance(to: context.date, state: state, level: level, reduceMotion: reduceMotion)
            OrbRendering(size: size, frame: frame)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel("Steph")
        .accessibilityValue(state.spokenName)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// One computed frame of orb motion.
struct OrbFrame: Equatable {
    var scale: Double = 1
    /// Extra stretch from the jelly bounce when listening starts.
    var stretchX: Double = 1
    var stretchY: Double = 1
    var glow: Double = 0.32
    /// Progress 0…1 of each listening ripple.
    var ripples: [Double] = []
    /// How open each eye is, from 0.07 (shut) to 1.
    var leftEye: Double = 1
    var rightEye: Double = 1
    /// Eye height multiplier: taller when Steph is paying attention.
    var eyeHeight: Double = 1
    /// Where the eyes look, as a fraction of the orb's size.
    var gazeX: Double = 0
    var gazeY: Double = 0
}

/// Smooths audio levels (fast attack, slow release) and glides the eyes
/// between states so a state change never makes them jump.
final class OrbMotion {
    private var start: Date?
    private var last: Date?
    private var state: OrbState?
    private var stateStart = Date.distantPast
    private var smoothedLevel: Double = 0
    private var gazeX: Double = 0
    private var gazeY: Double = 0
    private var eyeHeight: Double = 1

    func advance(to date: Date, state: OrbState, level: AudioLevel?, reduceMotion: Bool) -> OrbFrame {
        let start = self.start ?? date
        self.start = start
        let dt = min(max(date.timeIntervalSince(last ?? date), 0), 0.1)
        last = date
        if state != self.state {
            // The orb appearing mid-state shouldn't bounce, only a real change.
            if self.state != nil { stateStart = date }
            self.state = state
        }

        let live = level?.current(at: date).map(Double.init)
        let target = live ?? 0
        let k = target > smoothedLevel ? 0.5 : 0.12
        smoothedLevel += (target - smoothedLevel) * k

        var frame = Self.frame(state: state, t: date.timeIntervalSince(start), stateAge: date.timeIntervalSince(stateStart),
                               level: live == nil ? nil : smoothedLevel, reduceMotion: reduceMotion)

        let glide = reduceMotion ? 1 : min(1, dt * 6)
        gazeX += (frame.gazeX - gazeX) * glide
        gazeY += (frame.gazeY - gazeY) * glide
        eyeHeight += (frame.eyeHeight - eyeHeight) * glide
        frame.gazeX = gazeX
        frame.gazeY = gazeY
        frame.eyeHeight = eyeHeight
        return frame
    }

    /// The motion formulas, kept pure for tests and previews. `stateAge` is
    /// seconds since the state began.
    static func frame(state: OrbState, t: Double, stateAge: Double = .infinity, level: Double?, reduceMotion: Bool) -> OrbFrame {
        let tau = Double.pi * 2
        var frame = OrbFrame(leftEye: blink(at: t), rightEye: blink(at: max(0, t - 0.06)))
        switch state {
        case .idle:
            frame.scale = 1 + 0.012 * sin(tau * 0.25 * t)
            frame.glow = 0.32
        case .listening:
            let pulse = 0.5 + 0.5 * sin(tau * 1.1 * t)
            let amplitude = level.map { 0.2 + 0.8 * $0 } ?? 1
            frame.scale = 1 + 0.055 * pulse * amplitude
            frame.glow = 0.45 + 0.15 * sin(tau * 1.1 * t)
            frame.ripples = (0..<2).map { i in (t * 0.55 + Double(i) * 0.5).truncatingRemainder(dividingBy: 1) }
            let bounce = jelly(at: stateAge)
            frame.stretchX = 1 + 0.075 * bounce
            frame.stretchY = 1 + 0.15 * bounce
            frame.eyeHeight = 1.12
        case .thinking:
            frame.scale = 1 + 0.012 * sin(tau * 0.25 * t)
            frame.glow = 0.45
            frame.gazeX = 0.045 * sin(tau * 0.3 * t)
            frame.gazeY = -0.035
        case .replying:
            let wobble = 0.02 * sin(tau * 3.1 * t) + 0.01 * sin(tau * 5.7 * t)
            frame.scale = 1 + wobble * (level.map { 0.35 + 0.65 * $0 } ?? 1)
            let speech = level ?? abs(sin(tau * 2.3 * t))
            frame.glow = 0.5 + 0.25 * speech
            frame.gazeY = -0.02 * speech
        }
        if reduceMotion {
            frame.scale = 1
            frame.stretchX = 1
            frame.stretchY = 1
            frame.ripples = []
            if state == .thinking { frame.gazeX = 0.045 }
            if state == .replying { frame.gazeY = 0 }
            if state == .listening || state == .replying { frame.glow = 0.55 }
        }
        return frame
    }

    /// A 3.6 s blink cycle: open, a quick close, a short hold, then reopen.
    static func blink(at t: Double) -> Double {
        let shut = 0.07
        let p = (t / 3.6).truncatingRemainder(dividingBy: 1)
        let ease = { (x: Double) in 0.5 - 0.5 * cos(.pi * x) }
        switch p {
        case ..<0.88: return 1
        case ..<0.93: return 1 - (1 - shut) * ease((p - 0.88) / 0.05)
        case ..<0.97: return shut
        default: return shut + (1 - shut) * ease((p - 0.97) / 0.03)
        }
    }

    /// A one-shot jelly bounce: stretch, a slight squash, settle. Peaks at 1.
    static func jelly(at age: Double) -> Double {
        guard age >= 0, age < 1.2 else { return 0 }
        return exp(-5 * age) * sin(.pi * 3 * age) / 0.5
    }
}

private struct OrbRendering: View {
    let size: CGFloat
    let frame: OrbFrame

    private static let glowColor = Color(hex: 0xD63384)
    private static let rippleColor = Color(hex: 0xFF6BB3)

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(
                    stops: [
                        .init(color: Self.glowColor.opacity(frame.glow), location: 0),
                        .init(color: Self.glowColor.opacity(frame.glow), location: 0.58),
                        .init(color: Self.glowColor.opacity(frame.glow * 0.45), location: 0.72),
                        .init(color: Self.glowColor.opacity(frame.glow * 0.12), location: 0.86),
                        .init(color: Self.glowColor.opacity(0), location: 1),
                    ],
                    center: .center, startRadius: 0, endRadius: size * 0.85))
                .frame(width: size * 1.7, height: size * 1.7)
                .scaleEffect(frame.scale)

            ForEach(Array(frame.ripples.enumerated()), id: \.offset) { _, p in
                Circle()
                    .stroke(Self.rippleColor.opacity(0.55 * (1 - p)), lineWidth: max(1, size * 0.008))
                    .frame(width: size * (1 + 0.55 * p), height: size * (1 + 0.55 * p))
            }

            OrbFace(size: size, frame: frame)
                .scaleEffect(x: frame.scale * frame.stretchX, y: frame.scale * frame.stretchY)
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
    }
}

/// The sphere itself: a deep-to-pale pink radial body, film grain, a top-left
/// shine, a soft lower-right shade, and two eyes.
private struct OrbFace: View {
    let size: CGFloat
    let frame: OrbFrame

    private static let bodyStops: [Gradient.Stop] = [
        .init(color: Color(hex: 0x7A0055), location: 0),
        .init(color: Color(hex: 0xD63384), location: 0.4),
        .init(color: Color(hex: 0xFF6BB3), location: 0.68),
        .init(color: Color(hex: 0xFFE5F5), location: 1),
    ]
    private static let iris = LinearGradient(
        colors: [.white, Color(hex: 0xFFD6ED)], startPoint: .topLeading, endPoint: .bottomTrailing)

    var body: some View {
        ZStack {
            // Radii reach the farthest corner of the square, matching CSS radial gradients.
            Rectangle()
                .fill(RadialGradient(stops: Self.bodyStops, center: UnitPoint(x: 0.5, y: 0.45), startRadius: 0, endRadius: size * 0.743))

            if let grain = OrbGrain.tile {
                Image(uiImage: grain)
                    .resizable(resizingMode: .tile)
                    .blendMode(.overlay)
                    .opacity(0.28)
            }

            Rectangle()
                .fill(RadialGradient(
                    stops: [
                        .init(color: .white.opacity(0.75), location: 0),
                        .init(color: .white.opacity(0.1), location: 0.5),
                        .init(color: .white.opacity(0), location: 0.7),
                    ],
                    center: UnitPoint(x: 0.3, y: 0.24), startRadius: 0, endRadius: size * 1.033))

            Rectangle()
                .fill(RadialGradient(
                    stops: [
                        .init(color: .black.opacity(0.18), location: 0),
                        .init(color: .black.opacity(0), location: 0.55),
                    ],
                    center: UnitPoint(x: 0.62, y: 0.68), startRadius: 0, endRadius: size * 0.92))

            HStack(spacing: size * 0.22) {
                eye(open: frame.leftEye)
                eye(open: frame.rightEye)
            }
            .offset(x: size * frame.gazeX, y: size * (frame.gazeY - 0.0625))
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(.white.opacity(0.05), lineWidth: 1))
    }

    private func eye(open: Double) -> some View {
        Capsule()
            .fill(Self.iris)
            .frame(width: size * 0.125, height: size * 0.1875 * frame.eyeHeight)
            .scaleEffect(x: 1, y: open)
    }
}

/// A tile of grey film grain, made once and shared by every orb.
private enum OrbGrain {
    static let tile: UIImage? = {
        let side = 256
        let pixels = (0..<side * side).map { _ in UInt8.random(in: 0...255) }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: side,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        return UIImage(cgImage: image, scale: 2, orientation: .up)
    }()
}

#Preview("Orb states") {
    VStack(spacing: 48) {
        ForEach(OrbState.allCases, id: \.self) { state in
            HStack(spacing: 32) {
                StephOrb(size: 110, state: state)
                Text(state.rawValue).foregroundStyle(.white)
            }
        }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.black)
}
