import SwiftUI

/// Who someone is: what's worth remembering, when you last saw them, and
/// anything you promised them.
struct PersonCard: View {
    let model: PersonCardModel

    var body: some View {
        CardSurface {
            HStack(spacing: 14) {
                LetterAvatar(name: model.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.name)
                        .font(.sora(20, .semibold))
                        .foregroundStyle(Theme.text)
                    Text(model.answer)
                        .font(.sora(17))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !model.facts.isEmpty {
                section("Worth remembering", items: model.facts)
            }
            if let lastSeen = model.lastSeen {
                section("Last time you saw them", items: [lastSeen])
            }
            if !model.promises.isEmpty {
                section("You promised", items: model.promises, highlight: true)
            }

            MonoCaption(text: model.sourceLine)
        }
        .accessibilityElement(children: .combine)
    }

    private func section(_ title: String, items: [String], highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MonoCaption(text: title, color: highlight ? Theme.pinkLight : Theme.caption)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Circle()
                        .fill(highlight ? Theme.pink : Theme.caption)
                        .frame(width: 6, height: 6)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                    Text(item)
                        .font(.sora(18))
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

#Preview("Person") {
    PersonCard(model: PersonCardModel(
        name: "Sam Chen", answer: "Sam Chen is your friend.",
        facts: ["Sam's son Leo just turned 4.", "Sam started a new design job in September."],
        lastSeen: "Lunch with Sam Chen · Sep 20",
        promises: ["You promised to send Sam the Tokyo ramen place."],
        sourceLine: "FROM YOUR NOTES + CALENDAR + CONTACTS · SEP 20", buttons: ["Thanks!"], memoryIDs: []
    ))
    .padding()
    .background(.black)
}
