import AuthenticationServices
import SwiftUI

struct SignUpView: View {
    @Environment(AppModel.self) private var model
    @State private var signIn = AppleSignIn()
    @State private var working = false

    var body: some View {
        VStack(spacing: 0) {
            StephOrb(size: 220, state: .idle)
                .padding(.top, 72)

            VStack(spacing: 14) {
                Text("Recall")
                    .font(.sora(40, .medium, relativeTo: .largeTitle))
                    .foregroundStyle(Theme.text)
                Text("Meet Steph. She remembers things, so you don't have to.")
                    .font(.sora(20, relativeTo: .title3))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 48)

            Spacer(minLength: 24)

            VStack(spacing: 12) {
                Button {
                    Task { await continueWithApple() }
                } label: {
                    HStack(spacing: 10) {
                        Text("Get started")
                        Image(systemName: "arrow.right")
                            .font(.system(size: 18, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                }
                .buttonStyle(.primaryPill)
                .accessibilityHint("Signs in with Apple")

                Button("I already have an account") {
                    Task { await continueWithApple() }
                }
                .buttonStyle(QuietLinkStyle())
            }
            .disabled(working)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func continueWithApple() async {
        working = true
        defer { working = false }
        switch await signIn.start() {
        case .signedIn(let account):
            UserDefaults.standard.set(account.userID, forKey: "appleUserID")
            if let name = account.givenName { UserDefaults.standard.set(name, forKey: "givenName") }
            model.finishSignUp()
        case .canceled:
            break
        case .unavailable:
            // No Apple ID on this device (or a build without the capability):
            // keep a local-only profile so the app still works.
            model.finishSignUp()
        }
    }
}

/// Sign in with Apple, wrapped in async/await.
@MainActor
final class AppleSignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    struct Account { var userID: String; var givenName: String? }
    enum Outcome { case signedIn(Account), canceled, unavailable }

    private var continuation: CheckedContinuation<Outcome, Never>?

    func start() async -> Outcome {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName]
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let account = credential.map { Account(userID: $0.user, givenName: $0.fullName?.givenName) }
        Task { @MainActor in self.finish(account.map(Outcome.signedIn) ?? .unavailable) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        Task { @MainActor in self.finish(canceled ? .canceled : .unavailable) }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }

    private func finish(_ outcome: Outcome) {
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

#Preview {
    SignUpView()
        .environment(AppModel.shared)
        .background(.black)
}
