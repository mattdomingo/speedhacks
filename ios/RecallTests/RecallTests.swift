import SwiftData
import XCTest
@testable import Recall

/// A fixed "now" matching the demo story: Saturday, Oct 11, 1:05 PM local time.
private let calendar = Calendar.current
private let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 11, hour: 13, minute: 5))!

final class TextToolsTests: XCTestCase {
    func testQuestionsAndNotes() {
        XCTAssertTrue(TextTools.isQuestion("Where are my keys?"))
        XCTAssertTrue(TextTools.isQuestion("who's Sam again"))
        XCTAssertTrue(TextTools.isQuestion("What did Priya say last time"))
        XCTAssertFalse(TextTools.isQuestion("I put my passport in the desk drawer"))
        XCTAssertFalse(TextTools.isQuestion("Remember that I parked on level 3"))
    }

    func testSecondPerson() {
        XCTAssertEqual(TextTools.secondPerson("I put my passport in the desk drawer."), "You put your passport in the desk drawer.")
        XCTAssertEqual(TextTools.secondPerson("Your keys are on the counter."), "Your keys are on the counter.")
    }

    func testCleanedNoteAndTags() {
        XCTAssertEqual(TextTools.cleanedNote("remember that the spare key is under the mat"), "The spare key is under the mat.")
        XCTAssertTrue(TextTools.isPromise("I promised to send Sam the ramen place"))
        XCTAssertTrue(TextTools.mentionsParking("I parked on level 3 spot 42"))
    }

    func testMentionedPeopleUsesFirstNamesAndContractions() {
        let people = DemoSeed.people
        XCTAssertEqual(TextTools.mentionedPeople(in: "Who's Sam again?", people: people).map(\.name), ["Sam Chen"])
        XCTAssertEqual(TextTools.mentionedPeople(in: "What did Priya say last time?", people: people).map(\.name), ["Priya"])
        XCTAssertTrue(TextTools.mentionedPeople(in: "Where are my keys?", people: people).isEmpty)
    }

    func testFoundLabel() {
        XCTAssertEqual(TextTools.foundLabel(for: "Where are my keys?"), "Found them!")
        XCTAssertEqual(TextTools.foundLabel(for: "Where is my passport?"), "Found it!")
    }

    func testAgoPhrases() {
        let twoWeeks = calendar.date(byAdding: .day, value: -14, to: now)!
        XCTAssertEqual(Phrases.ago(twoWeeks, now: now), "two weeks ago")
        XCTAssertEqual(Phrases.ago(now, now: now), "today")
        XCTAssertEqual(Phrases.ago(calendar.date(byAdding: .day, value: -1, to: now)!, now: now), "yesterday")
    }
}

final class RetrieverTests: XCTestCase {
    private let memories = DemoSeed.memories(now: now)

    private func rank(_ question: String) -> [ScoredMemory] {
        Retriever.rank(question: question, memories: memories, people: DemoSeed.people, queryVectors: [:], now: now)
    }

    func testKeysFindTheMorningPhoto() {
        XCTAssertEqual(rank("Where are my keys?").first?.memory.id, "demo-photo-keys")
    }

    func testParking() {
        XCTAssertEqual(rank("Where did I park my car?").first?.memory.id, "demo-place-parking")
    }

    func testPersonFilterPullsTheirMemories() {
        let ids = Set(rank("Who's Sam again?").prefix(5).map(\.memory.id))
        XCTAssertTrue(ids.contains("demo-note-sam-promise"))
        XCTAssertTrue(ids.contains("demo-note-sam-leo"))
    }

    func testEmbeddingSimilarityCounts() {
        var vectorMemories = memories
        for index in vectorMemories.indices {
            vectorMemories[index].embeddingModel = "test"
            vectorMemories[index].embedding = vectorMemories[index].id == "demo-note-priya-mom" ? [1, 0] : [0, 1]
        }
        let ranked = Retriever.rank(question: "how is her family", memories: vectorMemories, people: [],
                                    queryVectors: ["test": [1, 0]], now: now)
        XCTAssertEqual(ranked.first?.memory.id, "demo-note-priya-mom")
    }

    func testTimeRange() {
        let range = Retriever.timeRange(in: "what did I do today", now: now)
        XCTAssertNotNil(range)
        XCTAssertTrue(range!.contains(now))
    }
}

