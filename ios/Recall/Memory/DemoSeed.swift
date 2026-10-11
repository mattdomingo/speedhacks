import Foundation

/// Seeded memories for the live demo, dated relative to today so the story
/// is always true: keys this morning, coffee with Priya at 3, Sam's promise.
enum DemoSeed {
    static func medicineReminder(now: Date = Date()) -> Reminder {
        Reminder(id: "demo-reminder-medicine", kind: .promise,
                 subtitle: "Medicine reminder · Demo",
                 body: "This is your demo reminder to take your medicine.",
                 sourceLine: "DEMO · FICTIONAL REMINDER", memoryIDs: [], buttons: ["Thanks!"],
                 fireDate: now, score: 1, isDemo: true)
    }

    static let priya = Person(id: "demo-person-priya", name: "Priya", isDemo: true)
    static let sam = Person(id: "demo-person-sam", name: "Sam Chen", aliases: ["Sam"], relationship: "friend", isDemo: true)

    static func memories(now: Date = Date(), calendar: Calendar = .current) -> [Memory] {
        let today = calendar.startOfDay(for: now)
        func at(_ dayOffset: Int, _ hour: Int, _ minute: Int) -> Date {
            let day = calendar.date(byAdding: .day, value: dayOffset, to: today) ?? today
            return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
        }
        let samStartedJob = calendar.date(from: DateComponents(
            year: calendar.component(.year, from: now), month: 9, day: 15, hour: 9)) ?? at(-26, 9, 0)

        return [
            Memory(id: "demo-photo-keys", type: .photo,
                   summary: "Your keys are on the kitchen counter, next to the fruit bowl.",
                   detail: "keys keychain kitchen counter fruit bowl",
                   place: "Kitchen", timestamp: at(0, 8, 12), source: "photo", confidence: 0.92,
                   assetID: "bundle:DemoKeys", tags: ["keys"], isDemo: true),
            Memory(id: "demo-event-priya-coffee", type: .event,
                   summary: "Coffee with Priya", detail: "coffee calendar meeting",
                   people: ["Priya"], timestamp: at(0, 15, 0), endDate: at(0, 15, 45),
                   source: "calendar", confidence: 0.95, isDemo: true),
            Memory(id: "demo-note-priya-mom", type: .note,
                   summary: "Priya's mom had surgery.", detail: "mother operation hospital",
                   people: ["Priya"], timestamp: at(-14, 18, 40), source: "you", confidence: 0.9,
                   tags: [MemoryTag.fact], followUp: "Ask how her mom is doing. She had surgery {ago}.", isDemo: true),
            Memory(id: "demo-person-sam", type: .person,
                   summary: "Sam Chen is your friend.", detail: "friend contact",
                   people: ["Sam Chen"], timestamp: at(-60, 12, 0), source: "contacts", confidence: 0.95, isDemo: true),
            Memory(id: "demo-note-sam-job", type: .note,
                   summary: "Sam started a new design job in September.", detail: "work designer career",
                   people: ["Sam Chen"], timestamp: samStartedJob, source: "you", confidence: 0.9,
                   tags: [MemoryTag.fact], isDemo: true),
            Memory(id: "demo-note-sam-leo", type: .note,
                   summary: "Sam's son Leo just turned 4.", detail: "kid child birthday four",
                   people: ["Sam Chen"], timestamp: at(-21, 13, 30), source: "you", confidence: 0.9,
                   tags: [MemoryTag.fact], isDemo: true),
            Memory(id: "demo-note-sam-promise", type: .note,
                   summary: "You promised to send Sam the Tokyo ramen place.", detail: "ramen restaurant tokyo recommendation",
                   people: ["Sam Chen"], timestamp: at(-21, 13, 35), source: "you", confidence: 0.9,
                   tags: [MemoryTag.promise], followUp: "Send Sam the Tokyo ramen place.", isDemo: true),
            Memory(id: "demo-event-sam-lunch", type: .event,
                   summary: "Lunch with Sam Chen", detail: "lunch calendar meeting",
                   people: ["Sam Chen"], timestamp: at(-21, 12, 30), endDate: at(-21, 13, 45),
                   source: "calendar", confidence: 0.95, isDemo: true),
            Memory(id: "demo-place-parking", type: .place,
                   summary: "You parked on Level 3, spot 42.", detail: "car parking garage level 3 spot 42",
                   place: "Parking garage", timestamp: at(0, 7, 58), source: "location", confidence: 0.9,
                   tags: [MemoryTag.parking], isDemo: true),
        ]
    }

    static var people: [Person] { [priya, sam] }

    /// Loads the demo world into the store. Safe to call repeatedly.
    static func load(into store: MemoryStore, embedder: some Embedder, now: Date = Date()) async throws {
        var memories = memories(now: now)
        // Embed on-device right away so the demo works with no network.
        if let batch = await embedder.embed(memories.map(\.embeddingText), kind: .document) {
            for index in memories.indices {
                memories[index].embedding = batch.vectors[index]
                memories[index].embeddingModel = batch.model
            }
        }
        for person in people { try await store.upsert(person: person) }
        _ = try await store.upsert(memories)
        for memory in memories {
            for person in people where memory.people.contains(where: { person.names.contains($0.lowercased()) }) {
                try await store.link(memoryID: memory.id, kind: "person", targetID: person.id, isDemo: true)
            }
        }
    }
}
