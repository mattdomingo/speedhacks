import Foundation
import XCTest
@testable import Recall

final class ConnectedMemoryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    func testCalendarDetailsSurviveLongTitles() throws {
        let memory = Memory(id: "event", type: .event, summary: String(repeating: "Meeting ", count: 90),
            detail: "Bring your insurance card", timestamp: now, source: "calendar")
        let payload = StephClient.MemoryPayload(memory, now: now)
        XCTAssertTrue(payload.summary.contains("Bring your insurance card"))
        XCTAssertLessThanOrEqual(payload.summary.count, 600)
    }

    func testConnectedEvidenceCarriesActualSourceAndTime() throws {
        let json = """
        {"answer":"Last seen on the desk.","card_type":"answer","memory_ids":["shared:abc"],"buttons":["Okay"],
        "evidence":[{"id":"shared:abc","type":"note","summary":"Keys on desk","people":[],
        "timestamp":"2026-10-11T19:00:00.000Z","source":"camera","confidence":1,"demo":false}]}
        """
        let response = try JSONDecoder().decode(StephClient.ConnectedAnswer.self, from: Data(json.utf8))
        let memory = try XCTUnwrap(response.memories().first)
        XCTAssertEqual(memory.source, "camera")
        XCTAssertEqual(memory.id, "shared:abc")
        let source = CardBuilder.sourceLine(for: [memory], now: now)
        XCTAssertTrue(source.contains("CAMERA · LAST SEEN"))
        XCTAssertTrue(CardBuilder.howIKnow(memory, question: "Where are my keys?", now: now).contains("Last confirmed camera sighting"))
    }

    func testMixedLocalAndSharedSourcesKeepEverySourceInEitherOrder() {
        let contact = Memory(id: "contact", type: .person, summary: "Sam", timestamp: now, source: "contacts")
        let email = Memory(id: "shared:email", type: .note, summary: "Sam's message", timestamp: now.addingTimeInterval(-3600),
                           source: "email")
        for memories in [[contact, email, email], [email, contact, email]] {
            let line = CardBuilder.sourceLine(for: memories, now: now)
            XCTAssertTrue(line.contains("CONTACTS"))
            XCTAssertTrue(line.contains("EMAIL"))
            XCTAssertFalse(line.contains("NOTE"))
            XCTAssertEqual(line.components(separatedBy: "EMAIL").count - 1, 1)
        }
    }

    func testSharedDemoEvidenceAndInvalidTimeAreRejected() throws {
        var evidence = StephClient.SharedEvidence(id: "shared:abc", type: "note", summary: "Synthetic", people: [],
            timestamp: "2026-10-11T19:00:00Z", source: "email", confidence: 1, demo: true)
        XCTAssertThrowsError(try evidence.memory())
        evidence.demo = false
        evidence.timestamp = "not-a-date"
        XCTAssertThrowsError(try evidence.memory())
    }

    func testConnectionFailureDoesNotClaimMissingMemories() {
        XCTAssertEqual(StephClient.connectionMessage(for: StephClient.ClientError.rejected(401, "pin_required")),
                       "Enter your memory PIN in Settings.")
        XCTAssertTrue(StephClient.connectionMessage(for: URLError(.timedOut)).contains("unavailable"))
        XCTAssertFalse(StephClient.connectionMessage(for: URLError(.timedOut)).contains("don't remember"))
    }

    func testProductionDeviceCredentialsRequireHTTPS() {
        XCTAssertFalse(StephClient.safeEndpoint(URL(string: "http://example.com")!))
        XCTAssertTrue(StephClient.safeEndpoint(URL(string: "https://example.com")!))
        XCTAssertTrue(StephClient.safeEndpoint(URL(string: "http://127.0.0.1:3000")!))
    }

    func testConnectedRouteUsesDeviceCredentialAndReturnsSource() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryStubProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let token = String(repeating: "d", count: 40)
        MemoryStubProtocol.respond = { request in
            XCTAssertEqual(request.url?.path, "/app/ask")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
            return (401, Data("{\"code\":\"pin_required\"}".utf8))
        }
        let client = StephClient(baseURL: URL(string: "https://memory.test"), token: "", session: session)
        let credential = MemoryCredentials(token: token, pin: "", endpoint: "https://memory.test")
        do {
            _ = try await client.askConnected(question: "Where are my keys?", memories: [], credentials: credential)
            XCTFail("Authentication failure must throw")
        } catch {
            XCTAssertEqual(error as? StephClient.ClientError, .rejected(401, "pin_required"))
        }
    }
}

private final class MemoryStubProtocol: URLProtocol, @unchecked Sendable {
    static var respond: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "memory.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let respond = Self.respond else { return }
        let (status, data) = respond(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
