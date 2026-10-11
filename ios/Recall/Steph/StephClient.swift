import Foundation
import os

/// Talks to the Recall backend, which holds every API key and proxies Claude.
/// Only short text memories are sent, never images.
struct StephClient: Sendable {
    enum ClientError: Error, Equatable {
        case notConfigured
        case unavailable(Int)
        case badResponse
    }

    let baseURL: URL?
    let token: String
    var session: URLSession = .shared

    static let shared: StephClient = {
        let info = Bundle.main.infoDictionary ?? [:]
        let base = (info["RecallAPIBaseURL"] as? String).flatMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
        let token = (info["RecallAppToken"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        return StephClient(baseURL: base?.scheme == nil ? nil : base, token: token)
    }()

    var isConfigured: Bool { baseURL != nil && token.count >= 32 }

    // MARK: Endpoints

    func ask(question: String, memories: [Memory], now: Date = Date()) async throws -> StephAnswer {
        let body = AskBody(question: String(question.prefix(500)), now: Self.timestamp(now),
                           time_zone: TimeZone.current.identifier, memories: memories.prefix(24).map { MemoryPayload($0, now: now) })
        return try await post("ask", body: body, timeout: 20)
    }

    func reminders(_ candidates: [ReminderCandidate], now: Date = Date()) async throws -> [String: StephAnswer] {
        let body = RemindersBody(now: Self.timestamp(now), time_zone: TimeZone.current.identifier,
                                 candidates: candidates.prefix(5).map { CandidatePayload($0, now: now) })
        let response: RemindersResponse = try await post("reminders", body: body, timeout: 25)
        return Dictionary(response.reminders.map { ($0.candidate_id, $0.answer) }, uniquingKeysWith: { a, _ in a })
    }

    func embed(_ texts: [String], kind: EmbeddingKind) async throws -> EmbeddingBatch {
        let body = EmbedBody(texts: texts.map { String($0.prefix(2000)) }, input_type: kind.rawValue)
        let response: EmbedResponse = try await post("embed", body: body, timeout: 15)
        guard response.embeddings.count == texts.count else { throw ClientError.badResponse }
        return EmbeddingBatch(model: response.model, vectors: response.embeddings)
    }

    // MARK: Transport

    private func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, timeout: TimeInterval) async throws -> Response {
        guard isConfigured, let baseURL else { throw ClientError.notConfigured }
        var request = URLRequest(url: baseURL.appending(path: path), timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw ClientError.unavailable(http.statusCode) }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    // MARK: Wire types (snake_case to match the backend contract)

    struct MemoryPayload: Encodable {
        var id: String
        var type: String
        var summary: String
        var people: [String]
        var place: String?
        var timestamp: String
        var source: String
        var confidence: Double

        init(_ memory: Memory, now: Date) {
            id = memory.id
            type = memory.type.rawValue
            var text = memory.summary
            if let followUp = memory.followUp {
                text += " Next time: " + followUp.replacingOccurrences(of: "{ago}", with: Phrases.ago(memory.timestamp, now: now))
            }
            if memory.type == .photo, !memory.detail.isEmpty { text += " Seen in photo: " + memory.detail }
            summary = String(text.prefix(600))
            people = Array(memory.people.prefix(20)).map { String($0.prefix(100)) }
            place = memory.place.map { String($0.prefix(200)) }
            timestamp = StephClient.timestamp(memory.timestamp)
            source = String(memory.source.prefix(100))
            confidence = min(1, max(0, memory.confidence))
        }
    }

    struct AskBody: Encodable {
        var question: String
        var now: String
        var time_zone: String
        var memories: [MemoryPayload]
    }

    struct CandidatePayload: Encodable {
        var id: String
        var kind: String
        var title: String
        var when: String?
        var person: String?
        var memories: [MemoryPayload]

        init(_ candidate: ReminderCandidate, now: Date) {
            id = candidate.id
            kind = candidate.kind.rawValue
            title = String(candidate.title.prefix(300))
            when = candidate.when.map(StephClient.timestamp)
            person = candidate.person?.name
            memories = candidate.memories.prefix(12).map { MemoryPayload($0, now: now) }
        }
    }

    struct RemindersBody: Encodable {
        var now: String
        var time_zone: String
        var candidates: [CandidatePayload]
    }

    struct RemindersResponse: Decodable {
        struct Item: Decodable {
            var candidate_id: String
            var answer: StephAnswer

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                candidate_id = try container.decode(String.self, forKey: .candidate_id)
                answer = try StephAnswer(from: decoder)
            }

            enum CodingKeys: String, CodingKey { case candidate_id }
        }
        var reminders: [Item]
    }

    struct EmbedBody: Encodable {
        var texts: [String]
        var input_type: String
    }

    struct EmbedResponse: Decodable {
        var model: String
        var embeddings: [[Float]]
    }
}

/// Uses the backend's embedding model, and backs off for a while after the
/// backend says embeddings are unavailable.
final class BackendEmbedder: Embedder, Sendable {
    private let client: StephClient
    private let pausedUntil = OSAllocatedUnfairLock(initialState: Date.distantPast)

    init(client: StephClient) { self.client = client }

    func embed(_ texts: [String], kind: EmbeddingKind) async -> EmbeddingBatch? {
        guard client.isConfigured, !texts.isEmpty, Date() >= pausedUntil.withLock({ $0 }) else { return nil }
        do {
            return try await client.embed(texts, kind: kind)
        } catch {
            pausedUntil.withLock { $0 = Date().addingTimeInterval(600) }
            return nil
        }
    }
}
