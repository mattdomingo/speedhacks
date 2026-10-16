# Run Recall

A local walkthrough of Recall, built for the **Andreessen Horowitz (a16z) SpeedHacks hackathon**. For API contracts and integration configuration, see the [development guide](docs/development.md).

## Backend

Requires Node.js 22.15–22.x and npm. From the repository root:

```sh
npm ci
npm run setup
npm start
```

Setup creates an ignored, owner-readable `.env` with distinct service tokens. Existing values are preserved. SQLite stores local data in the ignored `data/` directory; leave `DATABASE_URL` empty for this workflow.

In another terminal:

```sh
curl --fail http://127.0.0.1:3000/health
```

Use the `PORT` from `.env` if you changed it. `/health` reports database readiness and whether optional provider credentials are configured. `/` returns 404 because there is no web frontend. Use `npm run dev` for watch mode.

## Offline reminder demo

```sh
npm run demo:medicine
```

This uses a temporary SQLite database, a simulated clock, and a fake Dial client. It demonstrates scheduling, a single dispatch, an answered call, and one missed-call fallback text. It sends no calls or messages and requires no provider credentials or running backend. The fictional reminder does not track whether medicine was taken.

## iPhone demo

Requires macOS, Xcode 26, and an iOS 17+ simulator or device.

1. Copy `ios/Config/Local.xcconfig.example` to the ignored `ios/Config/Local.xcconfig`.
2. For a physical device, set your own `RECALL_TEAM` and a `RECALL_BUNDLE_ID` your team can sign. Free personal teams can use `Recall/Recall-NoSIWA.entitlements`.
3. Open `ios/Recall.xcodeproj`, select the **Recall** scheme, and run on your simulator or device.
4. Open Settings → **Demo memories**, or triple-tap the **Recall** wordmark, to load fictional memories.
5. Type “Where are my keys?” or “Who's Sam again?” to explore the cards. **Show Priya reminder** opens the proactive reminder example.

Leave `RECALL_APP_TOKEN` empty to use on-device answers. Optional model-backed answers and shared-memory pairing are described in the [iPhone guide](ios/README.md). A physical device is needed to validate microphone, notification, and background behavior.

## Optional integrations

The local demo does not require Google, Dial, or model-provider accounts. When connecting them, use an isolated test environment and the [development guide](docs/development.md#optional-integrations). Keep all credentials in ignored local configuration or your hosting provider's secure settings.

- [Google Calendar and Gmail](docs/development.md#google-connection): connect a consented test account using read-only OAuth scopes.
- [Dial voice and reminders](docs/development.md#connect-dial): configure a line you control, the authenticated MCP endpoint, and signed webhooks. Set `DIAL_ALLOWED_NUMBERS` to consented test recipients before exercising real delivery.
- [Camera capture](docs/object-memory.md): install the Python dependencies and run the uploader on a machine with webcam access. Live recognition also needs a backend Gemini key.
- [iPhone shared memories](docs/ios-memory.md): provision a separate per-device credential.

## Checks

```sh
npm test
python3 -m unittest discover -s camera -p 'test_*.py'
npm run keewano:codegen -- --check
npm run demo:medicine
```

See [validation](docs/testing/README.md) for disposable Postgres tests, iOS testing, and the distinction between local fixtures and live integration evidence.
