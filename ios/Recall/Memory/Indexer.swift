import Contacts
import CryptoKit
import EventKit
import Foundation
import Photos
import UIKit
import Vision

/// Quietly turns what's on the phone into memories. Photos are understood
/// on-device with Vision; only the resulting short text is ever sent anywhere.
/// Heavy passes run in a BGProcessingTask that requires external power.
actor Indexer {
    private let store: MemoryStore
    private let embedder: ChainedEmbedder
    private let faces = FaceGroups()

    init(store: MemoryStore, embedder: ChainedEmbedder) {
        self.store = store
        self.embedder = embedder
    }

    /// Light pass: calendar, contacts, the newest photos, then embeddings.
    func runLight() async {
        _ = await indexContacts()
        _ = await indexCalendar()
        _ = await indexPhotos(limit: 40)
        await embedPending(limit: 200)
    }

    /// Heavy pass for charging time.
    func runHeavy(shouldStop: @Sendable () -> Bool) async {
        _ = await indexContacts()
        _ = await indexCalendar()
        _ = await indexPhotos(limit: 1500, shouldStop: shouldStop)
        await embedPending(limit: 5000, shouldStop: shouldStop)
    }

    // MARK: Calendar

    func indexCalendar(now: Date = Date()) async -> Int {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return 0 }
        let eventStore = EKEventStore()
        let start = now.addingTimeInterval(-60 * 86_400)
        let end = now.addingTimeInterval(14 * 86_400)
        let events = eventStore.events(matching: eventStore.predicateForEvents(withStart: start, end: end, calendars: nil))
        let people = (try? await store.people()) ?? []
        var memories: [Memory] = []
        for event in events where !event.isAllDay || event.attendees?.isEmpty == false {
            guard let title = event.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { continue }
            var names = (event.attendees ?? []).filter { !$0.isCurrentUser }.compactMap(\.name)
            names += Self.namesAfterWith(in: title)
            names += TextTools.mentionedPeople(in: title, people: people).map(\.name)
            let unique = names.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            let key = "\(event.eventIdentifier ?? title)|\(event.startDate.timeIntervalSince1970)"
            memories.append(Memory(
                id: "event-" + Self.shortHash(key), type: .event, summary: String(title.prefix(200)),
                detail: [event.location ?? "", String((event.notes ?? "").prefix(200))].joined(separator: " "),
                people: Array(unique.prefix(12)),
                place: event.location?.components(separatedBy: "\n").first.map { String($0.prefix(120)) },
                timestamp: event.startDate, endDate: event.endDate, source: "calendar", confidence: 0.95,
                externalID: key))
        }
        let inserted = (try? await store.upsert(memories)) ?? 0
        for memory in memories { await linkPeople(memory, known: people) }
        return inserted
    }

    /// "Coffee with Priya" → ["Priya"].
    static func namesAfterWith(in title: String) -> [String] {
        guard let range = title.range(of: #"\bwith ([A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?)"#, options: .regularExpression) else { return [] }
        return [String(title[range].dropFirst(5))]
    }

    // MARK: Contacts

    func indexContacts() async -> Int {
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return 0 }
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactBirthdayKey,
            CNContactRelationsKey, CNContactOrganizationNameKey, CNContactJobTitleKey, CNContactIdentifierKey,
        ].map { $0 as CNKeyDescriptor }
        let request = CNContactFetchRequest(keysToFetch: keys)
        var contacts: [CNContact] = []
        try? CNContactStore().enumerateContacts(with: request) { contact, stop in
            contacts.append(contact)
            if contacts.count >= 2000 { stop.pointee = true }
        }
        var memories: [Memory] = []
        for contact in contacts {
            let name = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            guard !name.isEmpty else { continue }
            let person = Person(id: "contact-" + Self.shortHash(contact.identifier), name: name,
                                aliases: [contact.nickname, contact.givenName].filter { !$0.isEmpty },
                                birthdayMonth: contact.birthday?.month, birthdayDay: contact.birthday?.day,
                                contactID: contact.identifier)
            try? await store.upsert(person: person)

            var facts: [String] = []
            if !contact.jobTitle.isEmpty || !contact.organizationName.isEmpty {
                facts.append(["Works", contact.jobTitle.isEmpty ? nil : "as \(contact.jobTitle)",
                              contact.organizationName.isEmpty ? nil : "at \(contact.organizationName)"]
                    .compactMap { $0 }.joined(separator: " ") + ".")
            }
            if let month = contact.birthday?.month, let day = contact.birthday?.day,
               let date = Calendar.current.date(from: DateComponents(year: 2000, month: month, day: day)) {
                facts.append("Birthday: \(date.formatted(.dateTime.month(.wide).day())).")
            }
            for relation in contact.contactRelations {
                let label = CNLabeledValue<CNContactRelation>.localizedString(forLabel: relation.label ?? "")
                facts.append("\(label.capitalized): \(relation.value.name).")
            }
            let summary = facts.isEmpty ? "\(name) is in your contacts." : "\(name). " + facts.joined(separator: " ")
            memories.append(Memory(id: person.id, type: .person, summary: String(summary.prefix(400)),
                                   people: [name], timestamp: Date(),
                                   source: "contacts", confidence: 0.95,
                                   tags: contact.birthday == nil ? [] : [MemoryTag.birthday], externalID: contact.identifier))
        }
        let inserted = (try? await store.upsert(memories)) ?? 0
        for memory in memories { try? await store.link(memoryID: memory.id, kind: "person", targetID: memory.id) }
        return inserted
    }

    // MARK: Photos

    func indexPhotos(limit: Int, shouldStop: @Sendable () -> Bool = { false }) async -> Int {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return 0 }
        let known = (try? await store.knownExternalIDs(source: "photo")) ?? []
        let places = (try? await store.places()) ?? []
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let assets = PHAsset.fetchAssets(with: options)

        var inserted = 0
        var batch: [Memory] = []
        var index = 0
        while index < assets.count, inserted + batch.count < limit, !shouldStop() {
            let asset = assets.object(at: index)
            index += 1
            guard !known.contains(asset.localIdentifier), let image = Self.thumbnail(for: asset) else { continue }
            if let memory = await understand(asset: asset, image: image, places: places) { batch.append(memory) }
            if batch.count >= 20 {
                inserted += (try? await store.upsert(batch)) ?? 0
                batch.removeAll()
            }
        }
        if !batch.isEmpty { inserted += (try? await store.upsert(batch)) ?? 0 }
        return inserted
    }

    /// A 512 px on-device thumbnail. Network access is off: iCloud-only photos
    /// are skipped rather than downloaded.
    private static func thumbnail(for asset: PHAsset) -> CGImage? {
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        var result: CGImage?
        PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 512, height: 512),
                                              contentMode: .aspectFit, options: options) { image, _ in
            result = image?.cgImage
        }
        return result
    }

    private func understand(asset: PHAsset, image: CGImage, places: [Place]) async -> Memory? {
        let classify = VNClassifyImageRequest()
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .fast
        let faceRects = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do { try handler.perform([classify, text, faceRects]) } catch { return nil }

        let labels = (classify.results ?? [])
            .filter { $0.confidence > 0.3 }
            .prefix(8)
            .map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
        let words = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }.prefix(12).joined(separator: " ")
        let faceCount = faceRects.results?.count ?? 0
        let groups = faceCount > 0 ? faces.assign(faces: faceRects.results ?? [], in: image) : []
        guard !labels.isEmpty || !words.isEmpty || faceCount > 0 else { return nil }

        var summary = labels.isEmpty ? "A photo" : "A photo of " + Self.list(Array(labels.prefix(4)))
        if faceCount > 0 { summary += faceCount == 1 ? " with one person" : " with \(Phrases.number(faceCount)) people" }
        summary += "."
        if !words.isEmpty { summary += " Words in it: \(words.prefix(120))." }

        var place: String?
        if let location = asset.location {
            place = places.min { a, b in
                Geo.distance(location.coordinate.latitude, location.coordinate.longitude, a.latitude, a.longitude) <
                    Geo.distance(location.coordinate.latitude, location.coordinate.longitude, b.latitude, b.longitude)
            }
            .flatMap { Geo.distance(location.coordinate.latitude, location.coordinate.longitude, $0.latitude, $0.longitude) < 150 ? $0.name : nil }
        }
        let top = Double(classify.results?.first?.confidence ?? 0.5)
        return Memory(id: "photo-" + Self.shortHash(asset.localIdentifier), type: .photo, summary: summary,
                      detail: (labels + [words]).joined(separator: " "), place: place,
                      timestamp: asset.creationDate ?? Date(), source: "photo", confidence: min(0.95, max(0.5, top)),
                      assetID: asset.localIdentifier, latitude: asset.location?.coordinate.latitude,
                      longitude: asset.location?.coordinate.longitude,
                      tags: groups.map { "face:\($0)" } + (labels.contains("key") ? ["keys"] : []),
                      externalID: asset.localIdentifier)
    }

    private static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: ""
        case 1: items[0]
        default: items.dropLast().joined(separator: ", ") + " and " + items.last!
        }
    }

    // MARK: Embeddings

    func embedPending(limit: Int, shouldStop: @Sendable () -> Bool = { false }) async {
        var done = 0
        while done < limit, !shouldStop() {
            guard let pending = try? await store.missingEmbeddings(limit: 64), !pending.isEmpty else { return }
            guard let batch = await embedder.embed(pending.map(\.embeddingText), kind: .document) else { return }
            let vectors = Dictionary(zip(pending.map(\.id), batch.vectors), uniquingKeysWith: { a, _ in a })
            try? await store.setEmbeddings(vectors, model: batch.model)
            done += pending.count
        }
    }

    // MARK: Graph

    func linkPeople(_ memory: Memory, known: [Person]) async {
        for name in memory.people {
            let person = known.first { $0.names.contains(name.lowercased()) }
                ?? Person(id: "person-" + Self.shortHash(name.lowercased()), name: name)
            if !known.contains(person) { try? await store.upsert(person: person) }
            try? await store.link(memoryID: memory.id, kind: "person", targetID: person.id, isDemo: memory.isDemo)
        }
    }

    static func shortHash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
    }
}

