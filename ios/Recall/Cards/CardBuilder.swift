import Foundation

/// Turns Steph's answer into a card. Every line on a card comes from a stored
/// memory (or the answer sentence itself), never from guesswork.
enum CardBuilder {
    static func card(for answer: StephAnswer, question: String, pool: [Memory], person: Person?,
                     personMemories: [Memory], now: Date = Date()) -> CardContent {
        let byID = Dictionary((pool + personMemories).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let used = answer.memoryIDs.compactMap { byID[$0] }
        let buttons = cleanButtons(answer.buttons)

        if let person, answer.cardType == .person {
            var seen = Set<String>()
            let supporting = (used + personMemories).filter { seen.insert($0.id).inserted }
            return .person(personCard(person: person, answer: answer.answer, memories: supporting,
                                      buttons: buttons, now: now))
        }

        let primary = used.first
        let kind: AnswerCardModel.Kind = switch answer.cardType {
        case .photo: .photo
        case .place: .place
        default: primary?.type == .photo ? .photo : primary?.type == .place ? .place : .answer
        }
        let unsure = answer.isUnsure
        return .answer(AnswerCardModel(
            kind: kind,
            answer: answer.answer,
            photo: unsure ? nil : PhotoRef(assetID: primary?.assetID),
            closest: unsure ? primary.map { TextTools.secondPerson($0.summary) } : nil,
            howIKnow: unsure ? nil : primary.map { howIKnow($0, question: question, now: now) },
            sourceLine: used.isEmpty && answer.memoryIDs.contains("clock-now") ? "CURRENT TIME" : sourceLine(for: used, now: now),
            buttons: buttons,
            memoryIDs: used.map(\.id)))
    }

    static func personCard(person: Person, answer: String, memories: [Memory], buttons: [String], now: Date) -> PersonCardModel {
        let sorted = memories.sorted { $0.timestamp > $1.timestamp }
        let upcoming = sorted.filter { $0.type == .event && $0.timestamp > now && $0.timestamp < now.addingTimeInterval(7 * 86_400) }
            .min { $0.timestamp < $1.timestamp }
        var facts = sorted.filter { $0.type == .note && !$0.has(MemoryTag.promise) || $0.has(MemoryTag.fact) }
            .map { TextTools.secondPerson($0.summary) }
        if let upcoming {
            facts.insert("\(upcoming.summary) \(Phrases.day(upcoming.timestamp, now: now)) at \(Phrases.time(upcoming.timestamp, withPeriod: false)).", at: 0)
        }
        let promises = sorted.filter { $0.has(MemoryTag.promise) }.map { TextTools.secondPerson($0.summary) }
        let seen = sorted.first { ($0.type == .event || $0.type == .photo) && $0.timestamp <= now }
        let lastSeen = seen.map { "\($0.summary) · \(Phrases.sourceDate($0.timestamp, now: now, includeTime: false).capitalized)" }
        let shown = Array(Set(sorted.prefix(8).map(\.id)))
        return PersonCardModel(
            name: person.name,
            answer: answer,
            facts: Array(facts.prefix(3)),
            lastSeen: lastSeen,
            promises: Array(promises.prefix(2)),
            sourceLine: sourceLine(for: Array(sorted.prefix(8)), now: now),
            buttons: buttons,
            memoryIDs: shown)
    }

    /// "PHOTO · TODAY 8:12 AM · KITCHEN" for one memory,
    /// "FROM YOUR CALENDAR + NOTE · SEP 27" for several.
    static func sourceLine(for memories: [Memory], now: Date) -> String {
        guard let first = memories.first else { return "NOTHING SAVED YET" }
        if memories.count == 1, first.id.hasPrefix("shared:") {
            let label = sharedSourceLabel(first.source)
            return "\(label) · \(Phrases.sourceDate(first.timestamp, now: now, includeTime: true))".uppercased()
        }
        if memories.contains(where: { $0.id.hasPrefix("shared:") }) {
            let labels = memories.reduce(into: [String]()) { labels, memory in
                let label = memory.id.hasPrefix("shared:") ? sharedSourceLabel(memory.source) : memory.type.sourceLabel
                if !labels.contains(label) { labels.append(label) }
            }
            let anchor = memories.filter { $0.timestamp <= now }.max { $0.timestamp < $1.timestamp } ?? first
            return "From your \(labels.joined(separator: " + ")) · \(Phrases.sourceDate(anchor.timestamp, now: now, includeTime: true))".uppercased()
        }
        let types = memories.reduce(into: [MemoryType]()) { if !$0.contains($1.type) { $0.append($1.type) } }
        if types.count == 1, memories.count == 1 {
            var parts = [first.type.sourceLabel, Phrases.sourceDate(first.timestamp, now: now, includeTime: first.type != .note && first.type != .person)]
            if let place = first.place, !place.isEmpty { parts.append(place) }
            return parts.joined(separator: " · ").uppercased()
        }
        let labels = types.map { type -> String in
            let count = memories.filter { $0.type == type }.count
            let label = type == .event ? "calendar" : type.sourceLabel.lowercased()
            return count > 1 && type != .event && type != .person ? label + "s" : label
        }
        // The date that matters is the newest supporting memory that already happened.
        let anchor = memories.filter { $0.timestamp <= now }.max { $0.timestamp < $1.timestamp } ?? first
        return "From your \(labels.joined(separator: " + ")) · \(Phrases.sourceDate(anchor.timestamp, now: now, includeTime: false))".uppercased()
    }

    static func howIKnow(_ memory: Memory, question: String, now: Date) -> String {
        let day = Phrases.day(memory.timestamp, now: now)
        if memory.id.hasPrefix("shared:") {
            switch memory.source {
            case "camera": return "Last confirmed camera sighting \(day) at \(Phrases.time(memory.timestamp))."
            case "email": return "It's in your email from \(day)."
            case "calendar": return "It's a plan on your connected calendar."
            case "call": return "It's from your call \(day)."
            case "text": return "It's from a saved message \(day)."
            default: return "It's in your connected memories from \(day)."
            }
        }
        switch memory.type {
        case .photo:
            let pronoun = TextTools.foundLabel(for: question) == "Found them!" ? "them" : "it"
            return "I saw \(pronoun) in a photo you took \(day)."
        case .note:
            return "You told me \(day)."
        case .event:
            return "It's on your calendar."
        case .place:
            return memory.has(MemoryTag.parking) ? "Your phone saved where you parked \(day)." : "Your phone saved this place \(day)."
        case .person:
            return "It's in your contacts."
        }
    }

    private static func sharedSourceLabel(_ source: String) -> String {
        switch source {
        case "camera": "Camera · last seen"
        case "email": "Email"
        case "calendar": "Calendar"
        case "call": "Call"
        case "text": "Message"
        default: "Connected memory"
        }
    }

    static func cleanButtons(_ labels: [String]) -> [String] {
        let cleaned = labels.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && $0.count <= 24 }
        return cleaned.isEmpty ? ["Thanks!"] : Array(cleaned.prefix(2))
    }

    /// Steph's confirmation after you tell her something.
    static func savedNote(_ note: Memory) -> CardContent {
        .answer(AnswerCardModel(kind: .note, answer: "Got it! I'll remember that.",
                                closest: nil, howIKnow: "“\(TextTools.secondPerson(note.summary))”",
                                sourceLine: "NOTE · JUST NOW", buttons: ["Okay"], memoryIDs: [note.id]))
    }
}
