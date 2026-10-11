import SwiftUI

/// "Talk to Steph": type, or tap the mic once to talk and again when done.
struct ChatBar: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var model = model
        let listening = model.stage == .listening
        let hasText = !model.typedText.trimmingCharacters(in: .whitespaces).isEmpty

        HStack(spacing: 10) {
            TextField("Talk to Steph", text: $model.typedText,
                      prompt: Text("Talk to Steph").foregroundStyle(Theme.caption))
                .font(.sora(18))
                .foregroundStyle(Theme.text)
                .tint(Theme.pink)
                .submitLabel(.send)
                .focused($focused)
                .onSubmit { model.sendTyped() }
                .padding(.horizontal, 20)
                .frame(minHeight: 60)
                .background(Theme.card, in: Capsule())
                .disabled(listening)
                .accessibilityLabel("Type to Steph")

            Button {
                if hasText {
                    focused = false
                    model.sendTyped()
                } else {
                    focused = false
                    model.toggleMic()
                }
            } label: {
                Image(systemName: hasText ? "arrow.up" : "mic")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.black)
                    .frame(width: 60, height: 60)
                    .background(listening ? Theme.pink : Theme.text, in: Circle())
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(listening ? "Stop listening" : hasText ? "Send" : "Talk to Steph")
            .animation(.easeInOut(duration: 0.2), value: listening)
        }
    }
}

private struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
