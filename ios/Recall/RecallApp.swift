import SwiftUI
import UserNotifications

@main
struct RecallApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    private let model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .onAppear { model.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.becameActive() }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Background tasks must be registered before launch finishes.
        AppModel.registerBackgroundTasks()
        UNUserNotificationCenter.current().delegate = self
        // Visits can relaunch the app in the background; resume watching right away.
        if launchOptions?[.location] != nil { AppModel.shared.location.start() }
        return true
    }

    /// With the app open, Steph shows the card herself and the phone just chimes.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        if let id = notification.request.content.userInfo["reminderID"] as? String {
            await MainActor.run { AppModel.shared.openReminder(id: id) }
        }
        return [.sound, .list]
    }

    /// Tapping a reminder notification opens Steph's card.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["reminderID"] as? String else { return }
        await MainActor.run { AppModel.shared.openReminder(id: id) }
    }
}

/// Sign up → one-time permission → the one home screen.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            switch model.phase {
            case .signUp:
                SignUpView()
                    .transition(.opacity)
            case .permissions:
                PermissionView()
                    .transition(.opacity)
            case .home:
                HomeView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: model.phase)
    }
}
