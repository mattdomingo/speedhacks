import Foundation

/// Steph's answer, in the backend's JSON shape:
/// `{"answer", "card_type", "memory_ids", "buttons"}`.
struct StephAnswer: Codable, Sendable, Equatable {
    enum CardType: String, Codable, Sendable { case answer, person, place, photo }

    var answer: String
    var cardType: CardType
    var memoryIDs: [String]
    var buttons: [String]

    enum CodingKeys: String, CodingKey {
        case answer, buttons
        case cardType = "card_type"
        case memoryIDs = "memory_ids"
    }

    init(answer: String, cardType: CardType, memoryIDs: [String], buttons: [String]) {
        self.answer = answer
        self.cardType = cardType
        self.memoryIDs = memoryIDs
        self.buttons = buttons
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        answer = try container.decode(String.self, forKey: .answer)
        cardType = (try? container.decode(CardType.self, forKey: .cardType)) ?? .answer
        memoryIDs = (try? container.decode([String].self, forKey: .memoryIDs)) ?? []
        buttons = (try? container.decode([String].self, forKey: .buttons)) ?? []
    }

    var isUnsure: Bool { answer.lowercased().contains("not sure") }
}

/// Steph's on-device fallback when the backend is unreachable. It only ever
/// repeats what a memory says; it never composes new facts.
enum LocalBrain {
    static func answer(question: String, retrieval: RetrievalResult, personMemories: [Memory] = []) -> StephAnswer {
        let words = TextTools.words(question)
        let first = words.first ?? ""

        if let person = retrieval.mentionedPeople.first, !["where", "wheres", "when"].contains(first) {
            let ids = (personMemories.isEmpty ? retrieval.memories.filter(\.personMatch).map(\.memory) : personMemories)
                .prefix(6).map(\.id)
            let lead = person.relationship.map { "\(person.name) is your \($0)." } ?? "That's \(person.name)."
            return StephAnswer(answer: "\(lead) Here's what I remember.", cardType: .person,
                               memoryIDs: Array(ids), buttons: ["Thanks!"])
        }

        guard let best = retrieval.best else {
            return StephAnswer(answer: "I'm not sure. I don't remember anything about that yet.",
                               cardType: .answer, memoryIDs: [], buttons: ["Okay"])
        }
        guard retrieval.isConfident else {
            return StephAnswer(answer: "I'm not sure. This is the closest thing I remember.",
                               cardType: .answer, memoryIDs: [best.memory.id], buttons: ["Okay"])
        }

        let memory = best.memory
        let isWhere = ["where", "wheres"].contains(first)
        let cardType: StephAnswer.CardType = switch memory.type {
        case .photo: .photo
        case .place: .place
        case .person: .person
        default: .answer
        }
        let buttons = isWhere ? [TextTools.foundLabel(for: question), "Not there"] : ["Thanks!"]
        let sentence = TextTools.secondPerson(memory.summary)
        return StephAnswer(answer: isWhere ? whereAnswer(sentence) : sentence, cardType: cardType,
                           memoryIDs: [memory.id], buttons: buttons)
    }

    /// "Your keys are on the kitchen counter…" → "On the kitchen counter…":
    /// a where-question only needs the place.
    static func whereAnswer(_ sentence: String) -> String {
        guard let match = sentence.firstMatch(of: /^Your [^,.]+? (?:are|is) ((?:on|in|at|under|next to|by|behind|inside|beside|near) .+)$/)
        else { return sentence }
        let place = String(match.output.1)
        return place.prefix(1).uppercased() + place.dropFirst()
    }

    /// What to say or do, built only from the memories' own words.
    static func reminderBody(followUpMemories: [Memory], fallback: String, now: Date) -> String {
        let lines = followUpMemories.compactMap { memory -> String? in
            guard let followUp = memory.followUp else { return nil }
            return followUp.replacingOccurrences(of: "{ago}", with: Phrases.ago(memory.timestamp, now: now))
        }
        if !lines.isEmpty { return lines.prefix(2).joined(separator: " ") }
        if let fact = followUpMemories.first {
            return "Remember: \(TextTools.secondPerson(fact.summary))"
        }
        return fallback
    }
}

extension TextTools {
    /// Turns the person's own words ("I put my passport…") into Steph's
    /// ("You put your passport…").
    static func secondPerson(_ text: String) -> String {
        var result = " " + text.trimmingCharacters(in: .whitespacesAndNewlines) + " "
        let swaps: [(String, String)] = [
            (" I'm ", " you're "), (" I am ", " you are "), (" I've ", " you've "), (" I'll ", " you'll "),
            (" I was ", " you were "), (" I ", " you "), (" my ", " your "), (" My ", " Your "),
            (" me ", " you "), (" me.", " you."), (" mine ", " yours "), (" myself ", " yourself "),
        ]
        for (from, to) in swaps { result = result.replacingOccurrences(of: from, with: to) }
        result = result.trimmingCharacters(in: .whitespaces)
        guard let first = result.first else { return result }
        return first.uppercased() + result.dropFirst()
    }
}

/// Plain words for times, the way a kid would say them.
enum Phrases {
    static func number(_ n: Int) -> String {
        let words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
        return n < words.count ? words[n] : String(n)
    }

    /// "two weeks ago", "yesterday", "3 months ago".
    static func ago(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        switch days {
        case ..<1: return "today"
        case 1: return "yesterday"
        case 2...6: return "\(number(days)) days ago"
        case 7...10: return "a week ago"
        case 11...24: return "\(number(Int((Double(days) / 7).rounded()))) weeks ago"
        case 25...45: return "a month ago"
        default:
            let months = Int((Double(days) / 30).rounded())
            return months < 12 ? "\(number(months)) months ago" : "over a year ago"
        }
    }

    /// "today", "yesterday", "on Sep 27".
    static func day(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "today" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: y) { return "yesterday" }
        if let t = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: t) { return "tomorrow" }
        return "on " + date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "3:00" / "8:12 AM".
    static func time(_ date: Date, withPeriod: Bool = true) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = withPeriod ? "h:mm a" : "h:mm"
        return formatter.string(from: date)
    }

    /// Source-line date: "TODAY 8:12 AM", "YESTERDAY 6:40 PM", "SEP 27".
    static func sourceDate(_ date: Date, now: Date, includeTime: Bool, calendar: Calendar = .current) -> String {
        let label = day(date, now: now, calendar: calendar)
        if label.hasPrefix("on ") { return String(label.dropFirst(3)) }
        return includeTime ? "\(label) \(time(date))" : label
    }
}
