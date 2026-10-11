import Foundation
import SwiftData

/// The only door into Recall's on-device memory. Everything leaves as Sendable
/// snapshots, so indexers, the retriever and the UI never share model objects.
@ModelActor
actor MemoryStore {
    private var cache: [Memory]?

    static func makeContainer(inMemory: Bool = false) throws -> ModelContainer {
        // SwiftData does not create Application Support on a fresh install.
        try? FileManager.default.createDirectory(at: .applicationSupportDirectory, withIntermediateDirectories: true)
        let schema = Schema(RecallSchema.models)
        let configuration = ModelConfiguration("Recall", schema: schema, isStoredInMemoryOnly: inMemory)
        return try ModelContainer(for: schema, configurations: [configuration])
    }

    // MARK: Memories

    /// Inserts or updates by id. Returns true when the memory is new.
    @discardableResult
    func upsert(_ memory: Memory) throws -> Bool {
        let inserted = try write(memory)
        try modelContext.save()
        cache = nil
        return inserted
    }

    func upsert(_ memories: [Memory]) throws -> Int {
        var inserted = 0
        for memory in memories where try write(memory) { inserted += 1 }
        try modelContext.save()
        cache = nil
        return inserted
    }

    private func write(_ memory: Memory) throws -> Bool {
        let id = memory.id
        if let existing = try modelContext.fetch(FetchDescriptor<MemoryRecord>(predicate: #Predicate { $0.id == id })).first {
            existing.update(from: memory)
            return false
        }
        modelContext.insert(MemoryRecord(memory))
        return true
    }

    func all() throws -> [Memory] {
        if let cache { return cache }
        let memories = try modelContext.fetch(FetchDescriptor<MemoryRecord>(sortBy: [SortDescriptor(\.timestamp, order: .reverse)]))
            .map(\.snapshot)
        cache = memories
        return memories
    }

    func memories(ids: [String]) throws -> [Memory] {
        let byID = Dictionary(try all().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.compactMap { byID[$0] }
    }

    func count() throws -> Int {
        try modelContext.fetchCount(FetchDescriptor<MemoryRecord>())
    }

    func missingEmbeddings(limit: Int) throws -> [Memory] {
        var descriptor = FetchDescriptor<MemoryRecord>(predicate: #Predicate { $0.embedding == nil })
        descriptor.fetchLimit = limit
        return try modelContext.fetch(descriptor).map(\.snapshot)
    }

    func setEmbeddings(_ vectors: [String: [Float]], model: String) throws {
        let ids = Array(vectors.keys)
        let records = try modelContext.fetch(FetchDescriptor<MemoryRecord>(predicate: #Predicate { ids.contains($0.id) }))
        for record in records {
            guard let vector = vectors[record.id] else { continue }
            record.embedding = Vector.data(vector)
            record.embeddingModel = model
        }
        try modelContext.save()
        cache = nil
    }

    /// Feedback nudges confidence: up when a memory helped, down when it was wrong.
    func adjustConfidence(ids: [String], helpful: Bool) throws {
        let records = try modelContext.fetch(FetchDescriptor<MemoryRecord>(predicate: #Predicate { ids.contains($0.id) }))
        for record in records {
            record.confidence = helpful ? min(1, record.confidence + 0.08) : max(0.05, record.confidence * 0.6)
        }
        try modelContext.save()
        cache = nil
    }

    func knownExternalIDs(source: String) throws -> Set<String> {
        let records = try modelContext.fetch(FetchDescriptor<MemoryRecord>(predicate: #Predicate { $0.source == source }))
        return Set(records.compactMap(\.externalID))
    }

    // MARK: People and places (graph)

    func upsert(person: Person) throws {
        let id = person.id
        if let existing = try modelContext.fetch(FetchDescriptor<PersonRecord>(predicate: #Predicate { $0.id == id })).first {
            existing.name = person.name
            existing.aliases = person.aliases
            existing.relationship = person.relationship ?? existing.relationship
            existing.birthdayMonth = person.birthdayMonth ?? existing.birthdayMonth
            existing.birthdayDay = person.birthdayDay ?? existing.birthdayDay
            existing.contactID = person.contactID ?? existing.contactID
        } else {
            modelContext.insert(PersonRecord(person))
        }
        try modelContext.save()
    }

    func people() throws -> [Person] {
        try modelContext.fetch(FetchDescriptor<PersonRecord>(sortBy: [SortDescriptor(\.name)])).map(\.snapshot)
    }

    func places() throws -> [Place] {
        try modelContext.fetch(FetchDescriptor<PlaceRecord>()).map(\.snapshot)
    }

    /// Records a visit at a place, creating it when nothing known is within 150 m.
    @discardableResult
    func recordVisit(name: String, latitude: Double, longitude: Double, at date: Date, overnight: Bool) throws -> Place {
        let all = try modelContext.fetch(FetchDescriptor<PlaceRecord>())
        let match = all.min { Geo.distance(latitude, longitude, $0.latitude, $0.longitude) < Geo.distance(latitude, longitude, $1.latitude, $1.longitude) }
        let record: PlaceRecord
        if let match, Geo.distance(latitude, longitude, match.latitude, match.longitude) < 150 {
            record = match
        } else {
            record = PlaceRecord(id: UUID().uuidString, name: name, latitude: latitude, longitude: longitude)
            modelContext.insert(record)
        }
        record.visitCount += 1
        if overnight { record.nightVisits += 1 }
        record.lastVisit = date
        try modelContext.save()
        return record.snapshot
    }

    func link(memoryID: String, kind: String, targetID: String, isDemo: Bool = false) throws {
        let id = "\(memoryID)|\(kind)|\(targetID)"
        guard try modelContext.fetchCount(FetchDescriptor<MemoryLink>(predicate: #Predicate { $0.id == id })) == 0 else { return }
        modelContext.insert(MemoryLink(memoryID: memoryID, kind: kind, targetID: targetID, isDemo: isDemo))
        try modelContext.save()
    }

    /// Memories linked to a person through the graph, newest first.
    func memories(forPerson person: Person) throws -> [Memory] {
        let personID = person.id
        let links = try modelContext.fetch(FetchDescriptor<MemoryLink>(predicate: #Predicate { $0.kind == "person" && $0.targetID == personID }))
        let linked = Set(links.map(\.memoryID))
        let names = Set(person.names)
        return try all().filter { memory in
            linked.contains(memory.id) || memory.people.contains { names.contains($0.lowercased()) }
        }
    }

    // MARK: Feedback and reminders

    func record(feedback: FeedbackRecord) throws {
        modelContext.insert(feedback)
        try modelContext.save()
    }

    func feedback(since date: Date) throws -> [(kind: String, positive: Bool, date: Date)] {
        try modelContext.fetch(FetchDescriptor<FeedbackRecord>(predicate: #Predicate { $0.date >= date }))
            .map { ($0.kind, $0.positive, $0.date) }
    }

    func save(reminder: Reminder) throws {
        let id = reminder.id
        if let existing = try modelContext.fetch(FetchDescriptor<ReminderRecord>(predicate: #Predicate { $0.id == id })).first {
            modelContext.delete(existing)
        }
        modelContext.insert(ReminderRecord(reminder))
        try modelContext.save()
    }

    func reminder(id: String) throws -> Reminder? {
        try modelContext.fetch(FetchDescriptor<ReminderRecord>(predicate: #Predicate { $0.id == id })).first?.snapshot
    }

    func reminders(from start: Date, to end: Date) throws -> [Reminder] {
        try modelContext.fetch(FetchDescriptor<ReminderRecord>(predicate: #Predicate { $0.fireDate >= start && $0.fireDate < end }))
            .map(\.snapshot)
    }

    func deleteReminders(ids: [String]) throws {
        let records = try modelContext.fetch(FetchDescriptor<ReminderRecord>(predicate: #Predicate { ids.contains($0.id) }))
        records.forEach(modelContext.delete)
        try modelContext.save()
    }

    // MARK: Demo

    func removeDemoData() throws {
        try modelContext.delete(model: MemoryRecord.self, where: #Predicate { $0.isDemo })
        try modelContext.delete(model: PersonRecord.self, where: #Predicate { $0.isDemo })
        try modelContext.delete(model: PlaceRecord.self, where: #Predicate { $0.isDemo })
        try modelContext.delete(model: MemoryLink.self, where: #Predicate { $0.isDemo })
        try modelContext.delete(model: ReminderRecord.self, where: #Predicate { $0.isDemo })
        try modelContext.save()
        cache = nil
    }

    func eraseEverything() throws {
        for model in RecallSchema.models { try modelContext.delete(model: model) }
        try modelContext.save()
        cache = nil
    }
}

enum Geo {
    /// Great-circle distance in meters.
    static func distance(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let r = 6_371_000.0
        let dLat = (lat2 - lat1) * .pi / 180
        let dLon = (lon2 - lon1) * .pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2) +
            cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * atan2(a.squareRoot(), (1 - a).squareRoot())
    }
}
