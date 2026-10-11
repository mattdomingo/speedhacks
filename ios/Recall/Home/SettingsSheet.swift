import SwiftUI

/// The small settings button's sheet. Kept to a few big, plain choices.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmStartOver = false
    @State private var connectionToken = ""
    @State private var connectionPin = ""
    @State private var connecting = false
    @State private var connectionError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack {
                    Text("Settings")
                        .font(.sora(28, .semibold, relativeTo: .title))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    StephOrb(size: 56, state: .idle)
                }

                VStack(alignment: .leading, spacing: 8) {
                    MonoCaption(text: model.demoMode ? "Demo memories only" : model.connectionStatus)
                    MonoCaption(text: "Remembering \(model.memoryCount.formatted()) moments")
                }

                group("Connected memories") {
                    Text("Use the calendar, email, and last camera sightings available when you call Steph. Only memories needed for your question are sent to the answer service.")
                        .font(.sora(16)).foregroundStyle(Theme.secondary)
                    if model.sharedMemoryConnected {
                        Button("Disconnect shared memories") {
                            do { try model.disconnectMemories(); connectionError = nil }
                            catch { connectionError = "Could not remove the saved connection. Please try again." }
                        }
                        .buttonStyle(.pill(.secondary))
                    }
                    SecureField("Device access code", text: $connectionToken)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("memory-access-code")
                    SecureField("Memory PIN (if required)", text: $connectionPin)
                        .keyboardType(.numberPad).textFieldStyle(.roundedBorder)
                    Button(connecting ? "Connecting…" : "Connect memories") {
                        connecting = true
                        connectionError = nil
                        Task {
                            defer { connecting = false }
                            do {
                                try await model.connectMemories(token: connectionToken, pin: connectionPin)
                                connectionToken = ""
                                connectionPin = ""
                            } catch {
                                connectionError = StephClient.connectionMessage(for: error)
                            }
                        }
                    }
                    .buttonStyle(.pill(.secondary))
                    .disabled(connecting || connectionToken.trimmingCharacters(in: .whitespacesAndNewlines).count < 32)
                    if let connectionError {
                        Text(connectionError).font(.sora(16)).foregroundStyle(Theme.secondary)
                            .accessibilityIdentifier("memory-connection-error")
                    }
                    Text("Enter the private device access code provided during setup. Disconnecting removes it from this phone.")
                        .font(.sora(15)).foregroundStyle(Theme.secondary)
                    Link("Call Steph", destination: URL(string: "tel:+12408962183")!)
                        .buttonStyle(.pill(.secondary))
                }

                group("Demo") {
                    Toggle(isOn: Binding(get: { model.demoMode }, set: { on in Task { await model.setDemoMode(on) } })) {
                        Text("Demo memories")
                            .font(.sora(18, .medium))
                            .foregroundStyle(Theme.text)
                    }
                    .tint(Theme.pink)
                    .frame(minHeight: 56)

                    if model.demoMode {
                        Button("Show Priya reminder") {
                            dismiss()
                            model.triggerDemoReminder()
                        }
                        .buttonStyle(.pill(.secondary))
                        Button("Buzz me in 10 seconds") {
                            dismiss()
                            model.triggerDemoReminder(after: 10)
                        }
                        .buttonStyle(.pill(.secondary))
                    }
                    Text("Tip: tap the word Recall three times to turn demo memories on or off.")
                        .font(.sora(17))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                group("Your phone") {
                    Button("Look at my phone now") {
                        dismiss()
                        model.indexNow()
                    }
                    .buttonStyle(.pill(.secondary))
                    Button("Change what Steph can see") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(.pill(.secondary))
                    Button("Start over") { confirmStartOver = true }
                        .buttonStyle(.pill(.secondary))
                }

                Button("Done") { dismiss() }
                    .buttonStyle(.primaryPill)
            }
            .padding(24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .confirmationDialog("Forget everything and start over?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Forget everything", role: .destructive) {
                dismiss()
                model.startOver()
            }
        } message: {
            Text("Steph will forget all her memories on this phone.")
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            MonoCaption(text: title)
            content()
        }
    }
}
