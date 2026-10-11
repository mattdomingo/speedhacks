import Contacts
import EventKit
import Photos
import SwiftUI

/// The four things Steph asks to look at, in kid words.
enum PermissionKind: String, CaseIterable, Identifiable {
    case photos, calendar, contacts, location

    var id: String { rawValue }

    var title: String {
        switch self {
        case .photos: "Photos"
        case .calendar: "Calendar"
        case .contacts: "People you know"
        case .location: "Places you go"
        }
    }

    var symbol: String {
        switch self {
        case .photos: "photo"
        case .calendar: "calendar"
        case .contacts: "person.2"
        case .location: "mappin.and.ellipse"
        }
    }
}

/// Asks iOS for each permission, one at a time, and remembers the answers.
@MainActor
@Observable
final class PermissionCenter {
    private(set) var granted: Set<PermissionKind> = []
    @ObservationIgnored let location: LocationWatcher

    init(location: LocationWatcher) {
        self.location = location
        refresh()
    }

    func refresh() {
        var result = Set<PermissionKind>()
        let photos = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if photos == .authorized || photos == .limited { result.insert(.photos) }
        if EKEventStore.authorizationStatus(for: .event) == .fullAccess { result.insert(.calendar) }
        if CNContactStore.authorizationStatus(for: .contacts) == .authorized { result.insert(.contacts) }
        if location.isAuthorized { result.insert(.location) }
        granted = result
    }

    @discardableResult
    func request(_ kind: PermissionKind) async -> Bool {
        switch kind {
        case .photos:
            let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            _ = status
        case .calendar:
            _ = try? await EKEventStore().requestFullAccessToEvents()
        case .contacts:
            _ = try? await CNContactStore().requestAccess(for: .contacts)
        case .location:
            _ = await location.requestAuthorization()
        }
        refresh()
        return granted.contains(kind)
    }

    /// "Yes, let's go": all four in order, then notifications for reminders.
    func requestAll() async {
        for kind in PermissionKind.allCases { await request(kind) }
        _ = await Notifications.requestAuthorization()
    }
}