/// Groups faces across photos by Vision feature-print distance. Groups are
/// anonymous ("face:3"); nothing identifies who a face belongs to. The group
/// prints are kept in Application Support so ids stay stable across launches.
final class FaceGroups: @unchecked Sendable {
    private let lock = NSLock()
    private var representatives: [VNFeaturePrintObservation]
    private let threshold: Float = 0.55
    private let file = URL.applicationSupportDirectory.appending(path: "face-groups.archive")

    init() {
        let data = try? Data(contentsOf: file)
        representatives = data.flatMap {
            try? NSKeyedUnarchiver.unarchivedArrayOfObjects(ofClass: VNFeaturePrintObservation.self, from: $0)
        } ?? []
    }

    func assign(faces: [VNFaceObservation], in image: CGImage) -> [Int] {
        let ids: [Int] = faces.prefix(4).compactMap { face in
            let request = VNGenerateImageFeaturePrintRequest()
            request.regionOfInterest = face.boundingBox
            guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil,
                  let print = request.results?.first else { return nil }
            lock.lock()
            defer { lock.unlock() }
            var best: (id: Int, distance: Float)?
            for (index, rep) in representatives.enumerated() {
                var distance: Float = 0
                guard (try? print.computeDistance(&distance, to: rep)) != nil else { continue }
                if distance < (best?.distance ?? .infinity) { best = (index + 1, distance) }
            }
            if let best, best.distance < threshold { return best.id }
            guard representatives.count < 500 else { return nil }
            representatives.append(print)
            return representatives.count
        }
        save()
        return ids
    }

    private func save() {
        lock.lock()
        let reps = representatives
        lock.unlock()
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: reps, requiringSecureCoding: true) {
            try? data.write(to: file, options: [.atomic, .completeFileProtection])
        }
    }
}
