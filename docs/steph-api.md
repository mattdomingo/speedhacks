# Steph everywhere: app ↔ backend contract

One Steph serves every channel: the in-app orb, Dial phone calls, Dial texts and push notifications. The backend (`backend/brain/`) owns her memory, her conversation timeline and every third-party token. The app holds only a **session token**.

All `/v1` endpoints take and return JSON. Authenticated endpoints need `Authorization: Bearer <session_token>`; a missing or revoked session returns `401 {"error":"Unauthorized"}`. Phone numbers are E.164. Times are ISO-8601 with an offset. Unknown fields are ignored.

## Setup and sign-in

The three setup screens map to these calls.

### Screen 1: Meet Steph

**Continue with Google**

1. `POST /v1/auth/google/start` `{"mode":"self"|"caregiver"}` → `{"authorization_url": "https://accounts.google.com/..."}`. 503 when Google is not configured on the backend.
2. Open the URL in `ASWebAuthenticationSession` with callback scheme `recall`. Google asks for every scope on one consent screen. The backend stores the tokens encrypted, then redirects to `recall://auth?code=<one-time code>`. A failure redirects to `recall://auth?error=<reason>`.
3. `POST /v1/auth/exchange` `{"code":"..."}` → `{"session_token":"...","user":User}`. The code is single-use and expires after 5 minutes.

**Use Apple instead**: `POST /v1/auth/apple` `{"identity_token":"<JWT from ASAuthorizationAppleIDCredential>","full_name":"Ada Lovelace"?}` → `{"session_token","user"}`. The backend verifies the token against Apple's keys, with `aud` = the app's bundle ID. Google can be connected later by asking Steph "connect my Google". She answers with a card whose `action` is `{"type":"open_url","url":...}`.

**I'm setting this up for someone else** is Google sign-in with `"mode":"caregiver"`. The returned user has `role:"caregiver"`. Then:

- the caregiver verifies their own number (screen 2, so they can get daily summaries);
- they enter the patient's number: `POST /v1/caregiver/patient/start` `{"phone":"+1...","name":"Mom"}`, which texts a code to the patient;
- they enter that code: `POST /v1/caregiver/patient/verify` `{"phone":"+1...","code":"123456"}` → `{"session_token","user"}`. The new session belongs to the **patient** (`role:"patient"`, `caregiver` set), and the app replaces its token with it. From here on the device is the patient's: show only the orb and the shortcut buttons.

### Screen 2: What's your phone number?

- `POST /v1/auth/phone/start` `{"phone":"+14155550123"}` → `{"sent":true,"expires_in":600}`. Steph texts `Your Steph code is 123456` from her Dial number. 429 after 5 sends in an hour; 503 when Dial is not configured.
- `POST /v1/auth/phone/verify` `{"phone":"+1...","code":"123456"}` → `{"user":User}`. 400 on a wrong or expired code; 5 wrong tries invalidate the code. Use `textContentType = .oneTimeCode` and submit as soon as 6 digits arrive.

This verified number is where Steph calls and texts, and how she recognizes the person when they call or text her.

### Screen 3: Can Steph look around your phone?

When the permission chain finishes, call `POST /v1/setup/complete` `{"time_zone":"America/Los_Angeles","briefing_time":"08:15"?}` → `{"user":User}`. This starts the Google backfill, schedules the first morning briefing and records `setup_completed_at`. Adding Steph to Contacts happens on the device (name "Steph", number `user.steph_number`, the pink orb photo).

### User

```json
{
  "id": "u_…", "name": "Ada", "role": "self" | "caregiver" | "patient",
  "phone": "+14155550123" | null, "phone_verified": true,
  "steph_number": "+12408962183",
  "time_zone": "America/Los_Angeles",
  "google": {"connected": true, "email": "ada@gmail.com", "sources": ["calendar","gmail","contacts","tasks","photos"]} | null,
  "caregiver": {"name": "Sam", "phone_last4": "0199"} | null,
  "patient": {"id": "u_…", "name": "Mom"} | null,
  "settings": {"quiet_start":"21:00","quiet_end":"08:00","briefing_time":"08:15","max_calls":2,"max_texts":5,
               "calls_enabled":true,"gmail_enabled":true,"health_enabled":false,"medication_calls":true},
  "backfill": {"state": "running" | "done" | "idle", "memories": 412},
  "setup_completed_at": "…" | null
}
```

`GET /v1/me` returns the same `User`. There is no settings screen: the person changes settings by asking Steph, and the app shows the current values read-only.

## Talking to Steph in the app

`POST /v1/steph/message`

```json
{"text": "What's my day look like?",
 "context": {"in_app": true, "foreground": true, "locale": "en-US",
             "location": {"lat": 37.77, "lon": -122.41, "place": "Home"}?}}
```

→

```json
{"reply": {"id": "t_…", "text": "You have coffee with Priya at 3, and your package arrives today.",
           "card": {"card_type": "answer"|"person"|"place"|"photo"|"message"|"confirm"|"connect",
                    "title": "Today"?, "buttons": ["Thanks!"], "action": {"type":"open_url","url":"…"}?,
                    "pending_action_id": "pa_…"?},
           "memories": [{"id":"m_…","type":"event","summary":"Coffee with Priya","people":["Priya"],
                         "place":"Blue Bottle","time":"…","source":"google-calendar","confidence":1}]},
 "deliveries": [{"channel":"sms","reason":"texted: it's a confirmation number you'll need later","at":"…"}],
 "backfilling": false}
```

