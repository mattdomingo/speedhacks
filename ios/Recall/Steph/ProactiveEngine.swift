import Foundation
@preconcurrency import UserNotifications

/// Something Steph could say before you forget.
struct ReminderCandidate: Sendable, Identifiable {
    var id: String
    var kind: ReminderKind
    var person: Person?
    /// The event or topic, e.g. "Coffee with Priya".
    var title: String
    /// "Coffee today at 3:00"
    var subtitle: String
    var when: Date?
    /// The event first, then the memories that make the reminder useful.
    var memories: [Memory]
    /// Memories whose own words say what to do next.
    var followUps: [Memory]
    var fireDate: Date
    var usefulness: Double
    var timeliness: Double

    var confidence: Double { memories.map(\.confidence).min() ?? 0.5 }
}

/// Decides when Steph speaks first. Runs hourly and plans a reminder an hour
/// before each calendar event, scored by usefulness × timeliness × confidence
/// minus annoyance. At most 3 a day, never during quiet hours (9pm–8am).
struct ProactiveEngine: Sendable {
    static let maxPerDay = 3
    static let quietStartHour = 21
    static let quietEndHour = 8
    static let threshold = 0.3
    static let notificationPrefix = "recall.reminder."

    let store: MemoryStore
    let client: StephClient
    var calendar: Calendar = .current

    // MARK: Planning

    /// Plans the next 24 hours: scores candidates, phrases the winners, saves
    /// them and schedules their notifications.
    @discardableResult
    func plan(now: Date = Date(), demoOnly: Bool) async -> [Reminder] {
        let memories = ((try? await store.all()) ?? []).filter { !demoOnly || $0.isDemo }
        let people = ((try? await store.people()) ?? []).filter { !demoOnly || $0.isDemo }
        let feedback = (try? await store.feedback(since: now.addingTimeInterval(-14 * 86_400))) ?? []
        let startOfDay = calendar.startOfDay(for: now)
        let firedToday = ((try? await store.reminders(from: startOfDay, to: now)) ?? []).count
        // Never repeat a reminder that already went out.
        let delivered = Set(((try? await store.reminders(from: now.addingTimeInterval(-3 * 86_400), to: now)) ?? []).map(\.id))

        let candidates = Self.candidates(memories: memories, people: people, now: now, calendar: calendar)
            .filter { !delivered.contains($0.id) }
        let chosen = Self.choose(candidates, now: now, firedToday: firedToday, feedback: feedback, calendar: calendar)
        guard !chosen.isEmpty else { return [] }

        let phrased = await phrase(chosen.map(\.candidate), now: now)
        var reminders: [Reminder] = []
        for (candidate, score) in chosen {
            let reminder = makeReminder(candidate, body: phrased[candidate.id], score: score, now: now, isDemo: demoOnly)
            try? await store.save(reminder: reminder)
            reminders.append(reminder)
        }
        await Notifications.replacePending(with: reminders, now: now)
        return reminders
    }

    /// Explicitly previews the seeded coffee plan, even after its scheduled time.
    /// Normal reminder planning still considers only upcoming events.
    func demoReminder(now: Date = Date()) async -> Reminder? {
        let memories = ((try? await store.all()) ?? []).filter(\.isDemo)
        let people = ((try? await store.people()) ?? []).filter(\.isDemo)
        guard let event = memories.first(where: { $0.id == "demo-event-priya-coffee" && $0.type == .event }) else { return nil }
        let selectionTime = min(now, event.timestamp.addingTimeInterval(-1))
        guard var candidate = Self.meetingCandidates(memories: memories, people: people, now: selectionTime, calendar: calendar,
                                                     horizon: 36 * 3600).first(where: { $0.id == "meeting-\(event.id)" }),
              let person = candidate.person else { return nil }
        candidate.subtitle = (event.timestamp <= now ? "Planned: " : "") + Self.meetingSubtitle(event, person: person, now: now, calendar: calendar)
        candidate.fireDate = now
        let reminder = makeReminder(candidate, body: nil, score: 1, now: now, isDemo: true)
        try? await store.save(reminder: reminder)
        return reminder
    }

