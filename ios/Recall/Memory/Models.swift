import Foundation
import SwiftData

enum MemoryType: String, Codable, CaseIterable, Sendable {
    case photo, event, person, place, note

    /// Label used in source lines, e.g. "PHOTO · TODAY 8:12 AM · KITCHEN".
    var sourceLabel: String {
        switch self {
        case .photo: "Photo"
        case .event: "Calendar"
        case .person: "Contacts"
        case .place: "Place"
        case .note: "Note"
        }
    }
}

/// Tags with meaning to the proactive engine and card builder.
enum MemoryTag {
    static let promise = "promise"
    static let parking = "parking"
    static let birthday = "birthday"
    static let fact = "fact"
    static let carry = "carry"
    static let home = "home"
}

// MARK: - SwiftData tables

/// One remembered moment. Mirrors the memory record
/// `{id, type, summary, people[], place, timestamp, source, confidence, embedding}`
/// plus a few local-only fields used for search and cards.
@Model
final class MemoryRecord {
    @Attribute(.unique) var id: String
    var typeRaw: String
    var summary: String
    /// Searchable extra text (Vision labels, OCR, attendees). Never shown as-is.
    var detail: String
    var people: [String]
    var place: String?
    var timestamp: Date
    var endDate: Date?
    var source: String
    var confidence: Double
    var embedding: Data?
    var embeddingModel: String?
    /// PHAsset local identifier, or "bundle:<asset name>" for demo photos.
    var assetID: String?
    var latitude: Double?
    var longitude: Double?
    var tags: [String]
    /// What to say or do next time, when known ("Ask how her mom is doing.").
    var followUp: String?
    /// Stable key from the source (event, contact, visit) so re-indexing updates in place.
    var externalID: String?
    var isDemo: Bool
    var createdAt: Date

    init(_ memory: Memory) {
        id = memory.id
        typeRaw = memory.type.rawValue
        summary = memory.summary
        detail = memory.detail
        people = memory.people
        place = memory.place
        timestamp = memory.timestamp
        endDate = memory.endDate
        source = memory.source
        confidence = memory.confidence
        embedding = memory.embedding.map(Vector.data)
        embeddingModel = memory.embeddingModel
        assetID = memory.assetID
        latitude = memory.latitude
        longitude = memory.longitude
        tags = memory.tags
        followUp = memory.followUp
        externalID = memory.externalID
        isDemo = memory.isDemo
        createdAt = Date()
    }

    func update(from memory: Memory) {
        let textChanged = snapshot.embeddingText != memory.embeddingText
        typeRaw = memory.type.rawValue
        summary = memory.summary
        detail = memory.detail
        people = memory.people
        place = memory.place
        timestamp = memory.timestamp
        endDate = memory.endDate
        source = memory.source
        assetID = memory.assetID
        latitude = memory.latitude
        longitude = memory.longitude
        tags = memory.tags
        followUp = memory.followUp
        // Keep learned confidence; re-embed changed text unless a new vector is supplied.
        if memory.embedding != nil {
            embedding = memory.embedding.map(Vector.data)
            embeddingModel = memory.embeddingModel
        } else if textChanged {
            embedding = nil
            embeddingModel = nil
        }
    }

    var snapshot: Memory {
        Memory(id: id, type: MemoryType(rawValue: typeRaw) ?? .note, summary: summary, detail: detail,
               people: people, place: place, timestamp: timestamp, endDate: endDate, source: source,
               confidence: confidence, embedding: embedding.map(Vector.floats), embeddingModel: embeddingModel,
               assetID: assetID, latitude: latitude, longitude: longitude, tags: tags, followUp: followUp,
               externalID: externalID, isDemo: isDemo)
    }
}

@Model
final class PersonRecord {
    @Attribute(.unique) var id: String
    var name: String
    var aliases: [String]
    var relationship: String?
    var birthdayMonth: Int?
    var birthdayDay: Int?
    var contactID: String?
    var isDemo: Bool

    init(_ person: Person) {
        id = person.id
        name = person.name
        aliases = person.aliases
        relationship = person.relationship
        birthdayMonth = person.birthdayMonth
        birthdayDay = person.birthdayDay
        contactID = person.contactID
        isDemo = person.isDemo
    }

    var snapshot: Person {
        Person(id: id, name: name, aliases: aliases, relationship: relationship,
               birthdayMonth: birthdayMonth, birthdayDay: birthdayDay, contactID: contactID, isDemo: isDemo)
    }
}

@Model
final class PlaceRecord {
    @Attribute(.unique) var id: String
    var name: String
    var latitude: Double
    var longitude: Double
    var visitCount: Int
    var nightVisits: Int
    var lastVisit: Date?
    var isDemo: Bool

    init(id: String, name: String, latitude: Double, longitude: Double, isDemo: Bool = false) {
        self.id = id
        self.name = name
        self.latitude = latitude
        self.longitude = longitude
        visitCount = 0
        nightVisits = 0
        self.isDemo = isDemo
    }

    var snapshot: Place {
        Place(id: id, name: name, latitude: latitude, longitude: longitude,
              visitCount: visitCount, nightVisits: nightVisits, lastVisit: lastVisit)
    }
}

