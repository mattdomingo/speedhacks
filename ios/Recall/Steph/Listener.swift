import AVFoundation
import Speech

/// Turns what you say into text with Apple Speech, on the phone when the
/// device supports it. The microphone is only on between two taps.
@MainActor
final class Listener {
    enum ListenerError: Error { case notAllowed, unavailable }

    let level = AudioLevel()
    private(set) var transcript = ""
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalResult: CheckedContinuation<Void, Never>?
    private(set) var isListening = false

    func requestAuthorization() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        guard let recognizer, recognizer.isAvailable else { throw ListenerError.unavailable }
        stopEngine()
        transcript = ""
        try AudioSessions.activateForListening()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .search
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw ListenerError.unavailable }
        let level = self.level
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            level.set(AudioLevel.normalized(rms: buffer.rms))
        }
        engine.prepare()
        try engine.start()
        isListening = true

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            Task { @MainActor in
                guard let self else { return }
                if let text, !text.isEmpty { self.transcript = text }
                if isFinal || error != nil {
                    self.finalResult?.resume()
                    self.finalResult = nil
                }
            }
        }
    }

    /// Stops listening and returns what was heard.
    func stop() async -> String {
        guard isListening else { return transcript }
        stopEngine()
        request?.endAudio()
        // Give the recognizer a moment to finish the last words.
        await withCheckedContinuation { continuation in
            finalResult = continuation
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1500))
                self.finalResult?.resume()
                self.finalResult = nil
            }
        }
        task?.cancel()
        task = nil
        request = nil
        return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        stopEngine()
        task?.cancel()
        task = nil
        request = nil
        finalResult?.resume()
        finalResult = nil
    }

    private func stopEngine() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        isListening = false
        level.reset()
    }
}
