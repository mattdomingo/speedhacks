# Recall for iPhone

The iPhone app for [Recall](../README.md), built for the **Andreessen Horowitz (a16z) SpeedHacks hackathon**.

Meet **Steph**: a voice and text memory assistant with one home screen, an animated orb, and cards grounded in source memories. Ask where your keys were last seen, recall someone you know, or see context before an upcoming meeting.

![Recall demo flow: onboarding, permissions, the home screen, a reminder, keys, and a person card](docs/demo-flow.png)

*iPhone simulator screenshots with fictional demo memories.*

## Run it

Requires Xcode 26 and iOS 17+. The generated `Recall.xcodeproj` is committed. [XcodeGen](https://github.com/yonaskolb/XcodeGen) is only needed after changing project file membership: run `cd ios && xcodegen generate`.

1. From the repository root, copy `ios/Config/Local.xcconfig.example` to `ios/Config/Local.xcconfig` (gitignored).
2. For a physical device, set your Apple `RECALL_TEAM` and a `RECALL_BUNDLE_ID` your team can sign. A free personal team can set `RECALL_ENTITLEMENTS = Recall/Recall-NoSIWA.entitlements`; the app then uses a local profile.
3. Open `ios/Recall.xcodeproj`, select **Recall**, choose a simulator or device, and run.

Leave `RECALL_APP_TOKEN` empty to run with on-device answers. Type questions in the simulator; use a physical device to validate speech, notifications, real photo/calendar access, and background behavior.

## Demo mode

Triple-tap the **Recall** wordmark or use Settings → **Demo memories**. The fictional memories are dated relative to today, and demo searches stay separate from real records.

1. Open the home screen to meet Steph and her animated orb.
2. Choose **Show Priya reminder** for a card about coffee at 3 and a thoughtful follow-up. **Buzz me in 10 seconds** schedules the notification version; allow notifications, then lock the phone or go home.
3. Ask “Where are my keys?” The photo card includes its source and time. **Not there** searches again without that memory.
4. Ask “Who's Sam again?” to see a person card with linked details and a promise to send a restaurant recommendation.

The bundled keys photo shows keys on a wooden table; the fictional memory mentions a kitchen counter and fruit bowl. Replace it with an appropriate photo of your own before presenting that example as grounded visual evidence. See [asset credits](Recall/Resources/CREDITS.md).

### Medicine reminder demo

Settings → **Demo memories** → **Show medicine reminder** opens and speaks a fictional reminder. **Medicine reminder in 10 seconds** schedules a local notification. Both are labeled Demo, and **Thanks!** dismisses the card without recording that medicine was taken.

For the separate offline phone-reminder walkthrough, run `npm run demo:medicine` from the repository root. It sends no calls or texts; the two demos do not synchronize.

## Connected services

### Model-backed answers

The existing Node backend provides `/ask`, `/reminders`, and `/embed`. Provider keys stay on the backend. The shared app token gates these legacy stateless endpoints and cannot read shared personal records. See the [API contracts](../docs/development.md#steph-api-ios-app).

| Variable | Where | Purpose |
| --- | --- | --- |
| `RECALL_APP_TOKEN` | Backend and local iOS build settings | Separate app token, at least 32 characters; leave empty for on-device answers |
| `RECALL_API_BASE_URL` | Local iOS build settings | Backend origin; use `http:/$()/127.0.0.1:3000` for a Mac-local backend from the simulator |
| `STEPH_PROVIDER` | Backend | `auto`, `claude`, or `gemini`; automatic selection prefers Claude when its key is set |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Backend | Optional answer provider |
| `VOYAGE_API_KEY` | Backend | Optional embeddings; on-device alternatives remain available |

In xcconfig files, write HTTPS URLs as `https:/$()/host` because `//` starts a comment. Configure the backend using the [development guide](../docs/development.md). On-device fallback repeats stored memory details and reports uncertainty when evidence is insufficient.

### Shared memories

[Pair a device](../docs/ios-memory.md) to query the same patient-scoped Google Calendar, Gmail, and camera evidence as the phone assistant. Pairing uses a separate credential stored in device-only Keychain storage. It enables read-only lookups and keeps shared evidence transient, outside the local SwiftData store.

## How it works

- **Memory.** SwiftData stores memories and links to people and places. On-device Vision indexes photo thumbnails; Calendar, Contacts, location visits, and parking events provide additional context. Statements become notes; questions do not.
- **Retrieval.** Embedding similarity, word overlap, people, time filters, recency, and confidence select local memories. Cards derive source lines from cited metadata.
- **Reminders.** Upcoming events, promises, birthdays, and parking context become candidates. Quiet hours, a daily cap, and feedback limit interruptions.
- **Presentation.** SwiftUI cards share one main action. The orb follows listening and speaking activity and respects Reduce Motion.
- **Privacy.** Phone photos stay on the device. Model-backed answers send selected text snippets; the legacy answer routes do not store them. Shared-memory services and the separate webcam uploader have their own backend storage and credentials.

Design and architecture decisions are recorded in the [engineering guide](../AGENTS.md#decision-log).

## Tests

From the repository root on macOS:

```sh
cd ios
xcodebuild -project Recall.xcodeproj -scheme Recall \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO test
```

Choose a simulator installed in your Xcode version. Unit tests cover retrieval, local answers, cards, proactive reminders, storage, and motion. The UI walkthrough attaches screenshots for demo and onboarding steps.

Launch arguments include `-RecallInMemoryStore`, `-RecallDemo`, `-RecallSkipOnboarding`, and `-phase permissions`. See [validation and known gaps](../docs/testing/README.md) for the distinction between local tests, historical live checks, and physical-device acceptance.
