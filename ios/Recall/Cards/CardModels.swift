import Foundation

/// Where a card's photo lives. Library photos are read on-device only.
enum PhotoRef: Hashable, Sendable {
    case bundle(String)
    case library(String)

    init?(assetID: String?) {
        guard let assetID else { return nil }
        if assetID.hasPrefix("bundle:") { self = .bundle(String(assetID.dropFirst(7))) } else { self = .library(assetID) }
    }
}

struct AnswerCardModel: Hashable, Sendable {
    enum Kind: Hashable, Sendable { case answer, photo, place, note }
    var kind: Kind
    var answer: String
    var photo: PhotoRef?
    /// The closest memory, shown when Steph is not sure.
    var closest: String?
    /// Plain "how I know" line: "I saw them in a photo you took today."
    var howIKnow: String?
    var sourceLine: String
    var buttons: [String]
    var memoryIDs: [String]
}

struct PersonCardModel: Hashable, Sendable {
    var name: String
    var answer: String
    /// 2–3 things worth remembering.
    var facts: [String]
    /// "Lunch with Sam Chen · Sep 20"
    var lastSeen: String?
    /// Anything you promised them.
    var promises: [String]
    var sourceLine: String
    var buttons: [String]
    var memoryIDs: [String]
}

enum CardContent: Hashable, Sendable {
    case answer(AnswerCardModel)
    case person(PersonCardModel)
    case reminder(Reminder)

    var spokenText: String {
        switch self {
        case .answer(let model): model.answer
        case .person(let model): model.answer
        case .reminder(let reminder): "\(reminder.title). \(reminder.subtitle). \(reminder.body)"
        }
    }

    var memoryIDs: [String] {
        switch self {
        case .answer(let model): model.memoryIDs
        case .person(let model): model.memoryIDs
        case .reminder(let reminder): reminder.memoryIDs
        }
    }

    var buttons: [String] {
        switch self {
        case .answer(let model): model.buttons
        case .person(let model): model.buttons
        case .reminder(let reminder): reminder.buttons
        }
    }
}

/// What a card button means, from its words.
enum CardAction: Equatable {
    case helpful, notHelpful, tellMore, ask(String)

    init(label: String) {
        let lower = label.lowercased()
        if ["not there", "wrong", "nope", "no", "not it", "that's wrong", "not right"].contains(where: lower.hasPrefix) {
            self = .notHelpful
        } else if lower.contains("tell me more") || lower.hasPrefix("more") {
            self = .tellMore
        } else if TextTools.isQuestion(label), !["thanks", "thank you", "found"].contains(where: lower.hasPrefix) {
            self = .ask(label)
        } else {
            self = .helpful
        }
    }
}