/// Graph edge: memory ↔ person or memory ↔ place.
@Model
final class MemoryLink {
    @Attribute(.unique) var id: String
    var memoryID: String
    var kind: String
    var targetID: String
    var isDemo: Bool

    init(memoryID: String, kind: String, targetID: String, isDemo: Bool) {
        id = "\(memoryID)|\(kind)|\(targetID)"
        self.memoryID = memoryID
        self.kind = kind
        self.targetID = targetID
        self.isDemo = isDemo
    }
}

/// What the person told us about a card ("Thanks!", "Not there", "Found them!").
@Model
final class FeedbackRecord {
    var memoryIDs: [String]
    var kind: String
    var positive: Bool
    var label: String
    var date: Date

    init(memoryIDs: [String], kind: String, positive: Bool, label: String, date: Date = Date()) {
        self.memoryIDs = memoryIDs
        self.kind = kind
        self.positive = positive
        self.label = label
        self.date = date
    }
}

/// A proactive reminder Steph scheduled or showed.
@Model
final class ReminderRecord {
    @Attribute(.unique) var id: String
    var kind: String
    var personName: String?
    var subtitle: String
    var body: String
    var sourceLine: String
    var memoryIDs: [String]
    var buttons: [String]
    var fireDate: Date
    var score: Double
    var isDemo: Bool

    init(_ reminder: Reminder) {
        id = reminder.id
        kind = reminder.kind.rawValue
        personName = reminder.personName
        subtitle = reminder.subtitle
        body = reminder.body
        sourceLine = reminder.sourceLine
        memoryIDs = reminder.memoryIDs
        buttons = reminder.buttons
        fireDate = reminder.fireDate
        score = reminder.score
        isDemo = reminder.isDemo
    }

    var snapshot: Reminder {
        Reminder(id: id, kind: ReminderKind(rawValue: kind) ?? .meeting, personName: personName,
                 subtitle: subtitle, body: body, sourceLine: sourceLine, memoryIDs: memoryIDs,
                 buttons: buttons, fireDate: fireDate, score: score, isDemo: isDemo)
    }
}

enum RecallSchema {
    static let models: [any PersistentModel.Type] = [
        MemoryRecord.self, PersonRecord.self, PlaceRecord.self, MemoryLink.self,
        FeedbackRecord.self, ReminderRecord.self,
    ]
}

// MARK: - Sendable snapshots used outside the store

struct Memory: Sendable, Hashable, Identifiable {
    var id: String
    var type: MemoryType
    var summary: String
    var detail: String = ""
    var people: [String] = []
    var place: String?
    var timestamp: Date
    var endDate: Date?
    var source: String
    var confidence: Double = 0.8
    var embedding: [Float]?
    var embeddingModel: String?
    var assetID: String?
    var latitude: Double?
    var longitude: Double?
    var tags: [String] = []
    var followUp: String?
    var externalID: String?
    var isDemo: Bool = false

    /// Everything worth matching a question against.
    var searchText: String {
        ([summary, detail, place ?? "", followUp ?? ""] + people + tags).joined(separator: " ")
    }

    /// Text sent to the embedding model.
    var embeddingText: String {
        var parts = [summary]
        if !people.isEmpty { parts.append("People: " + people.joined(separator: ", ")) }
        if let place { parts.append("Place: " + place) }
        if !detail.isEmpty { parts.append(String(detail.prefix(400))) }
        return parts.joined(separator: ". ")
    }

    func has(_ tag: String) -> Bool { tags.contains(tag) }
}

struct Person: Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var aliases: [String] = []
    var relationship: String?
    var birthdayMonth: Int?
    var birthdayDay: Int?
    var contactID: String?
    var isDemo: Bool = false

    var firstName: String { name.split(separator: " ").first.map(String.init) ?? name }

    /// Every way a question might name this person, lowercased.
    var names: [String] {
        Array(Set(([name, firstName] + aliases).map { $0.lowercased() }.filter { $0.count > 1 }))
    }
}

struct Place: Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var latitude: Double
    var longitude: Double
    var visitCount: Int
    var nightVisits: Int
    var lastVisit: Date?
}

enum ReminderKind: String, Codable, Sendable, CaseIterable {
    case meeting, promise, birthday, parking, carry
}

/// A reminder card Steph shows first, before you forget.
struct Reminder: Sendable, Hashable, Identifiable {
    var id: String
    var kind: ReminderKind
    var personName: String?
    /// "Coffee today at 3:00"
    var subtitle: String
    /// "Ask how her mom is doing. She had surgery two weeks ago."
    var body: String
    var sourceLine: String
    var memoryIDs: [String]
    var buttons: [String]
    var fireDate: Date
    var score: Double
    var isDemo: Bool

    /// Card title: the person's first name, or a short label.
    var title: String {
        if let personName { return personName.split(separator: " ").first.map(String.init) ?? personName }
        switch kind {
        case .parking: return "Your car"
        case .carry: return "Before you go"
        default: return "Steph"
        }
    }
}

// MARK: - Vectors

enum Vector {
    static func data(_ floats: [Float]) -> Data {
        floats.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    static func floats(_ data: Data) -> [Float] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        for i in 0..<a.count {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        guard na > 0, nb > 0 else { return 0 }
        return Double(dot / (na.squareRoot() * nb.squareRoot()))
    }
}
