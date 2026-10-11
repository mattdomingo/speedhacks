import Foundation

/// Small, dependable language helpers: tokenizing, synonyms, and telling a
/// question apart from something you want Steph to remember.
enum TextTools {
    static let stopwords: Set<String> = [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "i", "me", "my", "mine", "you", "your",
        "yours", "we", "our", "it", "its", "of", "to", "in", "on", "at", "for", "with", "and", "or", "but", "so",
        "do", "does", "did", "what", "where", "who", "whos", "when", "why", "how", "which", "that", "this", "these",
        "those", "again", "please", "steph", "can", "could", "would", "should", "will", "just", "about", "tell",
        "remind", "there", "here", "have", "has", "had", "s", "re", "ll", "d", "last", "time", "say", "said",
        "him", "her", "his", "she", "he", "they", "them", "their", "up", "from", "by", "as", "if", "then", "than",
        "any", "some", "all", "know", "remember", "put", "left", "today", "yesterday", "now", "get", "got",
        "hey", "hi", "hello",
    ]

    /// Words that mean the same thing for finding memories.
    static let synonyms: [String: [String]] = [
        "key": ["keychain", "keys"],
        "car": ["parked", "parking", "vehicle", "garage"],
        "park": ["parked", "parking", "car", "garage"],
        "mom": ["mother", "mum", "mama"],
        "dad": ["father", "papa"],
        "passport": ["travel", "document"],
        "wallet": ["purse", "cards"],
        "phone": ["iphone"],
        "glasses": ["spectacles", "sunglasses"],
        "birthday": ["born", "bday"],
        "promise": ["promised", "owe", "send"],
        "coffee": ["cafe", "espresso", "latte"],
        "lunch": ["meal", "restaurant"],
        "kid": ["son", "daughter", "child"],
        "son": ["kid", "child", "boy"],
        "daughter": ["kid", "child", "girl"],
        "job": ["work", "career"],
    ]

    static func words(_ text: String) -> [String] {
        text.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    /// Light stemming: plural and simple verb endings.
    static func stem(_ word: String) -> String {
        guard word.count > 3 else { return word }
        for suffix in ["ies", "ing", "ed", "es", "s"] where word.hasSuffix(suffix) {
            let base = String(word.dropLast(suffix.count))
            if suffix == "ies" { return base + "y" }
            if suffix == "es", !(base.hasSuffix("s") || base.hasSuffix("x") || base.hasSuffix("ch") || base.hasSuffix("sh")) {
                return String(word.dropLast(1))
            }
            if base.count >= 3 { return base }
        }
        return word
    }

    /// Content terms of a text, stemmed and without stopwords.
    static func terms(_ text: String) -> [String] {
        words(text).filter { !stopwords.contains($0) && $0.count > 1 }.map(stem)
    }

    /// Each question term with its synonyms. A term matches a memory when the
    /// memory contains the term or any of its synonyms.
    static func expandedTerms(_ text: String) -> [Set<String>] {
        var seen = Set<String>()
        return terms(text).filter { seen.insert($0).inserted }.map { term in
            Set([term] + (synonyms[term] ?? []).map(stem))
        }
    }

    static let questionStarters: Set<String> = [
        "where", "what", "whats", "who", "whos", "when", "why", "how", "which", "whose", "is", "are", "was", "were",
        "do", "does", "did", "can", "could", "should", "will", "would", "have", "has", "had", "tell", "remind",
        "show", "find", "any", "anything", "help",
    ]

    /// True when the person is asking Steph something rather than telling her
    /// something to remember.
    static func isQuestion(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasSuffix("?") { return true }
        let first = intentWords(trimmed).first ?? ""
        if first == "remember" || first == "note" { return false }
        return questionStarters.contains(first)
    }

    /// Ignore conversational addressing before classifying a spoken request.
    static func intentWords(_ text: String) -> [String] {
        var tokens = words(text)[...]
        if let first = tokens.first, ["hey", "hi", "hello"].contains(first) { tokens = tokens.dropFirst() }
        if tokens.first == "steph" { tokens = tokens.dropFirst() }
        if tokens.first == "please" { tokens = tokens.dropFirst() }
        return Array(tokens)
    }

    /// A name alone does not make a specific factual question a profile request.
    static func isPersonProfileQuestion(_ question: String, person: Person) -> Bool {
        var tokens = intentWords(question)
        while let last = tokens.last, ["again", "please"].contains(last) { tokens.removeLast() }
        let prefixes = [["who", "is"], ["who", "s"], ["whos"], ["tell", "me", "about"],
                        ["what", "do", "you", "know", "about"]]
        return prefixes.contains { prefix in
            guard tokens.starts(with: prefix) else { return false }
            let subject = Array(tokens.dropFirst(prefix.count))
            return person.names.contains { words($0) == subject }
        }
    }

    /// Strips "remember that" style lead-ins from a note.
    static func cleanedNote(_ text: String) -> String {
        var note = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["remember that ", "remember ", "note that ", "note: ", "steph, ", "hey steph, "]
            where note.lowercased().hasPrefix(prefix) {
            note = String(note.dropFirst(prefix.count))
        }
        guard let first = note.first else { return note }
        if let last = note.last, !".!?".contains(last) { note += "." }
        return first.uppercased() + note.dropFirst()
    }

    /// Phrases that turn a note into a promise you made.
    static func isPromise(_ text: String) -> Bool {
        let lower = text.lowercased()
        return ["promised", "i'll send", "i will send", "i owe", "i'll bring", "i will bring", "i'll call", "i said i'd", "i told"]
            .contains { lower.contains($0) } && !lower.contains("?")
    }

    static func mentionsParking(_ text: String) -> Bool {
        let w = Set(words(text))
        return !w.isDisjoint(with: ["parked", "parking", "garage"]) || (w.contains("level") && w.contains("spot"))
    }

    /// People named in a text, from the people Steph already knows.
    static func mentionedPeople(in text: String, people: [Person]) -> [Person] {
        let lower = " " + words(text).joined(separator: " ") + " "
        return people.filter { person in
            person.names.contains { name in lower.contains(" " + words(name).joined(separator: " ") + " ") }
        }
    }

    /// Plural objects get "Found them!", single ones "Found it!".
    static func foundLabel(for question: String) -> String {
        let nouns = terms(question)
        let plural = words(question).contains { word in
            word.count > 3 && word.hasSuffix("s") && !word.hasSuffix("ss") && nouns.contains(stem(word))
                && !["glass", "is", "was", "has"].contains(word)
        }
        return plural ? "Found them!" : "Found it!"
    }
}
