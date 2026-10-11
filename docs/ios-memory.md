# Connect the iPhone app to Steph's shared memories

The app now has two explicit modes. Without pairing, it searches memories on the phone. With pairing, questions also use the same patient-scoped calendar, email, object, person, and caregiver-memory lookup functions as Dial. Dial continues handling calls. Demo mode stays isolated and never reads shared records.

## Pair a device

1. Deploy the app-memory routes and build the updated iOS app. This change needs no database migration. Keep production and preview credentials separate.
2. In an ignored local `.env`, set `APP_PAIRING_PATIENT` to the existing consented patient's E.164 number (or use the existing `DEMO_CALLER_NUMBER`). That patient must already exist in the target backend's caller configuration.
3. Run `node scripts/create-app-device.mjs`. It creates a private, gitignored `.app-device/` directory containing `device-code.txt` and `registration.json`. It refuses to overwrite an existing directory and prints no credentials or caller numbers. Use a different `.app-device-*` directory for each device.
4. Set the backend environment variable `RECALL_PATIENT_TOKENS` to the JSON array in `registration.json`, preserving existing device registrations. It contains only the token hash and patient mapping. Redeploy the target environment. Never put the raw code, hash registry, patient number or provider credentials in the iOS build configuration.
5. On the phone, open **Settings → Connected memories**, enter the private device code, and enter the existing memory PIN if the backend requires it. Tap **Connect memories**. This checks authentication before saving the code in device-only Keychain storage. The backend URL comes from `RECALL_API_BASE_URL`; connections are bound to that URL.

The old `RECALL_APP_TOKEN` still gates stateless `/ask`, `/embed` and `/reminders`. It cannot read shared records. A device credential only enables read-only `/app/session` and `/app/ask`; it cannot place calls, send messages, change records, or use camera upload routes. Existing PIN lockout applies across phone and app.

**Disconnect shared memories** clears the local credential and current answer. To revoke a lost device, remove its hash from `RECALL_PATIENT_TOKENS` and redeploy. Vercel keeps old environment values on old deployment URLs: disable or protect every prior deployment that retains the revoked hash and verify those URLs reject it too. A new production alias alone does not revoke old deployments. Shared evidence is rendered transiently, not copied into SwiftData. Local notes are still local; this change does not synchronize the entire phone database or make app-created notes available by phone.

shortcut: device provisioning is manual for the supervised demo; replace it with verified user sign-in, device enrollment, expiry and server-managed revocation before broader distribution.

## API

- `POST /app/session`: device bearer token; body `{ "pin": "optional existing PIN" }`; returns `{ "connected": true }` after authentication/PIN, without model inference or record retrieval.
- `POST /app/ask`: same auth; existing `/ask` question/local-memory body plus optional `pin` and `excluded_ids` (up to 24 returned shared IDs). Returns the answer card plus `evidence` containing only cited shared records with source, capture/event timestamp and `demo:false`. PIN never goes into a model prompt.
- Lookup/provider/authentication failures return errors. The paired app shows **LOOKUP UNAVAILABLE** instead of quietly presenting unrelated local evidence. Unpaired cloud failures explicitly identify the local-only fallback.
- A validated, bounded model plan can request at most three read-only lookups. Calendar/email lookups retain existing Google generation and scope checks; only the primary patient can query that connection. Camera answers must say last confirmed sighting with its time.

## Acceptance

Use isolated test records and credentials first. Verify calendar details, a recent email and a camera last sighting match the same patient's MCP results. Verify an unpaired/legacy app token and another patient's credential cannot read those records. Disconnect the device and verify no shared answer can finish afterward. Check demo mode never displays real records. Test an unavailable backend and wrong/missing PIN: neither should claim the memories are empty.

Local backend fixtures and simulator tests do not establish live Google access, physical-device Keychain behavior, model quality or a production deployment. Record those separately when performed. No test should place a phone call automatically.
