import Foundation

/// A memory with how well it matches a question.
struct ScoredMemory: Sendable, Hashable {
    var memory: Memory
    var score: Double
    var semantic: Double
    var lexical: Double
    var personMatch: Bool
}

struct RetrievalResult: Sendable {
    var question: String
    var mentionedPeople: [Person]
    var memories: [ScoredMemory]

    var best: ScoredMemory? { memories.first }

    /// True when the best match shares real meaning with the question.
    var isConfident: Bool {
        guard let best else { return false }
        return best.personMatch || best.lexical >= 0.34 || best.semantic >= 0.62
    }
}

/// Finds the dozen memories most likely to answer a question: embedding
/// similarity plus words, people and time filters, weighted by confidence.
struct Retriever: Sendable {
    let store: MemoryStore
    let embedder: ChainedEmbedder

    func retrieve(_ question: String, now: Date = Date(), limit: Int = 12, demoOnly: Bool,
                  excluding: Set<String> = []) async -> RetrievalResult {
        let memories = ((try? await store.all()) ?? [])
            .filter { (!demoOnly || $0.isDemo) && !excluding.contains($0.id) }
        let people = ((try? await store.people()) ?? []).filter { !demoOnly || $0.isDemo }

        // One query vector per embedding model the memories were stored with.
        var queryVectors: [String: [Float]] = [:]
        for model in Set(memories.compactMap(\.embeddingModel)) {
            if let vector = await embedder.embed(query: question, model: model) { queryVectors[model] = vector }
        }
        let scored = Self.rank(question: question, memories: memories, people: people,
                               queryVectors: queryVectors, now: now)
        return RetrievalResult(question: question,
                               mentionedPeople: TextTools.mentionedPeople(in: question, people: people),
                               memories: Array(scored.prefix(limit)))
    }

    /// Pure ranking, separated for tests.
    static func rank(question: String, memories: [Memory], people: [Person],
                     queryVectors: [String: [Float]], now: Date) -> [ScoredMemory] {
        let queryTerms = TextTools.expandedTerms(question)
        let mentioned = TextTools.mentionedPeople(in: question, people: people)
        let mentionedNames = Set(mentioned.flatMap(\.names))
        let range = timeRange(in: question, now: now)
        let firstWord = TextTools.words(question).first ?? ""
        let wantsLatest = ["where", "wheres"].contains(firstWord)
        let wantsUpcoming = TextTools.words(question).contains { ["next", "upcoming", "tomorrow", "later"].contains($0) }

        return memories.map { memory -> ScoredMemory in
            let memoryTerms = Set(TextTools.terms(memory.searchText))
            let matched = queryTerms.filter { !$0.isDisjoint(with: memoryTerms) }.count
            let lexical = queryTerms.isEmpty ? 0 : Double(matched) / Double(queryTerms.count)

            var semantic = 0.0
            if let model = memory.embeddingModel, let query = queryVectors[model], let vector = memory.embedding {
                semantic = max(0, Vector.cosine(query, vector))
            }

            let personMatch = !mentionedNames.isEmpty && memory.people.contains { name in
                mentionedNames.contains(name.lowercased()) ||
                    mentionedNames.contains(name.split(separator: " ").first.map { String($0).lowercased() } ?? "")
            }

            var score = 0.55 * semantic + 0.45 * lexical
            if personMatch { score += 0.45 }
            if let range, range.contains(memory.timestamp) { score += 0.2 }
            if wantsUpcoming, memory.timestamp > now { score += 0.15 }

            // Where-questions want the latest sighting; everything else gently prefers recent.
            let ageDays = max(0, now.timeIntervalSince(memory.timestamp) / 86_400)
            score += (wantsLatest ? 0.25 : 0.08) * exp(-ageDays / (wantsLatest ? 2 : 30))
            if wantsLatest, memory.type == .person { score -= 0.15 }

            score *= 0.5 + 0.5 * memory.confidence
            return ScoredMemory(memory: memory, score: score, semantic: semantic, lexical: lexical, personMatch: personMatch)
        }
        .filter { $0.score > 0.02 }
        .sorted { $0.score > $1.score }
    }

    /// "today", "yesterday", "this morning", "last week" → a date window.
    static func timeRange(in question: String, now: Date, calendar: Calendar = .current) -> DateInterval? {
        let words = Set(TextTools.words(question))
        let startOfToday = calendar.startOfDay(for: now)
        if words.contains("today") || (words.contains("this") && words.contains("morning")) {
            return DateInterval(start: startOfToday, duration: 86_400)
        }
        if words.contains("yesterday") {
            return DateInterval(start: startOfToday.addingTimeInterval(-86_400), duration: 86_400)
        }
        if words.contains("tomorrow") {
            return DateInterval(start: startOfToday.addingTimeInterval(86_400), duration: 86_400)
        }
        if words.contains("week") {
            return DateInterval(start: startOfToday.addingTimeInterval(-7 * 86_400), end: now.addingTimeInterval(7 * 86_400))
        }
        return nil
    }
}
