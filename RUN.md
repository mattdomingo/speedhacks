# Run Recall

How to run the backend, connect Steph's phone line, run the app on the Simulator or your iPhone, and call Steph. Every command here was run on this Mac on 2026-10-11 unless it says otherwise.

## 1. Backend

Requires Node 22.15+ and npm.

```sh
npm ci
npm run setup          # creates .env with fresh secrets; never overwrites existing values
```

Add these to `.env` (gitignored; never commit it):

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | Steph's brain (`STEPH_PROVIDER=auto` uses Gemini when there is no `ANTHROPIC_API_KEY`) |
| `DIAL_API_KEY` | Dial REST key (`sk_live_…`) |
| `DEMO_CALLER_NUMBER` | The patient's phone, E.164 (the tester phone during testing) |
| `CAREGIVER_NUMBER` | Who `notify_caregiver` and the daily summary text |
| `DIAL_ALLOWED_NUMBERS` | Comma-separated E.164 allowlist. Dial calls/texts to anyone else are refused before any request |
| `TIMEZONE` | The patient's IANA zone, e.g. `America/Los_Angeles` |
| `DEMO_MODE` | `true` for the demo story |

`DIAL_WEBHOOK_SECRET` is written by `npm run dial:connect` (step 2).

```sh
npm run seed:demo      # the demo story for patient A (+ an isolated patient B)
npm start              # http://127.0.0.1:$PORT (PORT in .env; 3187 on this Mac)
curl -s http://127.0.0.1:3187/health
```

`/health` reports `checks` for the database, the Steph model provider, Dial and embeddings. Provider checks are cached for about a minute.

## 2. Public URL for Dial

Dial needs HTTPS, so expose the local server with a tunnel:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3187
# prints https://<random>.trycloudflare.com
npm run dial:connect -- https://<random>.trycloudflare.com
# then restart the server (Ctrl-C, npm start) so it loads the new webhook secret
```

`dial:connect` replaces any earlier tunnel registrations, then:
- registers the webhook for `call.ended`, `call.transcribed`, `message.received` and `message.status_changed` (text delivery receipts), and saves its signing secret to `.env`;
- connects the Context MCP at `/mcp` with the `Authorization: Bearer $DIAL_MCP_TOKEN` header;
- sets Steph's inbound instruction from `backend/voice/instructions.txt`;
- fires a `webhook.ping`.

Registrations pointing anywhere other than a tunnel (production) are never touched. A quick tunnel gets a new URL every time it starts, so rerun `dial:connect` after restarting it.

## 3. App on the Simulator

```sh
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
```

Set these in `ios/Config/Local.xcconfig` (gitignored). Keep the `$()` in the URL, because xcconfig treats `//` as a comment:

```
RECALL_API_BASE_URL = https:/$()/<random>.trycloudflare.com
RECALL_APP_TOKEN = <RECALL_APP_TOKEN from .env>
```

Build and launch:

```sh
cd ios
xcodebuild -project Recall.xcodeproj -scheme Recall \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build/DD CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot 'iPhone 17 Pro' 2>/dev/null; open -a Simulator
xcrun simctl install booted build/DD/Build/Products/Debug-iphonesimulator/Recall.app
xcrun simctl launch booted com.speedhacks.recall
```

In the app:
1. Tap **Get started**. Sign in with Apple is unavailable in unsigned simulator builds, so the app keeps a local profile.
2. Tap **Yes, let's go**.
3. On Home, triple-tap the **Recall** wordmark to load the demo memories.
4. Type "Where are my keys?".

## 4. App on your iPhone

1. Copy the example config to `ios/Config/Local.xcconfig` as above, and set:
   - `RECALL_TEAM`: your Apple team ID (Xcode → Settings → Accounts).
   - `RECALL_BUNDLE_ID`: an ID your team can sign, e.g. `com.<you>.recall`.
   - `RECALL_API_BASE_URL` and `RECALL_APP_TOKEN`: as in step 3.
2. If you use a **free personal team**, also add `RECALL_ENTITLEMENTS = Recall/Recall-NoSIWA.entitlements`. Personal teams cannot use Sign in with Apple; the app then keeps a local-only profile.
3. Plug in the iPhone and open `ios/Recall.xcodeproj`. Select the **Recall** scheme and your iPhone, then press Run.
4. The first time only:
   - Turn on **Settings → Privacy & Security → Developer Mode**, then restart the phone.
   - With a personal team, trust the profile: **Settings → General → VPN & Device Management → your Apple ID → Trust**.
Command-line alternative, which installed the app on the iPhone "ryan" on 2026-10-11. It uses the existing wildcard team profile, so no new App ID is needed:

```sh
cd ios
xcodebuild -project Recall.xcodeproj -scheme Recall -destination 'generic/platform=iOS' \
  -derivedDataPath build/DD-device RECALL_TEAM=3RXUMV93RN RECALL_BUNDLE_ID=com.ryanwang.recall \
  RECALL_ENTITLEMENTS=Recall/Recall-NoSIWA.entitlements build
xcrun devicectl list devices
xcrun devicectl device install app --device <device id> build/DD-device/Build/Products/Debug-iphoneos/Recall.app
```

Apple refuses new App IDs and Sign in with Apple until the account holder accepts the updated Program License Agreement at developer.apple.com. Until then, use the wildcard profile as above.

5. In the app:
   - Allow the permissions.
   - Triple-tap **Recall** for demo mode.
   - Use **Settings → Show Priya reminder** for the reminder card, or **Buzz me in 10 seconds** for a real notification.

## 5. Call Steph

- **Steph's number:** +1 240-896-2183. Call from the phone set as `DEMO_CALLER_NUMBER`; other numbers get a polite refusal and no data.
- **Try:** "Who is this?", "What day is it?", "Where are my keys?", "Who's coming today?", "Who is Sam?", "Remind me in 10 minutes to drink water."
- **Emergency:** "I fell and I can't get up". Steph tells you to call 911 and texts `CAREGIVER_NUMBER`.
- **Reminder call:** ask Steph to set a reminder, or create one in the app flow. The `/cron/dial-reminders` route places due calls. Locally:

  ```sh
  curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3187/cron/dial-reminders
  ```
