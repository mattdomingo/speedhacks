import SwiftUI

/// The only persistent screen: Steph's orb, and cards that rise from it.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var orbSpace
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack {
                if model.stage.isConversation {
                    conversation
                } else {
                    greeting
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) { notice }
            if case .card(_, let card) = model.stage {
                CardButtons(labels: card.buttons) { model.tap($0) }
                    .padding(.top, 12)
                    .id(card)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            ChatBar()
                .padding(.top, 12)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
                .presentationDetents([.large])
                .presentationBackground(Theme.background)
        }
    }

    private var topBar: some View {
        HStack {
            Text("Recall")
                .font(.sora(17, .medium))
                .tracking(-0.2)
                .foregroundStyle(Theme.text)
                .padding(.leading, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .onTapGesture(count: 3) { model.toggleDemoMode() }
                .accessibilityAddTraits(.isHeader)
                .accessibilityAction(named: "Toggle demo memories") { model.toggleDemoMode() }
            Spacer()
            Button {
                showSettings = true
            } label: {
                Image(systemName: "person")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Theme.secondary)
                    .frame(width: 44, height: 44)
                    .background(Theme.card, in: Circle())
            }
            .accessibilityLabel("Settings")
        }
    }

    private var orbSize: CGFloat {
        switch model.stage {
        case .idle, .listening: 240
        case .reminder: 132
        default: 84
        }
    }

    private var orb: some View {
        StephOrb(size: 240, state: model.orbState, level: model.activeLevel)
            .scaleEffect(orbSize / 240)
            .frame(width: orbSize, height: orbSize)
            .matchedGeometryEffect(id: "orb", in: orbSpace)
            .onTapGesture { if model.stage.isConversation { model.dismiss() } }
            .accessibilityHint(model.stage.isConversation ? "Closes the card" : "")
    }

    // MARK: Idle and listening

    private var greeting: some View {
        let listening = model.stage == .listening
        return VStack(spacing: 44) {
            Spacer(minLength: 0)
            orb
            VStack(spacing: 14) {
                Text(listening ? "I'm listening…" : "Hi, I'm Steph.\nAsk me anything.")
                    .font(.sora(22, .light, relativeTo: .title2))
                    .lineSpacing(6)
                    .foregroundStyle(Theme.textSoft)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                MonoCaption(text: listening ? "Tap again when you're done" : "Remembering \(model.memoryCount.formatted()) moments")
                    .contentTransition(.numericText())
            }
            .animation(.easeInOut(duration: 0.25), value: listening)
            .animation(.easeInOut(duration: 0.25), value: model.memoryCount)
            Spacer(minLength: 0)
        }
    }

    // MARK: Conversation

    private var conversation: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 16) {
                    orb
                    if case .reminder = model.stage {
                        MonoCaption(text: "Steph · just now")
                    }
                }
                .frame(maxWidth: .infinity)

                if let question = currentQuestion {
                    HStack {
                        Spacer(minLength: 48)
                        Text(question)
                            .font(.sora(18))
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 12)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    }
                    .transition(.opacity)
                }

                if let card = currentCard {
                    CardView(card: card) { model.tap($0) }
                        .id(card)
                        .transition(.rise(reduceMotion: reduceMotion))
                        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
                            if value.translation.height > 90 { model.dismiss() }
                        })
                }
            }
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
    }

    private var currentQuestion: String? {
        switch model.stage {
        case .thinking(let question): question
        case .card(let question, _): question
        default: nil
        }
    }

    private var currentCard: CardContent? {
        switch model.stage {
        case .card(_, let card): card
        case .reminder(let reminder): .reminder(reminder)
        default: nil
        }
    }

    @ViewBuilder private var notice: some View {
        if let notice = model.notice {
            Text(notice)
                .font(.sora(17))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(Theme.surface, in: Capsule())
                .padding(.bottom, 8)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}

// MARK: - Card motion

/// Cards rise out of the orb: they start small, tucked under it, and
/// spring open without bouncing. With Reduce Motion they simply fade in.
private struct RiseEffect: ViewModifier {
    var progress: CGFloat

    func body(content: Content) -> some View {
        content
            .scaleEffect(0.55 + 0.45 * progress, anchor: .top)
            .offset(y: -48 * (1 - progress))
            .opacity(Double(progress))
    }
}

extension AnyTransition {
    static func rise(reduceMotion: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .modifier(active: RiseEffect(progress: 0), identity: RiseEffect(progress: 1)),
            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
    }
}

#Preview {
    HomeView()
        .environment(AppModel.shared)
        .background(.black)
}