    /// Location-driven moments (left home, walked back toward the car).
    func considerNow(kind: ReminderKind, now: Date = Date(), demoOnly: Bool) async -> Reminder? {
        guard !Self.isQuiet(now, calendar: calendar) else { return nil }
        let startOfDay = calendar.startOfDay(for: now)
        let firedToday = ((try? await store.reminders(from: startOfDay, to: now)) ?? []).count
        guard firedToday < Self.maxPerDay else { return nil }
        let memories = ((try? await store.all()) ?? []).filter { !demoOnly || $0.isDemo }
        let candidate: ReminderCandidate? = switch kind {
        case .parking: Self.parkingCandidate(memories: memories, now: now)
        case .carry: Self.carryCandidate(memories: memories, now: now)
        default: nil
        }
        guard let candidate else { return nil }
        let feedback = (try? await store.feedback(since: now.addingTimeInterval(-14 * 86_400))) ?? []
        let score = Self.score(candidate, firedToday: firedToday, feedback: feedback)
        guard score >= Self.threshold else { return nil }
        let reminder = makeReminder(candidate, body: nil, score: score, now: now, isDemo: demoOnly)
        try? await store.save(reminder: reminder)
        await Notifications.schedule(reminder, now: now)
        return reminder
    }

    private func phrase(_ candidates: [ReminderCandidate], now: Date) async -> [String: String] {
        guard client.isConfigured, !candidates.isEmpty else { return [:] }
        let answers = (try? await client.reminders(candidates, now: now)) ?? [:]
        return answers.compactMapValues { $0.isUnsure ? nil : $0.answer }
    }

    private func makeReminder(_ candidate: ReminderCandidate, body: String?, score: Double, now: Date, isDemo: Bool) -> Reminder {
        let local = LocalBrain.reminderBody(followUpMemories: candidate.followUps, fallback: candidate.subtitle, now: now)
        return Reminder(
            id: candidate.id, kind: candidate.kind, personName: candidate.person?.name,
            subtitle: candidate.subtitle, body: body ?? local,
            sourceLine: Self.sourceLine(candidate, now: now),
            memoryIDs: candidate.memories.map(\.id),
            buttons: candidate.person == nil ? ["Thanks!"] : ["Thanks!", "Tell me more"],
            fireDate: candidate.fireDate, score: score, isDemo: isDemo)
    }

    // MARK: Candidates (pure, for tests)

    static func candidates(memories: [Memory], people: [Person], now: Date, calendar: Calendar) -> [ReminderCandidate] {
        meetingCandidates(memories: memories, people: people, now: now, calendar: calendar, horizon: 24 * 3600)
            + promiseCandidates(memories: memories, people: people, now: now, calendar: calendar)
            + birthdayCandidates(people: people, memories: memories, now: now, calendar: calendar)
    }

    /// Upcoming meeting + what they told you last time.
    static func meetingCandidates(memories: [Memory], people: [Person], now: Date, calendar: Calendar,
                                  horizon: TimeInterval) -> [ReminderCandidate] {
        let events = memories.filter { $0.type == .event && $0.timestamp > now && $0.timestamp <= now.addingTimeInterval(horizon) }
            .sorted { $0.timestamp < $1.timestamp }
        return events.compactMap { event in
            guard let person = TextTools.mentionedPeople(in: event.people.joined(separator: " ") + " " + event.summary, people: people).first
            else { return nil }
            let names = Set(person.names)
            let about = memories.filter { memory in
                memory.id != event.id && memory.type != .event && memory.timestamp <= now &&
                    memory.timestamp > now.addingTimeInterval(-90 * 86_400) &&
                    memory.people.contains { names.contains($0.lowercased()) }
            }
            let followUps = about.filter { $0.followUp != nil || $0.has(MemoryTag.fact) || $0.has(MemoryTag.promise) }
                .sorted { ($0.followUp != nil ? 1 : 0, $0.timestamp) > ($1.followUp != nil ? 1 : 0, $1.timestamp) }
            guard !followUps.isEmpty else { return nil }
            return ReminderCandidate(
                id: "meeting-\(event.id)", kind: .meeting, person: person, title: event.summary,
                subtitle: meetingSubtitle(event, person: person, now: now, calendar: calendar),
                when: event.timestamp, memories: [event] + followUps.prefix(4), followUps: Array(followUps.prefix(2)),
                fireDate: fireDate(before: event.timestamp, now: now, calendar: calendar),
                usefulness: followUps.contains { $0.followUp != nil } ? 0.95 : 0.75, timeliness: 1)
        }
    }

