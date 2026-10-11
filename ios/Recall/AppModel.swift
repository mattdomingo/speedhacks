import BackgroundTasks
import SwiftData
import SwiftUI

/// Everything Steph does, behind one screen.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: String { case signUp, permissions, home }

    /// What the one screen is showing.
    enum Stage: Equatable {
        case idle
        case listening
        case thinking(question: String)
        case card(question: String?, card: CardContent)
        case reminder(Reminder)

        var isConversation: Bool {
            switch self {
            case .idle, .listening: false
            default: true
            }
        }
    }

    var phase: Phase {
        didSet { UserDefaults.standard.set(phase.rawValue, forKey: "phase") }
    }
    private(set) var stage: Stage = .idle
    private(set) var orbState: OrbState = .idle
    private(set) var memoryCount = 0
    private(set) var demoMode: Bool
    var typedText = ""
    /// Shown briefly under the orb when something needs the person's attention.
    private(set) var notice: String?

    @ObservationIgnored let store: MemoryStore
    @ObservationIgnored let client = StephClient.shared
    @ObservationIgnored let embedder: ChainedEmbedder
    @ObservationIgnored let retriever: Retriever
    @ObservationIgnored let indexer: Indexer
    @ObservationIgnored let proactive: ProactiveEngine
    @ObservationIgnored let voice = Voice()
    @ObservationIgnored let listener = Listener()
    @ObservationIgnored let location = LocationWatcher()
    @ObservationIgnored let permissions: PermissionCenter
    @ObservationIgnored private var excluded: Set<String> = []
    @ObservationIgnored private var started = false

    static var bundleID: String { Bundle.main.bundleIdentifier ?? "com.speedhacks.recall" }
    static var indexTaskID: String { bundleID + ".index" }
    static var refreshTaskID: String { bundleID + ".refresh" }

    private init() {
        let arguments = ProcessInfo.processInfo.arguments
        let inMemory = arguments.contains("-RecallInMemoryStore")
        let container: ModelContainer
        do {
            container = try MemoryStore.makeContainer(inMemory: inMemory)
        } catch {
            // A broken store must not brick the app: start fresh in memory.
            container = try! MemoryStore.makeContainer(inMemory: true)
        }
        store = MemoryStore(modelContainer: container)
        embedder = ChainedEmbedder(embedders: [BackendEmbedder(client: StephClient.shared), OnDeviceEmbedder()])
        retriever = Retriever(store: store, embedder: embedder)
        indexer = Indexer(store: store, embedder: embedder)
        proactive = ProactiveEngine(store: store, client: StephClient.shared)
        permissions = PermissionCenter(location: location)
        location.store = store

        let defaults = UserDefaults.standard
        if arguments.contains("-RecallDemo") { defaults.set(true, forKey: "demoMode") }
        if arguments.contains("-RecallSkipOnboarding") { defaults.set(Phase.home.rawValue, forKey: "phase") }
        demoMode = defaults.bool(forKey: "demoMode")
        phase = Phase(rawValue: defaults.string(forKey: "phase") ?? "") ?? .signUp
        location.onLeftHome = { [weak self] in Task { await self?.leftHome() } }
    }

    var activeLevel: AudioLevel? {
        switch orbState {
        case .listening: listener.level
        case .replying: voice.level
        default: nil
        }
    }

    // MARK: Lifecycle

    func start() {
        guard phase == .home else { return }
        location.start()
        Task {
            if demoMode { try? await DemoSeed.load(into: store, embedder: OnDeviceEmbedder()) }
            await refreshCount()
            guard !started else { return }
            started = true
            await indexer.runLight()
            await refreshCount()
            if !demoMode { await proactive.plan(demoOnly: false) }
            Self.scheduleBackgroundWork()
        }
    }

    func becameActive() {
        permissions.refresh()
        Task { await refreshCount() }
    }

    func refreshCount() async {
        memoryCount = (try? await store.count()) ?? memoryCount
    }

    func finishSignUp() {
        permissions.refresh()
        phase = permissions.granted.count == PermissionKind.allCases.count ? .home : .permissions
        if phase == .home { start() }
    }

    func finishPermissions() {
        phase = .home
        start()
    }

    // MARK: Talking

    func toggleMic() {
        if stage == .listening {
            Task { await stopListeningAndSend() }
            return
        }
        voice.stop()
        Task {
            guard await listener.requestAuthorization() else {
                show(notice: "I can't hear you yet. You can type to me instead.")
                return
            }
            do {
                try listener.start()
                withAnimation(Theme.rise) { stage = .listening }
                orbState = .listening
            } catch {
                show(notice: "I can't hear you right now. You can type to me instead.")
            }
        }
    }

    private func stopListeningAndSend() async {
        orbState = .thinking
        let heard = await listener.stop()
        guard !heard.isEmpty else {
            withAnimation(Theme.rise) { stage = .idle }
            orbState = .idle
            show(notice: "I didn't catch that. Tap the mic and try again.")
            return
        }
        await send(heard)
    }

    func sendTyped() {
        let text = typedText
        typedText = ""
        Task { await send(text) }
    }

    func send(_ raw: String) async {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if listener.isListening { listener.cancel() }
        voice.stop()
        if TextTools.isQuestion(text) {
            await answer(text)
        } else {
            await remember(text)
        }
    }

    /// Ask flow: retrieve the top memories → Steph (backend Claude, or the
    /// on-device fallback) → card → spoken answer.
    func answer(_ question: String, keepExclusions: Bool = false) async {
        if !keepExclusions { excluded = [] }
        withAnimation(Theme.rise) { stage = .thinking(question: question) }
        orbState = .thinking
        let started = Date()

        let retrieval = await retriever.retrieve(question, demoOnly: demoMode, excluding: excluded)
        var person = retrieval.mentionedPeople.first
        var personMemories = person == nil ? [] : (try? await store.memories(forPerson: person!)) ?? []
        personMemories = personMemories.filter { (!demoMode || $0.isDemo) && !excluded.contains($0.id) }
        let pool = Self.unique(retrieval.memories.map(\.memory) + personMemories.prefix(8))

        var reply: StephAnswer
        if client.isConfigured, let remote = try? await client.ask(question: question, memories: Array(pool.prefix(20))) {
            reply = remote
        } else {
            reply = LocalBrain.answer(question: question, retrieval: retrieval, personMemories: personMemories)
        }
        if reply.cardType == .person, person == nil {
            person = await personBehind(reply.memoryIDs, pool: pool)
            if let person { personMemories = (try? await store.memories(forPerson: person))?.filter { !demoMode || $0.isDemo } ?? [] }
        }
        let card = CardBuilder.card(for: reply, question: question, pool: pool, person: person, personMemories: personMemories)

        // Let the orb visibly think for a beat, even when the answer is instant.
        let elapsed = Date().timeIntervalSince(started)
        if elapsed < 0.7 { try? await Task.sleep(for: .seconds(0.7 - elapsed)) }
        guard case .thinking(let current) = stage, current == question else { return }
        await present(.card(question: question, card: card), speaking: card.spokenText)
    }

    private func personBehind(_ ids: [String], pool: [Memory]) async -> Person? {
        let people = ((try? await store.people()) ?? []).filter { !demoMode || $0.isDemo }
        let names = pool.filter { ids.contains($0.id) }.flatMap(\.people)
        return names.lazy.compactMap { name in people.first { $0.names.contains(name.lowercased()) } }.first
    }

    /// Anything said or typed that isn't a question becomes a memory.
    func remember(_ text: String) async {
        let summary = TextTools.cleanedNote(text)
        let people = ((try? await store.people()) ?? []).filter { !demoMode || $0.isDemo }
        let mentioned = TextTools.mentionedPeople(in: summary, people: people)
        var tags: [String] = []
        if TextTools.isPromise(summary) { tags.append(MemoryTag.promise) }
        if TextTools.mentionsParking(summary) { tags.append(MemoryTag.parking) }
        let note = Memory(id: "note-\(UUID().uuidString)", type: .note, summary: summary, people: mentioned.map(\.name),
                          timestamp: Date(), source: "you", confidence: 0.9, tags: tags, isDemo: demoMode)
        _ = try? await store.upsert(note)
        for person in mentioned { try? await store.link(memoryID: note.id, kind: "person", targetID: person.id, isDemo: demoMode) }
        await refreshCount()
        Task { await indexer.embedPending(limit: 64) }
        let card = CardBuilder.savedNote(note)
        await present(.card(question: text, card: card), speaking: card.spokenText)
    }

    private func present(_ newStage: Stage, speaking text: String) async {
        withAnimation(Theme.rise) { stage = newStage }
        orbState = .replying
        await voice.speak(text)
        if stage == newStage { orbState = .idle }
    }

    // MARK: Cards

    func tap(_ label: String) {
        let card: CardContent
        let question: String?
        switch stage {
        case .card(let q, let c): (question, card) = (q, c)
        case .reminder(let reminder): (question, card) = (nil, .reminder(reminder))
        default: return
        }
        let kind = if case .reminder(let reminder) = card { reminder.kind.rawValue } else { "answer" }
        let ids = card.memoryIDs
        let action = CardAction(label: label)

        Task {
            switch action {
            case .helpful:
                await feedback(ids: ids, kind: kind, positive: true, label: label)
                dismiss()
            case .notHelpful:
                await feedback(ids: ids, kind: kind, positive: false, label: label)
                guard let question else { return dismiss() }
                excluded.formUnion(ids)
                await answerAgain(question)
            case .tellMore:
                await feedback(ids: ids, kind: kind, positive: true, label: label)
                if case .reminder(let reminder) = card, let name = reminder.personName {
                    await answer("Who is \(name)?")
                } else if let question {
                    await answer("Tell me more: \(question)")
                } else {
                    dismiss()
                }
            case .ask(let next):
                await answer(next)
            }
        }
    }

    /// "Not there": look again without the memories that were wrong.
    private func answerAgain(_ question: String) async {
        await answer(question, keepExclusions: true)
    }

    private func feedback(ids: [String], kind: String, positive: Bool, label: String) async {
        try? await store.adjustConfidence(ids: ids, helpful: positive)
        try? await store.record(feedback: FeedbackRecord(memoryIDs: ids, kind: kind, positive: positive, label: label))
    }

    func dismiss() {
        voice.stop()
        withAnimation(Theme.rise) { stage = .idle }
        orbState = .idle
    }

    // MARK: Reminders

    func show(_ reminder: Reminder) {
        voice.stop()
        if listener.isListening { listener.cancel() }
        Task { await present(.reminder(reminder), speaking: CardContent.reminder(reminder).spokenText) }
    }

    func openReminder(id: String) {
        Task {
            if let reminder = try? await store.reminder(id: id) { show(reminder) }
        }
    }

    /// Demo: show Priya's card now, or buzz the phone after a delay.
    func triggerDemoReminder(after delay: TimeInterval? = nil) {
        Task {
            if !demoMode { await setDemoMode(true) }
            guard var reminder = await proactive.demoReminder() else {
                show(notice: "I couldn't find the demo coffee with Priya.")
                return
            }
            if let delay {
                reminder.fireDate = Date().addingTimeInterval(delay)
                try? await store.save(reminder: reminder)
                _ = await Notifications.requestAuthorization()
                await Notifications.schedule(reminder)
            } else {
                show(reminder)
            }
        }
    }

    private func leftHome() async {
        if let reminder = await proactive.considerNow(kind: .carry, demoOnly: demoMode) {
            if UIApplication.shared.applicationState == .active { show(reminder) }
        }
    }

    // MARK: Demo mode and settings

    func setDemoMode(_ on: Bool) async {
        demoMode = on
        UserDefaults.standard.set(on, forKey: "demoMode")
        if on {
            try? await DemoSeed.load(into: store, embedder: OnDeviceEmbedder())
        } else {
            try? await store.removeDemoData()
        }
        dismiss()
        await refreshCount()
        show(notice: on ? "Demo memories are on." : "Demo memories are off.")
    }

    func toggleDemoMode() {
        Task { await setDemoMode(!demoMode) }
    }

    func indexNow() {
        Task {
            show(notice: "Looking through your phone…")
            await indexer.runLight()
            await refreshCount()
            show(notice: "Done! I'm remembering \(memoryCount.formatted()) moments.")
        }
    }

    func startOver() {
        Task {
            dismiss()
            try? await store.eraseEverything()
            UserDefaults.standard.removeObject(forKey: "appleUserID")
            demoMode = false
            UserDefaults.standard.set(false, forKey: "demoMode")
            await refreshCount()
            phase = .signUp
        }
    }

    func show(notice text: String) {
        withAnimation(.easeOut(duration: 0.2)) { notice = text }
        Task {
            try? await Task.sleep(for: .seconds(3))
            if notice == text { withAnimation(.easeOut(duration: 0.3)) { notice = nil } }
        }
    }

    // MARK: Background work

    static func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: indexTaskID, using: nil) { task in
            guard let task = task as? BGProcessingTask else { return }
            let stop = StopFlag()
            task.expirationHandler = { stop.set() }
            Task { @MainActor in
                await AppModel.shared.indexer.runHeavy(shouldStop: { stop.isSet })
                await AppModel.shared.refreshCount()
                scheduleBackgroundWork()
                task.setTaskCompleted(success: !stop.isSet)
            }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshTaskID, using: nil) { task in
            task.expirationHandler = {}
            Task { @MainActor in
                let model = AppModel.shared
                _ = await model.indexer.indexCalendar()
                if !model.demoMode { await model.proactive.plan(demoOnly: false) }
                scheduleBackgroundWork()
                task.setTaskCompleted(success: true)
            }
        }
    }

    /// Heavy indexing only while charging; proactive planning about hourly.
    static func scheduleBackgroundWork() {
        let processing = BGProcessingTaskRequest(identifier: indexTaskID)
        processing.requiresExternalPower = true
        processing.requiresNetworkConnectivity = false
        try? BGTaskScheduler.shared.submit(processing)

        let refresh = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        refresh.earliestBeginDate = Date().addingTimeInterval(3600)
        try? BGTaskScheduler.shared.submit(refresh)
    }

    private static func unique(_ memories: [Memory]) -> [Memory] {
        var seen = Set<String>()
        return memories.filter { seen.insert($0.id).inserted }
    }
}

/// Set by a background task's expiration handler, read by the indexer.
final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func set() { lock.lock(); value = true; lock.unlock() }
}