final class LocalBrainTests: XCTestCase {
    private func retrieval(_ question: String) -> RetrievalResult {
        let memories = DemoSeed.memories(now: now)
        let ranked = Retriever.rank(question: question, memories: memories, people: DemoSeed.people, queryVectors: [:], now: now)
        return RetrievalResult(question: question,
                               mentionedPeople: TextTools.mentionedPeople(in: question, people: DemoSeed.people),
                               memories: Array(ranked.prefix(12)))
    }

    func testKeysAnswerIsAPhotoCardWithFeedback() {
        let answer = LocalBrain.answer(question: "Where are my keys?", retrieval: retrieval("Where are my keys?"))
        XCTAssertEqual(answer.cardType, .photo)
        XCTAssertEqual(answer.memoryIDs, ["demo-photo-keys"])
        XCTAssertEqual(answer.buttons, ["Found them!", "Not there"])
        XCTAssertEqual(answer.answer, "On the kitchen counter, next to the fruit bowl.")
        XCTAssertEqual(LocalBrain.whereAnswer("You parked on Level 3, spot 42."), "You parked on Level 3, spot 42.")
    }

    func testPersonQuestionMakesPersonCard() {
        let answer = LocalBrain.answer(question: "Who's Sam again?", retrieval: retrieval("Who's Sam again?"))
        XCTAssertEqual(answer.cardType, .person)
        XCTAssertTrue(answer.answer.hasPrefix("Sam Chen is your friend."))
    }

    func testUnknownSaysNotSure() {
        let answer = LocalBrain.answer(question: "Where is my umbrella?", retrieval: retrieval("Where is my umbrella?"))
        XCTAssertTrue(answer.answer.hasPrefix("I'm not sure"))
        XCTAssertEqual(answer.memoryIDs.count, 1, "Shows the closest memory")
    }

    func testReminderBodyFillsInHowLongAgo() {
        let note = DemoSeed.memories(now: now).first { $0.id == "demo-note-priya-mom" }!
        XCTAssertEqual(LocalBrain.reminderBody(followUpMemories: [note], fallback: "", now: now),
                       "Ask how her mom is doing. She had surgery two weeks ago.")
    }

    func testAnswersFromSomethingYouSaid() {
        let note = Memory(id: "note-1", type: .note, summary: "I put my passport in the desk drawer",
                          timestamp: now.addingTimeInterval(-60), source: "you", confidence: 0.9)
        let memories = DemoSeed.memories(now: now) + [note]
        let ranked = Retriever.rank(question: "Where is my passport?", memories: memories, people: [], queryVectors: [:], now: now)
        let result = RetrievalResult(question: "Where is my passport?", mentionedPeople: [], memories: ranked)
        XCTAssertTrue(result.isConfident)
        let answer = LocalBrain.answer(question: "Where is my passport?", retrieval: result)
        XCTAssertEqual(answer.answer, "You put your passport in the desk drawer")
        XCTAssertEqual(answer.buttons, ["Found it!", "Not there"])
    }

    func testDecodesBackendJSON() throws {
        let json = #"{"answer":"On the counter.","card_type":"photo","memory_ids":["a"],"buttons":["Found them!","Not there"]}"#
        let answer = try JSONDecoder().decode(StephAnswer.self, from: Data(json.utf8))
        XCTAssertEqual(answer, StephAnswer(answer: "On the counter.", cardType: .photo, memoryIDs: ["a"], buttons: ["Found them!", "Not there"]))
        let odd = #"{"answer":"Hi","card_type":"song"}"#
        XCTAssertEqual(try JSONDecoder().decode(StephAnswer.self, from: Data(odd.utf8)).cardType, .answer)
    }
}

final class CardBuilderTests: XCTestCase {
    private let memories = DemoSeed.memories(now: now)

    func testKeysCard() {
        let answer = StephAnswer(answer: "On the kitchen counter, next to the fruit bowl.", cardType: .photo,
                                 memoryIDs: ["demo-photo-keys"], buttons: ["Found them!", "Not there"])
        guard case .answer(let card) = CardBuilder.card(for: answer, question: "Where are my keys?", pool: memories,
                                                        person: nil, personMemories: [], now: now) else {
            return XCTFail("Expected an answer card")
        }
        XCTAssertEqual(card.photo, .bundle("DemoKeys"))
        XCTAssertEqual(card.howIKnow, "I saw them in a photo you took today.")
        XCTAssertEqual(card.sourceLine, "PHOTO · TODAY 8:12 AM · KITCHEN")
    }