    /// A promise you made that is still open.
    static func promiseCandidates(memories: [Memory], people: [Person], now: Date, calendar: Calendar) -> [ReminderCandidate] {
        memories.filter { $0.has(MemoryTag.promise) && now.timeIntervalSince($0.timestamp) > 86_400 && now.timeIntervalSince($0.timestamp) < 30 * 86_400 }
            .compactMap { promise in
                let person = TextTools.mentionedPeople(in: promise.people.joined(separator: " ") + " " + promise.summary, people: people).first
                let age = now.timeIntervalSince(promise.timestamp) / 86_400
                return ReminderCandidate(
                    id: "promise-\(promise.id)-\(dayKey(now, calendar: calendar))", kind: .promise, person: person,
                    title: promise.summary, subtitle: "You made a promise \(Phrases.ago(promise.timestamp, now: now))",
                    when: nil, memories: [promise], followUps: [promise],
                    fireDate: nextWaking(after: now, hour: 10, calendar: calendar),
                    usefulness: 0.7, timeliness: min(1, 0.4 + age / 14))
            }
    }

    /// Birthdays within 3 days.
    static func birthdayCandidates(people: [Person], memories: [Memory], now: Date, calendar: Calendar) -> [ReminderCandidate] {
        people.compactMap { person in
            guard let month = person.birthdayMonth, let day = person.birthdayDay else { return nil }
            let today = calendar.startOfDay(for: now)
            guard let next = calendar.nextDate(after: today.addingTimeInterval(-1), matching: DateComponents(month: month, day: day),
                                               matchingPolicy: .nextTime) else { return nil }
            let days = calendar.dateComponents([.day], from: today, to: next).day ?? 99
            guard days <= 3 else { return nil }
            let when = days == 0 ? "today" : days == 1 ? "tomorrow" : "in \(Phrases.number(days)) days"
            let birthdayMemory = memories.first { $0.type == .person && $0.people.contains(person.name) }
                ?? Memory(id: "person-\(person.id)", type: .person, summary: "\(person.name)'s birthday", people: [person.name],
                          timestamp: now, source: "contacts", confidence: 0.9)
            var reminder = birthdayMemory
            reminder.followUp = "Say happy birthday to \(person.firstName) \(when)!"
            return ReminderCandidate(
                id: "birthday-\(person.id)-\(calendar.component(.year, from: next))", kind: .birthday, person: person,
                title: "\(person.name)'s birthday", subtitle: "Birthday \(when)", when: next,
                memories: [birthdayMemory], followUps: [reminder],
                fireDate: nextWaking(after: now, hour: 9, calendar: calendar),
                usefulness: 0.8, timeliness: 1 - Double(days) / 4)
        }
    }

    static func parkingCandidate(memories: [Memory], now: Date) -> ReminderCandidate? {
        guard let parked = memories.filter({ $0.has(MemoryTag.parking) && now.timeIntervalSince($0.timestamp) < 12 * 3600 && $0.timestamp <= now })
            .max(by: { $0.timestamp < $1.timestamp }) else { return nil }
        var spoken = parked
        spoken.followUp = TextTools.secondPerson(parked.summary)
        return ReminderCandidate(id: "parking-\(parked.id)", kind: .parking, person: nil, title: "Where you parked",
                                 subtitle: "Parked \(Phrases.day(parked.timestamp, now: now)) at \(Phrases.time(parked.timestamp))",
                                 when: nil, memories: [parked], followUps: [spoken], fireDate: now.addingTimeInterval(2),
                                 usefulness: 0.6, timeliness: 1)
    }

    /// Something you usually carry, when you leave home.
    static func carryCandidate(memories: [Memory], now: Date) -> ReminderCandidate? {
        let carried = memories.filter { $0.has("keys") || $0.has(MemoryTag.carry) }
        guard let latest = carried.max(by: { $0.timestamp < $1.timestamp }) else { return nil }
        var spoken = latest
        spoken.followUp = "Do you have your keys? Last time I saw them: \(TextTools.secondPerson(latest.summary).lowercasedFirst)"
        return ReminderCandidate(id: "carry-\(latest.id)-\(Int(now.timeIntervalSince1970 / 3600))", kind: .carry, person: nil,
                                 title: "Leaving home", subtitle: "You just left home", when: nil,
                                 memories: [latest], followUps: [spoken], fireDate: now.addingTimeInterval(2),
                                 usefulness: 0.5, timeliness: 1)
    }

    // MARK: Scoring

    /// usefulness × timeliness × confidence − annoyance.
    static func score(_ candidate: ReminderCandidate, firedToday: Int,
                      feedback: [(kind: String, positive: Bool, date: Date)]) -> Double {
        let sameKind = feedback.filter { $0.kind == candidate.kind.rawValue }
        let negatives = Double(sameKind.filter { !$0.positive }.count)
        let positives = Double(sameKind.filter(\.positive).count)
        let annoyance = max(0, 0.12 * Double(firedToday) + 0.2 * negatives - 0.05 * positives)
        return candidate.usefulness * candidate.timeliness * candidate.confidence - annoyance
    }

