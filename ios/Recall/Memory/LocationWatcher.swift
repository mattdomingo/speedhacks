import AVFoundation
import CoreLocation
import Foundation

/// Places you go (Core Location visits + significant changes) and where you
/// parked (saved when a car Bluetooth or CarPlay audio route drops).
/// No continuous GPS: visits and significant changes are low-power.
@MainActor
final class LocationWatcher: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var authorizationContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var oneShot: CheckedContinuation<CLLocation?, Never>?
    private var routeObserver: NSObjectProtocol?

    var store: MemoryStore?
    /// Called when you leave a place Steph thinks is home.
    var onLeftHome: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var status: CLAuthorizationStatus { manager.authorizationStatus }
    var isAuthorized: Bool { status == .authorizedAlways || status == .authorizedWhenInUse }

    func requestAuthorization() async -> CLAuthorizationStatus {
        guard status == .notDetermined else {
            if status == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
            return status
        }
        return await withCheckedContinuation { continuation in
            authorizationContinuation = continuation
            manager.requestAlwaysAuthorization()
        }
    }

    func start() {
        guard isAuthorized else { return }
        if status == .authorizedAlways {
            manager.startMonitoringVisits()
            manager.startMonitoringSignificantLocationChanges()
        }
        watchCarAudio()
    }

    // MARK: Parking

    private func watchCarAudio() {
        guard routeObserver == nil else { return }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)),
                reason == .oldDeviceUnavailable,
                let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription,
                previous.outputs.contains(where: Self.isCar) else { return }
            Task { @MainActor in await self?.saveParking() }
        }
    }

    /// CarPlay, or a Bluetooth device whose name sounds like a car.
    nonisolated static func isCar(_ port: AVAudioSessionPortDescription) -> Bool {
        if port.portType == .carAudio { return true }
        guard [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE].contains(port.portType) else { return false }
        let name = port.portName.lowercased()
        let hints = ["car", "auto", "toyota", "honda", "ford", "sync", "bmw", "audi", "mercedes", "tesla", "subaru", "mazda",
                     "nissan", "hyundai", "kia", "lexus", "volvo", "jeep", "chevy", "chevrolet", "uconnect", "vw", "volkswagen"]
        return hints.contains { name.contains($0) }
    }

    func saveParking(now: Date = Date()) async {
        guard let store, let location = await currentLocation() else { return }
        let name = await placeName(for: location) ?? "where you parked"
        let memory = Memory(id: "parking-\(Int(now.timeIntervalSince1970))", type: .place,
                            summary: "You parked near \(name).", detail: "car parked parking",
                            place: name, timestamp: now, source: "location", confidence: 0.85,
                            latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                            tags: [MemoryTag.parking])
        _ = try? await store.upsert(memory)
    }

    private func currentLocation() async -> CLLocation? {
        guard isAuthorized else { return nil }
        if let recent = manager.location, recent.timestamp.timeIntervalSinceNow > -120 { return recent }
        return await withCheckedContinuation { continuation in
            oneShot?.resume(returning: nil)
            oneShot = continuation
            manager.requestLocation()
        }
    }

    private func placeName(for location: CLLocation) async -> String? {
        guard let placemark = try? await geocoder.reverseGeocodeLocation(location).first else { return nil }
        return placemark.name ?? placemark.thoroughfare ?? placemark.locality
    }

    // MARK: Visits

    private func record(_ visit: CLVisit) async {
        guard let store else { return }
        let location = CLLocation(latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude)
        let name = await placeName(for: location) ?? "a place you visited"
        let arrival = visit.arrivalDate == .distantPast ? Date() : visit.arrivalDate
        let departed = visit.departureDate != .distantFuture
        let overnight = departed && Calendar.current.component(.hour, from: arrival) >= 20
            && visit.departureDate.timeIntervalSince(arrival) > 5 * 3600
        let places = (try? await store.places()) ?? []
        let home = places.filter { $0.nightVisits >= 2 }.max { $0.nightVisits < $1.nightVisits }
        guard let place = try? await store.recordVisit(name: name, latitude: location.coordinate.latitude,
                                                       longitude: location.coordinate.longitude,
                                                       at: arrival, overnight: overnight) else { return }
        let memory = Memory(id: "visit-\(Int(arrival.timeIntervalSince1970))", type: .place,
                            summary: departed ? "You were at \(place.name)." : "You arrived at \(place.name).",
                            place: place.name, timestamp: arrival, endDate: departed ? visit.departureDate : nil,
                            source: "location", confidence: 0.8,
                            latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                            tags: place.id == home?.id ? [MemoryTag.home] : [])
        _ = try? await store.upsert(memory)
        try? await store.link(memoryID: memory.id, kind: "place", targetID: place.id)
        if departed, let home, home.id == place.id { onLeftHome?() }
    }

    // MARK: CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard status != .notDetermined else { return }
            self.authorizationContinuation?.resume(returning: status)
            self.authorizationContinuation = nil
            self.start()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        Task { @MainActor in await self.record(visit) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let latest = locations.last
        Task { @MainActor in
            self.oneShot?.resume(returning: latest)
            self.oneShot = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.oneShot?.resume(returning: nil)
            self.oneShot = nil
        }
    }
}
