import SwiftUI

/// One-time ask: can Steph look around your phone?
struct PermissionView: View {
    @Environment(AppModel.self) private var model
    @State private var picking = false
    @State private var working = false

    var body: some View {
        let permissions = model.permissions
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 14) {
                    StephOrb(size: 104, state: working ? .thinking : .idle)
                    Text("Can Steph look around your phone?")
                        .font(.sora(30, .semibold, relativeTo: .title))
                        .tracking(-0.6)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Then she can remind you before you forget.")
                        .font(.sora(18, relativeTo: .body))
                        .foregroundStyle(Theme.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 10) {
                    ForEach(PermissionKind.allCases) { kind in
                        PermissionRow(kind: kind, picking: picking, isOn: permissions.granted.contains(kind)) {
                            Task { await permissions.request(kind) }
                        }
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
            .padding(.bottom, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom) { actions }
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Label("Your photos never leave your phone.", systemImage: "lock")
                .font(.sora(17, relativeTo: .footnote))
                .foregroundStyle(Theme.secondary)

            if picking {
                Button("Done") {
                    Task {
                        _ = await Notifications.requestAuthorization()
                        model.finishPermissions()
                    }
                }
                .buttonStyle(.primaryPill)
            } else {
                Button("Yes, let's go") {
                    Task {
                        working = true
                        await model.permissions.requestAll()
                        working = false
                        model.finishPermissions()
                    }
                }
                .buttonStyle(.primaryPill)
                .disabled(working)

                Button("Let me pick") {
                    withAnimation(Theme.rise) { picking = true }
                }
                .buttonStyle(QuietLinkStyle())
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .background(Theme.background)
    }
}

private struct PermissionRow: View {
    let kind: PermissionKind
    let picking: Bool
    let isOn: Bool
    let request: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: kind.symbol)
                .font(.system(size: 21, weight: .medium))
                .foregroundStyle(Theme.pinkLight)
                .frame(width: 44, height: 44)
                .background(Theme.pinkTile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text(kind.title)
                .font(.sora(18, .medium))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            if picking {
                Toggle(kind.title, isOn: Binding(get: { isOn }, set: { on in if on { request() } }))
                    .labelsHidden()
                    .tint(Theme.pink)
                    .disabled(isOn)
            } else if isOn {
                Image(systemName: "checkmark")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.pinkLight)
                    .accessibilityLabel("Allowed")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 72)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    PermissionView()
        .environment(AppModel.shared)
        .background(.black)
}
