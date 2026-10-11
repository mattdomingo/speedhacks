import SwiftUI

/// The small settings button's sheet. Kept to a few big, plain choices.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmStartOver = false

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
                    MonoCaption(text: model.client.isConfigured ? "Steph's brain · Claude, via the Recall server" : "Steph's brain · on this phone only")
                    MonoCaption(text: "Remembering \(model.memoryCount.formatted()) moments")
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
