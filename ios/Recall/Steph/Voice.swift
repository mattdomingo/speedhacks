import AVFoundation

/// Steph's voice: a warm female system voice. Speech is rendered to buffers
/// and played through an audio engine so the orb can follow the real level.
@MainActor
final class Voice: NSObject {
    let level = AudioLevel()
    private let synthesizer = AVSpeechSynthesizer()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playback: Playback?
    private var connectedFormat: AVAudioFormat?
    private var fallbackContinuation: CheckedContinuation<Void, Never>?
    var isMuted = false

    override init() {
        super.init()
        synthesizer.delegate = self
        engine.attach(player)
    }

    static let voice: AVSpeechSynthesisVoice? = {
        let preferred = ["Ava", "Zoe", "Samantha", "Allison", "Nicky", "Susan", "Joelle", "Serena", "Karen", "Moira"]
        let english = AVSpeechSynthesisVoice.speechVoices().filter { voice in
            voice.language.hasPrefix("en") && !voice.voiceTraits.contains(.isNoveltyVoice)
                && !voice.voiceTraits.contains(.isPersonalVoice)
        }
        func rank(_ voice: AVSpeechSynthesisVoice) -> (Int, Int, Int, Int) {
            let quality = voice.quality == .premium ? 0 : voice.quality == .enhanced ? 1 : 2
            let gender = voice.gender == .female ? 0 : voice.gender == .unspecified ? 1 : 2
            let locale = voice.language == "en-US" ? 0 : 1
            let name = preferred.firstIndex { voice.name.hasPrefix($0) } ?? preferred.count
            return (gender, quality, name, locale)
        }
        return english.min { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: "en-US")
    }()

    private func utterance(_ text: String) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice
        utterance.rate = 0.47
        utterance.pitchMultiplier = 1.05
        utterance.postUtteranceDelay = 0.05
        return utterance
    }

    /// Speaks and returns when Steph has finished (or was interrupted).
    func speak(_ text: String) async {
        stop()
        guard !isMuted, !text.isEmpty else { return }
        AudioSessions.activateForSpeaking()
        do {
            try await speakThroughEngine(text)
        } catch {
            await speakDirectly(text)
        }
        level.reset()
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        playback?.finish()
        playback = nil
        player.stop()
        fallbackContinuation?.resume()
        fallbackContinuation = nil
        level.reset()
    }

    // MARK: Engine path (real levels)

    private func speakThroughEngine(_ text: String) async throws {
        let playback = Playback()
        self.playback = playback
        installMeter()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            playback.onDone = { result in continuation.resume(with: result) }
            synthesizer.write(utterance(text)) { [weak self] buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                // Buffers must stay in order; the main queue is FIFO.
                let deliver: () -> Void = { MainActor.assumeIsolated { self?.enqueue(pcm, playback: playback) } }
                if Thread.isMainThread { deliver() } else { DispatchQueue.main.async { deliver() } }
            }
        }
    }

    private func enqueue(_ buffer: AVAudioPCMBuffer, playback: Playback) {
        guard self.playback === playback, !playback.isFinished else { return }
        if buffer.frameLength == 0 {
            playback.markLastBuffer()
            return
        }
        guard let playable = Self.standardized(buffer) else {
            playback.fail(VoiceError.format)
            return
        }
        do {
            if connectedFormat != playable.format {
                engine.stop()
                engine.disconnectNodeOutput(player)
                engine.connect(player, to: engine.mainMixerNode, format: playable.format)
                connectedFormat = playable.format
            }
            if !engine.isRunning { try engine.start() }
            if !player.isPlaying { player.play() }
        } catch {
            playback.fail(error)
            return
        }
        playback.scheduled()
        player.scheduleBuffer(playable, completionCallbackType: .dataPlayedBack) { _ in
            playback.played()
        }
    }

    private func installMeter() {
        let mixer = engine.mainMixerNode
        mixer.removeTap(onBus: 0)
        let level = self.level
        mixer.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
            level.set(AudioLevel.normalized(rms: buffer.rms))
        }
    }

    /// Converts synthesizer output (often 16-bit) to the float format engines expect.
    private static func standardized(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let source = buffer.format
        if source.commonFormat == .pcmFormatFloat32, !source.isInterleaved { return buffer }
        guard let target = AVAudioFormat(standardFormatWithSampleRate: source.sampleRate, channels: source.channelCount),
              let converter = AVAudioConverter(from: source, to: target),
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: buffer.frameLength) else { return nil }
        do {
            try converter.convert(to: output, from: buffer)
            return output
        } catch {
            return nil
        }
    }

    // MARK: Fallback path (system playback, level from word boundaries)

    private func speakDirectly(_ text: String) async {
        engine.stop()
        await withCheckedContinuation { continuation in
            fallbackContinuation = continuation
            synthesizer.speak(utterance(text))
        }
    }

    enum VoiceError: Error { case format }
}

extension Voice: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange,
                                       utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.fallbackContinuation != nil else { return }
            self.level.set(0.55 + Float.random(in: 0...0.35))
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.fallbackContinuation?.resume()
            self.fallbackContinuation = nil
        }
    }
}

/// Tracks one utterance's buffers so we know when the last one has played.
private final class Playback: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = 0
    private var lastBufferSeen = false
    private(set) var isFinished = false
    var onDone: ((Result<Void, Error>) -> Void)?

    func scheduled() {
        lock.lock(); pending += 1; lock.unlock()
    }

    func played() {
        lock.lock()
        pending -= 1
        let done = lastBufferSeen && pending <= 0
        lock.unlock()
        if done { complete(.success(())) }
    }

    func markLastBuffer() {
        lock.lock()
        lastBufferSeen = true
        let done = pending <= 0
        lock.unlock()
        if done { complete(.success(())) }
    }

    func fail(_ error: Error) { complete(.failure(error)) }
    func finish() { complete(.success(())) }

    private func complete(_ result: Result<Void, Error>) {
        lock.lock()
        guard !isFinished else { lock.unlock(); return }
        isFinished = true
        let callback = onDone
        onDone = nil
        lock.unlock()
        callback?(result)
    }
}

extension AVAudioPCMBuffer {
    /// Root-mean-square of the first channel.
    var rms: Float {
        let frames = Int(frameLength)
        guard frames > 0 else { return 0 }
        if let data = floatChannelData?[0] {
            var sum: Float = 0
            for i in 0..<frames { sum += data[i] * data[i] }
            return (sum / Float(frames)).squareRoot()
        }
        if let data = int16ChannelData?[0] {
            var sum: Float = 0
            for i in 0..<frames {
                let sample = Float(data[i]) / Float(Int16.max)
                sum += sample * sample
            }
            return (sum / Float(frames)).squareRoot()
        }
        return 0
    }
}

/// One place for audio session setup so speaking and listening agree.
enum AudioSessions {
    static func activateForSpeaking() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .duckOthers])
        try? session.setActive(true)
    }

    static func activateForListening() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }
}