    func testSamPersonCard() {
        let sam = DemoSeed.sam
        let samMemories = memories.filter { $0.people.contains("Sam Chen") }
        let answer = StephAnswer(answer: "Sam Chen is your friend.", cardType: .person, memoryIDs: [], buttons: ["Thanks!"])
        guard case .person(let card) = CardBuilder.card(for: answer, question: "Who's Sam again?", pool: [],
                                                        person: sam, personMemories: samMemories, now: now) else {
            return XCTFail("Expected a person card")
        }
        XCTAssertEqual(card.name, "Sam Chen")
        XCTAssertEqual(card.promises, ["You promised to send Sam the Tokyo ramen place."])
        XCTAssertTrue(card.facts.contains("Sam's son Leo just turned 4."))
        XCTAssertTrue(card.facts.contains("Sam started a new design job in September."))
        XCTAssertEqual(card.lastSeen, "Lunch with Sam Chen · Sep 20")
    }

    func testUnsureShowsClosestMemoryAndNoPhoto() {
        let answer = StephAnswer(answer: "I'm not sure.", cardType: .answer, memoryIDs: ["demo-photo-keys"], buttons: [])
        guard case .answer(let card) = CardBuilder.card(for: answer, question: "Where is my umbrella?", pool: memories,
                                                        person: nil, personMemories: [], now: now) else {
            return XCTFail("Expected an answer card")
        }
        XCTAssertNil(card.photo)
        XCTAssertNotNil(card.closest)
        XCTAssertEqual(card.buttons, ["Thanks!"])
    }

    func testButtonsAreClampedAndClassified() {
        XCTAssertEqual(CardBuilder.cleanButtons(["  ", "A", "B", "C"]), ["A", "B"])
        XCTAssertEqual(CardAction(label: "Not there"), .notHelpful)
        XCTAssertEqual(CardAction(label: "Found them!"), .helpful)
        XCTAssertEqual(CardAction(label: "Tell me more"), .tellMore)
        XCTAssertEqual(CardAction(label: "Where's my car?"), .ask("Where's my car?"))
    }
}

final class ProactiveEngineTests: XCTestCase {
    private let memories = DemoSeed.memories(now: now)

    func testPriyaReminderMatchesTheDemoCard() throws {
        let candidate = try XCTUnwrap(ProactiveEngine.meetingCandidates(memories: memories, people: DemoSeed.people,
                                                                         now: now, calendar: calendar, horizon: 86_400).first)
        XCTAssertEqual(candidate.person?.name, "Priya")
        XCTAssertEqual(candidate.subtitle, "Coffee today at 3:00")
        XCTAssertEqual(ProactiveEngine.sourceLine(candidate, now: now), "FROM YOUR CALENDAR + NOTE · SEP 27")
        XCTAssertEqual(LocalBrain.reminderBody(followUpMemories: candidate.followUps, fallback: "", now: now),
                       "Ask how her mom is doing. She had surgery two weeks ago.")
        // An hour before 3:00 PM.
        XCTAssertEqual(calendar.component(.hour, from: candidate.fireDate), 14)
    }

