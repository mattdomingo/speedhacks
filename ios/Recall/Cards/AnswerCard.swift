import Photos
import SwiftUI

/// Routes a card to its view.
struct CardView: View {
    let card: CardContent
    let onTap: (String) -> Void

    var body: some View {
        switch card {
        case .answer(let model): AnswerCard(model: model)
        case .person(let model): PersonCard(model: model)
        case .reminder(let reminder): ReminderCard(reminder: reminder, onTap: onTap)
        }
    }
}

/// One-sentence answer, an optional photo, how Steph knows, and the source.
/// Its buttons are pinned above the chat bar so they are always in reach.
struct AnswerCard: View {
    let model: AnswerCardModel

    var body: some View {
        CardSurface(padding: 20) {
            Text(model.answer)
                .font(.sora(24, .medium, relativeTo: .title2))
                .lineSpacing(4)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)

            if let photo = model.photo {
                MemoryPhoto(ref: photo)
                    .frame(height: 200)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }

            if let closest = model.closest {
                VStack(alignment: .leading, spacing: 8) {
                    MonoCaption(text: "Closest memory")
                    Text(closest)
                        .font(.sora(18))
                        .foregroundStyle(Theme.textSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            if let howIKnow = model.howIKnow {
                Text(howIKnow)
                    .font(.sora(17))
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            MonoCaption(text: model.sourceLine)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One main action per card: the first label is the white primary button.
struct CardButtons: View {
    let labels: [String]
    var height: CGFloat = 56
    let onTap: (String) -> Void

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
                Button(label) { onTap(label) }
                    .buttonStyle(.pill(index == 0 ? .primary : .secondary, height: height))
            }
        }
    }
}

/// A memory's photo, loaded on-device (bundled demo photo or library asset).
struct MemoryPhoto: View {
    let ref: PhotoRef
    @State private var image: UIImage?

    var body: some View {
        // The photo fills whatever frame the card gives it, never wider.
        Theme.surface
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                } else {
                    Image(systemName: "photo")
                        .font(.system(size: 28))
                        .foregroundStyle(Theme.caption)
                }
            }
            .clipped()
        .accessibilityLabel("Photo")
        .task(id: ref) { image = await Self.load(ref) }
    }

    static func load(_ ref: PhotoRef) async -> UIImage? {
        switch ref {
        case .bundle(let name):
            return UIImage(named: name)
        case .library(let id):
            guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return nil }
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = false
            return await withCheckedContinuation { continuation in
                PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 1000, height: 1000),
                                                      contentMode: .aspectFill, options: options) { image, _ in
                    continuation.resume(returning: image)
                }
            }
        }
    }
}

#Preview("Answer") {
    AnswerCard(model: AnswerCardModel(
        kind: .photo, answer: "On the kitchen counter, next to the fruit bowl.", photo: .bundle("DemoKeys"),
        closest: nil, howIKnow: "I saw them in a photo you took today.",
        sourceLine: "PHOTO · TODAY 8:12 AM · KITCHEN", buttons: ["Found them!", "Not there"], memoryIDs: []
    ))
    .padding()
    .background(.black)
}
