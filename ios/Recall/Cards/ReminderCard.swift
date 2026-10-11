import SwiftUI

/// Steph speaks first: who you're about to see and what to say.
struct ReminderCard: View {
    let reminder: Reminder
    let onTap: (String) -> Void

    var body: some View {
        CardSurface {
            HStack(spacing: 14) {
                LetterAvatar(name: reminder.title)
                VStack(alignment: .leading, spacing: 2) {
                    Text(reminder.title)
                        .font(.sora(20, .semibold))
                        .foregroundStyle(Theme.text)
                    Text(reminder.subtitle)
                        .font(.sora(17))
                        .foregroundStyle(Theme.secondary)
                }
            }
            .accessibilityElement(children: .combine)

            Text(reminder.body)
                .font(.sora(22, relativeTo: .title3))
                .lineSpacing(6)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)

            MonoCaption(text: reminder.sourceLine)

            CardButtons(labels: reminder.buttons, onTap: onTap)
        }
    }
}

#Preview("Reminder") {
    ReminderCard(reminder: Reminder(
        id: "preview", kind: .meeting, personName: "Priya", subtitle: "Coffee today at 3:00",
        body: "Ask how her mom is doing. She had surgery two weeks ago.",
        sourceLine: "FROM YOUR CALENDAR + NOTE · SEP 27", memoryIDs: [], buttons: ["Thanks!", "Tell me more"],
        fireDate: .now, score: 1, isDemo: true
    )) { _ in }
    .padding()
    .background(.black)
}