    func testQuietHoursMoveToMorning() {
        let event = calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 8, minute: 30))!
        let fire = ProactiveEngine.fireDate(before: event, now: now, calendar: calendar)
        XCTAssertEqual(calendar.component(.hour, from: fire), 8)
        XCTAssertFalse(ProactiveEngine.isQuiet(fire, calendar: calendar))
        XCTAssertTrue(ProactiveEngine.isQuiet(calendar.date(bySettingHour: 22, minute: 0, second: 0, of: now)!, calendar: calendar))
    }

    func testAtMostThreeADayAndAnnoyanceLowersScore() {
        let base = ProactiveEngine.meetingCandidates(memories: memories, people: DemoSeed.people, now: now,
                                                     calendar: calendar, horizon: 86_400).first!
        let many = (0..<6).map { i -> ReminderCandidate in
            var c = base
            c.id = "c\(i)"
            c.fireDate = now.addingTimeInterval(Double(i + 1) * 600)
            return c
        }
        XCTAssertEqual(ProactiveEngine.choose(many, now: now, firedToday: 0, feedback: [], calendar: calendar).count, 3)
        XCTAssertEqual(ProactiveEngine.choose(many, now: now, firedToday: 2, feedback: [], calendar: calendar).count, 1)

        let fresh = ProactiveEngine.score(base, firedToday: 0, feedback: [])
        let annoyed = ProactiveEngine.score(base, firedToday: 0, feedback: [("meeting", false, now), ("meeting", false, now)])
        XCTAssertLessThan(annoyed, fresh)
    }

    func testPromiseAndParkingCandidates() {
        let promises = ProactiveEngine.promiseCandidates(memories: memories, people: DemoSeed.people, now: now, calendar: calendar)
        XCTAssertEqual(promises.first?.person?.name, "Sam Chen")
        let parking = ProactiveEngine.parkingCandidate(memories: memories, now: now)
        XCTAssertEqual(LocalBrain.reminderBody(followUpMemories: parking!.followUps, fallback: "", now: now),
                       "You parked on Level 3, spot 42.")
    }
}

final class MemoryStoreTests: XCTestCase {
    func testDemoSeedLoadsLinksAndRemoves() async throws {
        let store = MemoryStore(modelContainer: try MemoryStore.makeContainer(inMemory: true))
        try await DemoSeed.load(into: store, embedder: OnDeviceEmbedder(), now: now)
        let count = try await store.count()
        XCTAssertEqual(count, DemoSeed.memories(now: now).count)
        let samMemories = try await store.memories(forPerson: DemoSeed.sam)
        XCTAssertEqual(Set(samMemories.map(\.id)), ["demo-person-sam", "demo-note-sam-job", "demo-note-sam-leo",
                                                    "demo-note-sam-promise", "demo-event-sam-lunch"])

        try await store.adjustConfidence(ids: ["demo-photo-keys"], helpful: false)
        let keys = try await store.memories(ids: ["demo-photo-keys"]).first
        XCTAssertLessThan(keys?.confidence ?? 1, 0.92)

        try await store.removeDemoData()
        let remaining = try await store.count()
        XCTAssertEqual(remaining, 0)
    }

    func testRetrieverEndToEndWithStore() async throws {
        let store = MemoryStore(modelContainer: try MemoryStore.makeContainer(inMemory: true))
        try await DemoSeed.load(into: store, embedder: OnDeviceEmbedder(), now: now)
        let retriever = Retriever(store: store, embedder: ChainedEmbedder(embedders: [OnDeviceEmbedder()]))
        let result = await retriever.retrieve("Where are my keys?", now: now, demoOnly: true)
        XCTAssertEqual(result.best?.memory.id, "demo-photo-keys")
        XCTAssertTrue(result.isConfident)
    }
}

final class OrbMotionTests: XCTestCase {
    func testStatesFollowTheSpec() {
        let idle = OrbMotion.frame(state: .idle, t: 1, level: nil, reduceMotion: false)
        XCTAssertEqual(idle.glow, 0.32, accuracy: 0.001)
        XCTAssertLessThanOrEqual(abs(idle.scale - 1), 0.012 + 1e-9)

        let listening = OrbMotion.frame(state: .listening, t: 0.3, level: nil, reduceMotion: false)
        XCTAssertEqual(listening.ripples.count, 2)
        XCTAssertLessThanOrEqual(listening.scale, 1.055 + 1e-9)

        let thinking = OrbMotion.frame(state: .thinking, t: 2, level: nil, reduceMotion: false)
        XCTAssertEqual(thinking.glow, 0.45, accuracy: 0.001)

        let replying = OrbMotion.frame(state: .replying, t: 0.7, level: 1, reduceMotion: false)
        XCTAssertEqual(replying.glow, 0.75, accuracy: 0.001)
        XCTAssertLessThanOrEqual(abs(replying.scale - 1), 0.03 + 1e-9)

        let reduced = OrbMotion.frame(state: .listening, t: 0.3, level: 1, reduceMotion: true)
        XCTAssertEqual(reduced.scale, 1)
        XCTAssertTrue(reduced.ripples.isEmpty)
    }
}