    static func choose(_ candidates: [ReminderCandidate], now: Date, firedToday: Int,
                       feedback: [(kind: String, positive: Bool, date: Date)], calendar: Calendar) -> [(candidate: ReminderCandidate, score: Double)] {
        let scored = candidates
            .filter { !isQuiet($0.fireDate, calendar: calendar) }
            .map { ($0, score($0, firedToday: firedToday, feedback: feedback)) }
            .filter { $0.1 >= threshold }
            .sorted { $0.1 > $1.1 }
        // Cap per calendar day: today's budget accounts for reminders already shown.
        var perDay: [Date: Int] = [calendar.startOfDay(for: now): firedToday]
        var chosen: [(candidate: ReminderCandidate, score: Double)] = []
        for (candidate, score) in scored {
            let day = calendar.startOfDay(for: candidate.fireDate)
            guard perDay[day, default: 0] < maxPerDay else { continue }
            perDay[day, default: 0] += 1
            chosen.append((candidate, score))
        }
        return chosen.sorted { $0.candidate.fireDate < $1.candidate.fireDate }
    }

    // MARK: Timing

    static func isQuiet(_ date: Date, calendar: Calendar) -> Bool {
        let hour = calendar.component(.hour, from: date)
        return hour >= quietStartHour || hour < quietEndHour
    }

    /// An hour before the event; moved to 8am if that falls in quiet hours,
    /// and to now if the hour-before has already passed.
    static func fireDate(before event: Date, now: Date, calendar: Calendar) -> Date {
        var fire = event.addingTimeInterval(-3600)
        if fire < now { fire = now.addingTimeInterval(5) }
        if isQuiet(fire, calendar: calendar) {
            let morning = calendar.date(bySettingHour: quietEndHour, minute: 0, second: 0, of: fire) ?? fire
            let candidate = morning < fire ? calendar.date(byAdding: .day, value: 1, to: morning) ?? morning : morning
            if candidate < event { fire = candidate }
        }
        return fire
    }

    static func nextWaking(after now: Date, hour: Int, calendar: Calendar) -> Date {
        let target = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: now) ?? now
        if target > now { return target }
        if !isQuiet(now.addingTimeInterval(60), calendar: calendar) { return now.addingTimeInterval(60) }
        return calendar.date(byAdding: .day, value: 1, to: target) ?? target
    }

    static func meetingSubtitle(_ event: Memory, person: Person, now: Date, calendar: Calendar) -> String {
        var activity = event.summary
        for name in [person.name, person.firstName] {
            activity = activity.replacingOccurrences(of: " with \(name)", with: "", options: .caseInsensitive)
        }
        activity = activity.trimmingCharacters(in: .whitespaces)
        if activity.isEmpty || activity.lowercased() == person.name.lowercased() { activity = "See \(person.firstName)" }
        return "\(activity) \(Phrases.day(event.timestamp, now: now, calendar: calendar)) at \(Phrases.time(event.timestamp, withPeriod: false))"
    }

    static func sourceLine(_ candidate: ReminderCandidate, now: Date) -> String {
        if candidate.kind == .meeting, let note = candidate.followUps.first {
            let noteLabel = note.type == .note ? "note" : note.type.sourceLabel.lowercased()
            return "From your calendar + \(noteLabel) · \(Phrases.sourceDate(note.timestamp, now: now, includeTime: false))".uppercased()
        }
        return CardBuilder.sourceLine(for: candidate.memories, now: now)
    }

    static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }
}

extension String {
    var lowercasedFirst: String {
        guard let first else { return self }
        return first.lowercased() + dropFirst()
    }
}

/// Local notifications carry the same words as the card; tapping one opens it.
enum Notifications {
    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static func content(for reminder: Reminder) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = reminder.title
        content.subtitle = reminder.subtitle
        content.body = reminder.body
        content.sound = .default
        content.threadIdentifier = "steph"
        content.userInfo = ["reminderID": reminder.id]
        return content
    }

    @discardableResult
    static func schedule(_ reminder: Reminder, now: Date = Date()) async -> Bool {
        let delay = max(1, reminder.fireDate.timeIntervalSince(now))
        let request = UNNotificationRequest(identifier: ProactiveEngine.notificationPrefix + reminder.id,
                                            content: content(for: reminder),
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false))
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            return false
        }
    }

    /// Replaces Steph's not-yet-delivered reminders with a fresh plan.
    static func replacePending(with reminders: [Reminder], now: Date) async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier)
            .filter { $0.hasPrefix(ProactiveEngine.notificationPrefix) })
        for reminder in reminders where reminder.fireDate > now { await schedule(reminder, now: now) }
    }
}