- Speak `reply.text` and show the card. `memories` are the cited records, so source lines come from them, not from the model.
- When `backfilling` is true and nothing useful is stored yet, the reply text is "I'm getting to know your day. Give me a minute."
- `card_type:"confirm"` means Steph asked before something she may only do on an explicit yes, such as forgetting a memory or disconnecting Google. Tapping **Yes** sends `POST /v1/steph/confirm` `{"pending_action_id":"pa_…","answer":"yes"|"no"}` → the same shape as `/message`. Saying "yes" also works.
- `deliveries` lists anything she also sent on another channel during this turn, for example the confirmation number she texted.
- 503 `{"error":"Steph's brain is not configured"}` when `ANTHROPIC_API_KEY` is missing. The app then answers on-device as it does today.

## Call me / Text me (hold the orb)

- `POST /v1/steph/call-me` `{}` → `{"call_id":"…","status":"queued"}`. Steph calls the verified number now. The call opens with the last thing she said in the app, and the full Steph persona and tools are available on the call. User-initiated, so not capped.
- `POST /v1/steph/text-me` `{"text"?: "…"}` → `{"message_id":"…","sent_at":"…","text":"…"}`. Texts what Steph just said in the app (her last app reply), or `text` when given.
- Both return 409 `{"error":"Verify your phone number first"}` without a verified number, and 503 when Dial is not configured.

## Orb status

`GET /v1/steph/status` → poll every 10 s while the app is open, and immediately after Call me / Text me.

```json
{"state": "idle" | "calling" | "texted" | "scheduled",
 "caption": "STEPH IS CALLING" | "STEPH TEXTED YOU · 2:14 PM" | "STEPH WILL CALL AT 3:00" | null,
 "call": {"id":"…","status":"ringing"|"in-progress"}?,
 "message": {"id":"t_…","text":"Your gate is B22…","at":"…"}?,
 "next_call": {"at":"…","reason":"Medication: blood pressure pill"}?}
```

- `calling` takes priority, then an unread text from the last 12 hours, then the next scheduled call within 12 hours.
- Tapping the texted orb opens `message` as a card and sends `POST /v1/timeline/{id}/seen`, which clears the dot.

## Timeline

`GET /v1/timeline?before=<iso>&limit=50` → `{"entries":[{"id":"t_…","channel":"app"|"call"|"sms"|"push","direction":"in"|"out","text":"…","at":"…","call_id"?:"…"}]}`, newest first. Every exchange on every channel is here, including call transcripts after `call.transcribed`.

## Diagnostics

`GET /v1/diagnostics` →

```json
{"decisions": [{"at":"…","item":"Medication: blood pressure pill","channel":"call",
                "reason":"called: medication time needs a response and the push was ignored for 10 minutes"}],
 "counts_today": {"calls": 1, "texts": 2, "limits": {"calls": 2, "texts": 5}},
 "quiet_hours": {"start":"21:00","end":"08:00","active":false},
 "sources": [{"name":"google-calendar","state":"ok","count":214,"last_sync":"…"}],
 "push": {"registered": true}}
```

## Memories from the phone

The phone keeps its on-device indexing: PhotoKit + Vision, EventKit, Contacts, location visits and parking, and HealthKit when the person asks Steph to use it. It uploads **text memories only**, never images.

- `POST /v1/memories/sync` `{"upserts":[Memory],"deletes":["<source_ref>"]}` → `{"accepted":N}`. A memory is `{"source_ref":"photos:<localIdentifier>","type":"photo"|"event"|"person"|"place"|"note"|"task"|"health"|"location","summary":"…","people":[],"place":null,"time":"…","source":"photos"|"apple-calendar"|"apple-reminders"|"contacts"|"location"|"health"|"app","confidence":0.8,"details":{}?}`, with at most 200 per call. `source_ref` is unique per user; a re-upload updates in place.
- `GET /v1/memories/changes?since=<iso>` → `{"tombstones":[{"source_ref":"…","deleted_at":"…"}],"server_time":"…"}`. "Forget that" deletes a memory everywhere: delete local copies whose `source_ref` appears here and never upload them again.

## Push notifications

- `POST /v1/devices` `{"apns_token":"<hex>","environment":"sandbox"|"production"}` → `{"registered":true}`.
- A push payload carries `{"aps":{...},"steph":{"timeline_id":"t_…","kind":"reminder"|"medication"|"briefing"|"leave_by"}}`. When the person opens it, send `POST /v1/push/{timeline_id}/opened`. An urgent push not opened within 10 minutes escalates to a call; a normal one escalates to a text after its grace period.
- Pushes need `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY` and `APNS_TOPIC` on the backend. Without them the router never picks push and falls back to text.

## How Steph picks a channel (ChannelRouter)

Applied in order to everything Steph says or sends:

1. The person's explicit choice ("text me that", "call me at 3") wins.
2. The person is in the app right now: answer in the orb, with a card.
3. Urgent and needing a response (medication time, leaving soon for an appointment, a caregiver "must confirm" item, a push ignored for 10 minutes): call.
4. Information to keep or act on later (address, door code, list, link, confirmation number, summary): text.
5. A short, time-relevant nudge while the app is closed: push, then text if not opened within the grace period.
6. Quiet hours (default 21:00–08:00) block calls and texts unless the item is marked "wake me".
7. At most 2 calls and 5 texts a day that Steph starts herself, unless the person asked.

Every decision is stored with its reason and shown in Diagnostics.
