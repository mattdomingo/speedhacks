import Foundation
import os

/// Talks to the Recall backend, which holds provider keys and supports Claude or Gemini.
/// Only short text memories are sent, never images.
struct StephClient: Sendable {
    enum ClientError: Error, Equatable {
        case notConfigured
        case unavailable(Int)
        case badResponse
        case rejected(Int, String?)
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
        return try await post("ask", body: body, timeout: 35)
    }

    /// Shared records require a device credential entered in Settings.
    func askConnected(question: String, memories: [Memory], credentials: MemoryCredentials,
                      excluding: Set<String> = [], now: Date = Date()) async throws -> ConnectedAnswer {
        let body = ConnectedAskBody(question: String(question.prefix(500)), now: Self.timestamp(now),
            time_zone: TimeZone.current.identifier, memories: memories.filter { !$0.isDemo }.prefix(24).map { MemoryPayload($0, now: now) },
            pin: credentials.pin.isEmpty ? nil : credentials.pin,
            excluded_ids: Array(excluding.filter { $0.hasPrefix("shared:") }.sorted().prefix(24)))
        return try await post("app/ask", body: body, timeout: 65, accessToken: credentials.token)
    }

    func checkConnection(_ credentials: MemoryCredentials) async throws {
        let response: ConnectionResponse = try await post("app/session",
            body: ConnectionBody(pin: credentials.pin.isEmpty ? nil : credentials.pin),
            timeout: 15, accessToken: credentials.token)
        guard response.connected else { throw ClientError.badResponse }
    }

    static func safeEndpoint(_ url: URL) -> Bool {
        url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost", "[::1]"].contains(url.host ?? ""))
    }

    static func connectionMessage(for error: Error) -> String {
        if case ClientError.rejected(let status, let code) = error {
            if code == "pin_required" || code == "pin_missing" { return "Enter your memory PIN in Settings." }
            if code == "pin_wrong" { return "That memory PIN did not match. Update it in Settings." }
            if code == "pin_locked" || status == 429 { return "Too many attempts. Try again in 15 minutes." }
            if status == 401 || status == 403 { return "Reconnect your memories in Settings." }
        }
        return "Your connected memories are unavailable. Please try again."
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

    private func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, timeout: TimeInterval, accessToken: String? = nil) async throws -> Response {
        let authorization = accessToken ?? token
        guard authorization.count >= 32, let baseURL, Self.safeEndpoint(baseURL) else { throw ClientError.notConfigured }
        var request = URLRequest(url: baseURL.appending(path: path), timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authorization)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        // A redirect must not replay device credentials, PINs, or memory snippets to another endpoint.
        let transport = URLSession(configuration: session.configuration,
            delegate: MemoryRedirectBlocker(), delegateQueue: nil)
        defer { transport.finishTasksAndInvalidate() }
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw ClientError.rejected(http.statusCode, error?.code)
        }
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
            if !memory.detail.isEmpty { text = String(text.prefix(300)) + " Details: " + memory.detail }
            summary = String(text.prefix(600))
            people = Array(memory.people.prefix(20)).map { String($0.prefix(100)) }
            place = memory.place.map { String($0.prefix(200)) }
            timestamp = StephClient.timestamp(memory.timestamp)
            source = String(memory.source.prefix(100))
            confidence = min(1, max(0, memory.confidence))
        }
    }

    private struct ErrorResponse: Decodable { var code: String? }
    private struct ConnectionBody: Encodable { var pin: String? }
    private struct ConnectionResponse: Decodable { var connected: Bool }
    private struct ConnectedAskBody: Encodable {
        var question: String
        var now: String
        var time_zone: String
        var memories: [MemoryPayload]
        var pin: String?
        var excluded_ids: [String]
    }

    struct ConnectedAnswer: Decodable {
        var answer: StephAnswer
        var evidence: [SharedEvidence]

        init(from decoder: Decoder) throws {
            answer = try StephAnswer(from: decoder)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            evidence = try container.decode([SharedEvidence].self, forKey: .evidence)
        }
        enum CodingKeys: String, CodingKey { case evidence }
        func memories() throws -> [Memory] { try evidence.map { try $0.memory() } }
    }

    struct SharedEvidence: Decodable {
        var id: String
        var type: String
        var summary: String
        var people: [String]
        var place: String?
        var timestamp: String
        var source: String
        var confidence: Double
        var demo: Bool

        func memory() throws -> Memory {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let dateWithFraction = formatter.date(from: timestamp)
            formatter.formatOptions = [.withInternetDateTime]
            guard !demo, id.hasPrefix("shared:"), let date = dateWithFraction ?? formatter.date(from: timestamp),
                  confidence.isFinite, (0...1).contains(confidence) else { throw ClientError.badResponse }
            return Memory(id: id, type: MemoryType(rawValue: type) ?? .note, summary: summary,
                          people: people, place: place, timestamp: date, source: source, confidence: confidence)
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

private final class MemoryRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
