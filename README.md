# Recall

Phone memory assistant hackathon scaffold. A person calls a number, asks about a plan or misplaced object, and hears an answer grounded in timestamped evidence.

Engineers and coding agents: start with [AGENTS.md](AGENTS.md) for shared working rules, ownership, verification, and the [decision log](AGENTS.md#decision-log).

Production API: **https://recall-kappa-nine.vercel.app**. Check [health](https://recall-kappa-nine.vercel.app/health); connect Dial to `https://recall-kappa-nine.vercel.app/mcp`. This is an API backend; `/` returns 404.

**iPhone app:** [Recall for iPhone](ios/README.md) is the Steph app: one orb, cards that rise from it, on-device memory, and proactive reminders. It talks to this service's [Steph API](#steph-api-ios-app).

The camera observer recognizes keys, a phone, and a wallet on a fixed tabletop and remembers their last confirmed locations. Configure a paid Gemini project on the backend to enable recognition. Without a key, uploads still work and report `not_configured`. Google accounts and Dial calls remain separate integrations.

## Architecture

```mermaid
flowchart LR
    Caller[Person calling] <--> Dial[Dial managed voice agent]
    Dial <-->|Context MCP: authenticated tools| Backend[Hosted backend]
    Backend <-->|Digital module: OAuth, cron sync, live fallback| Google[Calendar and email]
    Backend <-->|Read and write evidence| Store[(Managed Postgres on Vercel)]
    Cron[Vercel Cron] -.->|Google sync every 10 minutes| Backend
    Dial -.->|Signed webhooks: call events| Backend
    Backend -.->|Optional: pseudonymous tool analytics| Keewano[Keewano]
    Camera[Laptop webcam process] -->|HTTPS: authenticated frames| Backend
    Backend <-->|Stateless snapshot analysis| Vision[Gemini vision]
```

One monorepo, two running processes: a hosted Node/Express backend and a Python webcam process on a laptop. Digital and physical memory are modules within the same backend. Vercel's `services` configuration contains one hosted service, `recall`; `camera/` is a hardware capture client, not a deployable HTTP service. Local development and Docker Compose use SQLite unless `DATABASE_URL` is set.

Dial owns speech recognition, conversation, and speech playback. Its managed voice agent calls the backend's MCP tools during the call. The camera collects evidence before a call; object lookup retrieves historical observations rather than describing only the current room.

The camera makes outbound HTTPS requests, requiring no public laptop port. The backend retains the latest raw frame plus one confirmed record/photo per category. It requires two matching, certain sightings of a resting object, both assessed as clearly visible, before updating memory. Missing or partially occluded objects preserve the previous location and capture time. See the [object-memory runbook and phone handoff](docs/object-memory.md).

## Ownership

| Engineer | Owns | Next work |
| --- | --- | --- |
| 1: Phone and deployment | `backend/voice/`, `backend/app.mjs`, database adapters, Vercel and Docker configuration | Maintain hosted infrastructure, connect Dial MCP, and test a real call |
| 2: Digital memory | `backend/digital/` (Google adapter and its SQLite/Postgres stores), `backend/analytics/` | Connect a real Google test account in each environment; confirm Dial header names on a live call |
| 3: Physical memory | `camera/`, `backend/physical/` | Validate real tabletop accuracy, latency, and missed placements |

`contracts/index.mjs` defines shared payload validation and tool inputs. Coordinate changes here before changing producers or consumers. Engineer 1 owns the shared backend deployment.

Store calls may be asynchronous: always `await` reads and writes so both SQLite and Postgres work. Finish required processing and writes before sending an HTTP response. Keep durable state in the database; a process-local cache or a background task after the response is not durable on Vercel. Schema changes belong in `backend/schema.sql` and must be applied to each environment before code depends on them.

## Local startup

Requires Node 22.15.x–22.x and npm; optional camera capture uses Python 3.12+. Node's built-in SQLite API is experimental in this version.

```sh
npm ci
npm run setup
```

Setup creates an ignored, owner-readable `.env` with distinct secrets. It never changes existing values; on an older `.env` it only appends secrets added since (`ADMIN_TOKEN`, `GOOGLE_TOKEN_KEY`, `CRON_SECRET`). Set `DEMO_CALLER_NUMBER` there to a consented test caller's E.164 number, then:

```sh
npm start
```

Health: `http://127.0.0.1:3000/health`. MCP: `http://127.0.0.1:3000/mcp`. Watch mode: `npm run dev`.

`DEMO_MODE=true` seeds the demo story at startup, dated today in the user's zone (`TIMEZONE`, else the Google calendar's, else UTC): keys on the kitchen counter next to the fruit bowl, the car on Level 3 spot 42, coffee with Priya at 3 PM and a note that her mom had surgery, Sam Chen (friend; the Tokyo ramen promise; lunch three weeks ago), daughter Maya visiting at 4 PM, a caregiver note about pills, and a separate demo patient B (`+15555550199`, son Diego) that the primary caller must never see. `npm run seed:demo` loads the same records into the configured database on demand; re-running the same day changes nothing. Seeded records have `demo: true`. Setting the flag to false stops seeding and excludes synthetic calendar, email, camera, people, notes, and caregiver records from lookup, including fixtures already in the database. It does not erase records. Live object evidence always takes priority over fixtures. Google reads require connecting the intended account separately.

## Contracts

| Endpoint/tool | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | `ok` (database ping; 503 when it fails), demo flag, and `checks`: `db`, `claude`, `dial`, `embeddings` each `ok`/`missing`/`invalid`/`error` (provider keys probed with a cheap read, cached 60 s). `search: "on-device"`: memory search runs on the phone |
| `POST /mcp` | `Bearer DIAL_MCP_TOKEN` | Stateless Streamable HTTP MCP; other methods return 405 |
| `get_schedule({date, end_date?})` | Known patient, inbound | Calendar plans for one local day or an inclusive range of up to 31 days |
| `search_messages({query?, date?, end_date?})` | Known patient, inbound | Omit query for up to five recent emails; supply sender/topic clues and/or an inclusive local date range (up to 31 days). Live mode excludes fixtures. |
| `find_object({object})` | Known patient, inbound | Latest matching observation by capture time |
| `who_is({name})` | Known patient, inbound | The caller's own people and notes matching a name or relationship |
| `care_instructions({topic})` | Known patient, inbound | Instructions the caregiver saved (source `caregiver`), repeated as-is |
| `notify_caregiver({reason})` | Known patient on Steph's line, inbound or outbound; no PIN | Text the patient's caregiver; at most 3 per hour per patient; listed only when `DIAL_API_KEY` is set |
| `whats_today()` | Demo caller on Steph's line, inbound or outbound | Local date and time; listed only when `DIAL_API_KEY` is set, like the reminder tools |
| `set_reminder({text, in_minutes \| at, channel?})` | Demo caller on Steph's line, inbound or outbound | Schedule a reminder call (default) or text; `at` is local `YYYY-MM-DDTHH:MM` |
| `list_reminders()` / `cancel_reminder({id})` | Demo caller on Steph's line, inbound or outbound | The caller's upcoming reminders, soonest first |
| `POST /camera/frame` | `Bearer CAMERA_TOKEN` | Store latest JPEG, at most 500 KB; return frame ID and actual inference status |
| `GET /camera/frame` | `Bearer CAMERA_TOKEN` | Retrieve latest JPEG with `X-Captured-At` |
| `GET /camera/status` | `Bearer CAMERA_TOKEN` | Capture/analysis freshness, processing errors, latency, token usage |
| `GET /camera/evidence/:frameId` | `Bearer CAMERA_TOKEN` | Retrieve a retained confirming JPEG; no public image URLs |
| `POST /camera/observations` | `Bearer CAMERA_TOKEN` | Persist a placement observation |
| `POST /google/connect` | `Bearer ADMIN_TOKEN` | Start Google OAuth; returns a 10-minute consent link |
| `GET /google/callback` | Single-use OAuth state | Google redirect target; stores the encrypted refresh token, then syncs |
| `GET /google/status` | `Bearer ADMIN_TOKEN` | Connection, granted scopes, sync results, record counts |
| `POST /google/sync` | `Bearer ADMIN_TOKEN` | Sync Calendar and Gmail now |
| `DELETE /google/connection` | `Bearer ADMIN_TOKEN` | Revoke at Google and delete synced Google evidence |
| `GET /cron/google-sync` | `Bearer CRON_SECRET` | Vercel Cron: sync Google and prune expired Dial events |
| `GET /cron/dial-reminders` | `Bearer CRON_SECRET` | Vercel Cron, every minute: submit due reminders and reconcile call/text outcomes |
| `GET /cron/caregiver-summary` | `Bearer CRON_SECRET` | Vercel Cron, daily 02:00 UTC: one summary text per patient per local day to their caregiver, never 9 PM–8 AM patient time |
| `POST /webhooks/dial` | `X-Dial-Signature` HMAC (5-minute window) | Store Dial events once per `X-Dial-Event-ID`. `call.ended` settles reminder calls and flags missed calls; `call.transcribed` fetches the call and stores the patient's words (source `call`); `message.received` stores a patient's text; `message.status_changed` settles text delivery; `webhook.ping` and other types are acknowledged |

With `CALLER_PIN` set, each memory and reminder tool also takes `pin` (`whats_today` does not); without it the tool answers "A PIN is required" and the voice agent asks the caller (see `backend/voice/instructions.txt`). Wrong attempts are counted atomically, including concurrent requests; five wrong PINs cause lockout for the remainder of the 15-minute failure window. A correct PIN before lockout resets the count; a missing PIN does not increment it. `/mcp` also rejects JSON-RPC batches.

For the owner's supervised October 11 phone demo, Production temporarily leaves `CALLER_PIN` unset so the allowed caller can use memory tools without a PIN. Bearer authentication, the caller allowlist, and inbound-only memory access still apply. This is the explicit [DEC-021 demo exception](AGENTS.md#dec-021--temporarily-omit-the-pin-for-the-supervised-phone-demo); the stronger authentication guidance below still applies outside that exception. Re-enable a backend PIN and redeploy to restore the prompt and check.

Observation body:

```json
{
  "object": "keys",
  "location": "beside the blue mug on the desk",
  "timestamp": "2026-10-11T14:14:00-07:00"
}
```

Frame bodies still contain `timestamp` and `jpegBase64`. Upload acceptance does not imply recognition: `inference` can be `analyzed`, `busy`, `throttled`, `ignored`, `stale`, `failed`, `superseded`, or `not_configured`. An analyzed frame may confirm zero objects.

Memory tools return `{"status":"supported","evidence":[...]}` or `{"status":"unknown","evidence":[]}`. Each evidence record has an ID, source, text, timestamp, and demo flag; Google records add `origin` (`google-calendar`/`google-gmail`) and `ref` (a link to the original event or thread). Unauthorized/failed tools return errors, not proof that nothing happened: if Google cannot be reached, or access expired, and nothing is stored, the tool errors instead of answering "unknown". Calendar plans do not prove attendance; declined, tentative and unanswered invitations say so; email evidence names the sender's address beside the display name; camera observations are last-seen locations.

## Google connection

Read-only scopes: `calendar.readonly` and `gmail.readonly` (Gmail search needs the latter; `gmail.metadata` cannot search). Both are sensitive/restricted, so keep the OAuth consent screen in **Testing** with the demo account as a test user. Google expires Testing-mode refresh tokens after 7 days; status then reads `reconnect_required` and you connect again.

1. In Google Cloud Console, enable the Calendar API and Gmail API, configure the consent screen (External, Testing, add test users), and create an OAuth client of type **Web application**. Authorize `http://localhost:3000/google/callback` for local use and `https://recall-kappa-nine.vercel.app/google/callback` (or the preview origin) when hosted.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ADMIN_TOKEN`, `GOOGLE_TOKEN_KEY` and `CRON_SECRET` in `.env` or the Vercel environment (`npm run setup` generates the secrets). A partial Google configuration fails at boot. **Set `CALLER_PIN` too:** caller ID can be spoofed, and the PIN is what keeps a stranger from hearing this mailbox.
3. On Postgres, apply and verify `npm run db:init` on the isolated preview database first, then apply the same reviewed schema to production before deploying dependent code. It adds the Google, Dial-event and PIN tables without copying SQLite records. SQLite creates them on open.
4. `npm start` (or deploy), then `npm run google -- connect` and open the printed link within 10 minutes. Use `BACKEND_URL=https://…` for a hosted backend. The callback page appears after the first sync finishes.
5. `npm run google -- status` shows the account, scopes, last sync and record counts; `sync` forces a sync; `disconnect` revokes access and deletes synced Google evidence.

Completing a new consent flow clears the previous Google evidence and sync state, even when reconnecting the same account, before attempting a fresh sync. Consent can succeed while that first sync fails. Google answers may then be unavailable until a sync or live lookup succeeds; inspect `status` and retry `sync`. The previous account snapshot is not retained as a fallback.

How retrieval works during a call:

- A sync replaces the stored copy of calendar events from 7 days ago to 60 days ahead, and of mail matching `GMAIL_SYNC_QUERY` (default: the last 30 days, excluding promotions and social), capped at `GMAIL_SYNC_LIMIT` (at most 250, inside Gmail's per-minute quota). Cancelled or deleted items disappear on the next sync. Syncs run after connecting, from Vercel Cron (`vercel.json`, `*/10 * * * *` on the existing Pro plan), via `npm run google -- sync`, and every `GOOGLE_SYNC_MINUTES` on long-running servers (not on Vercel, whose process timers are not durable).
- Tools answer from the database while the copy is fresh (synced within twice `GOOGLE_SYNC_MINUTES`, at least 30 minutes). Otherwise, and for dates outside the window or searches with no stored match, they ask Google inside the request under one `GOOGLE_LIVE_TIMEOUT_MS` deadline (default 1.5 s). Live mail search stays inside `GMAIL_SYNC_QUERY`. Nothing runs after the response (DEC-004).
- For "what's in my email?", `search_messages({})` checks Gmail within that same deadline even when the stored copy is fresh, then returns up to five messages ordered newest first. Existing clients can also send `query: "recent emails"` (or `email` / `inbox`). A failed live recent-mail check is an error, never an empty inbox or an unlabeled stale fallback. Specific searches keep the existing cache/fallback behavior. Results still cover only `GMAIL_SYNC_QUERY` (normally 30 days, excluding promotions/social), not every message or the full body.
- For "what did I do yesterday/last week?", `get_schedule({date, end_date})` retrieves calendar plans over an inclusive range; `search_messages` accepts the same range to retrieve related emails. Dates use the account's configured time zone, including daylight-saving boundaries. Range calendar lookups go directly to Google within one deadline and do not replace the synced window; dated email lookups also check live. Failed range checks return errors rather than partial cached answers. Tool descriptions provide yesterday, last Monday-Sunday, and the past seven days explicitly. Calendar records establish plans, and email timestamps establish messages received, not attendance or completed activities.
- Phone acceptance: ask "What is in my email?", "What did [sender] say about [topic]?", "What did I do yesterday?", "What about last week?", then "I think I forgot something." Steph should retrieve recent mail, search the clue, use the requested date/range, and offer email/calendar/reminder choices when no source is clear. She must cite sender/date and avoid claiming an action is overdue, completed or forgotten without evidence. After deployment, update the Dial number's saved instruction from `backend/voice/instructions.txt` and refresh its Context MCP discovery; changing this file alone does not update the managed phone agent. A direct MCP test does not prove a real call.
- Dates use `TIMEZONE`, else the Google calendar's zone, else UTC, including daylight-saving changes. `get_schedule`'s description tells the voice model today's date in that zone.
- Email text is the sender, subject and Gmail's snippet (at most 300 characters), never full bodies. The refresh token is encrypted with AES-256-GCM; Google writes and lookup responses are bound to the active connection and granted scopes, including across disconnects and reconnections.

## Steph API (iOS app)

The Recall iOS app (Steph) uses three JSON endpoints on the same service. Each requires `Authorization: Bearer RECALL_APP_TOKEN`; while that variable is empty they return 503 `{"error":"Steph is not configured"}`, so existing deployments are unaffected.

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /embed` | `{texts: 1–64 strings ≤2000 chars, input_type?: "document"\|"query"}` | `{model, dimensions, embeddings}` in input order, from Voyage AI; 503 without `VOYAGE_API_KEY` |
| `POST /ask` | `{question, now, time_zone?, memories: ≤24}` | `{answer, card_type, memory_ids, buttons}`; 503 when no model provider is configured, or `{"error":"Steph is busy right now"}` when Gemini rate-limits |
| `POST /reminders` | `{now, time_zone?, candidates: 1–5 of {id, kind, title, when?, person?, memories: 1–12}}` | `{reminders: [{candidate_id, answer, card_type, memory_ids, buttons}]}`; failed candidates are omitted |

A memory is `{id, type: photo|event|person|place|note, summary, people, place?, timestamp, source, confidence}`. `/ask` and `/reminders` send Steph's product system prompt verbatim (`backend/steph/prompt.mjs`) to the configured model with structured JSON output, then keep only memory IDs the phone supplied and at most two buttons; JSON wrapped in prose is recovered, and an unknown `card_type` becomes `answer`. A declined, blocked, truncated or failed answer returns 502 `{"error":"Steph could not answer"}`; the app then answers on device.

`STEPH_PROVIDER` picks the model: `auto` (default) uses Claude (`STEPH_MODEL`, default `claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set, otherwise Gemini (`STEPH_GEMINI_MODEL`, default `gemini-3.5-flash-lite`) when `GEMINI_API_KEY` is set; `claude` or `gemini` forces one. Gemini is called through `generateContent` with the same system prompt and user turn, a JSON response schema and minimal thinking (measured at 0.82 s per answer; `gemini-3.8-flash` does not accept minimal thinking and took 14.8 s at low). Anything but `finishReason: STOP`, or a blocked prompt, is a failed answer; 429 answers 503 "busy". `/health` reports the active provider and checks each key with a free read.

Memories live on the phone. Each request carries only the snippets needed for one answer (at most 24), and the backend stores none of them: no schema change, no pgvector. Photos never leave the phone; only short text descriptions do.

**`RECALL_APP_TOKEN` is a demo restriction, not user authentication.** It is a shared secret compiled into the app binary, like the caller-number allowlist. Before real personal records, add per-user authentication (for example, verified Sign in with Apple sessions) and rate limits.

To enable Steph in production, set `RECALL_APP_TOKEN` (`openssl rand -hex 32`, different from the other tokens), `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`, and optionally `VOYAGE_API_KEY` in the Vercel project's Production environment, redeploy, and give the same app token to the iOS build. Check that an unauthenticated `POST /ask` returns 401.

## Medicine reminder demo

Run `npm run demo:medicine` for an offline terminal walkthrough using the real reminder service, a temporary SQLite database and a fake Dial client. It advances a simulated clock, shows sample call dialogue, and checks both an answered call and a missed call with one fallback text. It does not load `.env`, send anything, or write production data. The printed dialogue is scripted, not Dial-generated audio. An answered call never means medicine was taken.

The [iPhone demo](ios/README.md#medicine-reminder-demo) has **Show medicine reminder** and **Medicine reminder in 10 seconds** controls under Settings → Demo memories. These are separate demo flows; this does not add recurring medication schedules or adherence tracking.

## Steph's phone line and reminders

Steph's Dial number is **+1 240 896 2183** (Dial nickname `Steph`, default `STEPH_NUMBER`). Its inbound instruction is `backend/voice/instructions.txt`. When configured, calling it reaches Steph; reminder calls and texts come from it. A real hosted reminder call and SMS delivery still need separate validation.

A caller says, "Remind me in ten minutes to take the laundry out" or "Remind me tomorrow at 9 to call Sarah." Steph calls `whats_today` for clock times, then `set_reminder`, and reads back the spoken time. The reminder is stored in the `reminders` table. Every minute Vercel Cron calls `/cron/dial-reminders`, which claims due reminders and phones the caller from Steph's line, or submits a text for `channel: "text"`. Calls and texts are reserved in the database before contacting Dial, so a crashed worker cannot cause another send. On a reminder call, the same person can ask to be reminded again.

- **Call outcome:** the signed `call.ended` webhook marks an answered call `delivered`. A busy, unanswered, failed or cancelled call becomes `missed` and attempts one fallback text. The call stays `missed` regardless of the separate text outcome. Conditional database updates prevent redeliveries and concurrent requests from sending a second text.
- **Text outcome:** HTTP acceptance means submitted, not delivered. Recall stores the provider message ID and `message_status` (`pending`, `unknown`, `delivered`, or `failed`). Direct texts stay `texting` until delivery is confirmed or a definitive failure is known. Signed `message.status_changed` receipts and exact-ID polling settle delivery. The cron's `submitted` count means accepted send requests, not delivery receipts.
- **Retries:** Dial's call guide says a retried `POST /calls` places a second call, so placement is never blindly retried. After a timeout, dropped connection, any 5xx response, or worker crash, the backend lists Steph's calls to that number and adopts a matching call; if none shows up, the reminder remains unconfirmed, is re-checked each minute, and after 10 minutes is settled with one fallback text — never redialed. This also covers a crash before the request was sent and expired leases from older deployments. A definite rate-limit refusal (429) is looked up first, then retried after two minutes, up to 3 attempts. The `Idempotency-Key` is still sent but is not relied on. A 4xx such as 400, 402 or 409 `calling_disabled` fails at once. Texts have no idempotency key and are never retried (see Ambiguous sends).
- **Safety net:** with `DIAL_ALLOWED_NUMBERS` set, the Dial client refuses any other destination before making a request.
- **Lost webhooks:** a reminder still `calling` after 10 minutes is settled from `GET /calls/{id}` only once Dial reports the call terminated. Unresolved texts with a provider ID are checked against outbound message history. A missing result or failed poll leaves delivery unresolved.
- **Ambiguous sends:** a timeout or process interruption can leave an unknown text outcome without a provider ID. Recall never automatically resends it. Migration also changes historical text rows with no delivery proof to unknown without resending them.
- **Times:** spoken and local times use `TIMEZONE`, then the Google calendar's zone, then UTC. Set `TIMEZONE` for the person's zone.
- `shortcut:` an answered call counts as delivered even if voicemail picked up; check the transcript if that matters. Calls are capped at 180 s while the Dial account is on its free tier (300 s maximum, 2 concurrent calls).
- `shortcut:` Dial's message-history response contains at most the newest 100 matching messages and has no documented pagination. A message outside that window can remain unresolved; add a stronger reconciliation source before relying on high-volume SMS delivery tracking.

### Connect Dial

1. Verify the production [health endpoint](https://recall-kappa-nine.vercel.app/health), or use a development HTTPS tunnel when testing a local backend.
2. Apply `npm run db:init` on the isolated preview database and verify the preview before applying the same schema to production; the schema adds or migrates the `reminders` table and its text-delivery states, and adds the `caregiver_message` and `dial_event_handled` tables. Before enabling reminders, set `DIAL_API_KEY`, a separate `CRON_SECRET`, `DEMO_CALLER_NUMBER` (the consented caller, never committed), `CALLER_PIN`, `TIMEZONE`, and `DEMO_MODE=false` in the intended environment, then redeploy. The existing Vercel Pro plan supports the per-minute reminder cron.
3. Connect the Context MCP (account-wide) and the webhook. Use that environment's `DIAL_MCP_TOKEN`. Put the returned `whsec_…` secret in `DIAL_WEBHOOK_SECRET` and redeploy. Keep `CRON_SECRET` configured even when Google is disabled: scheduled retention cleanup must not depend on another webhook arriving.

   ```sh
   curl -X POST https://api.getdial.ai/api/v1/context-mcps -H "Authorization: Bearer $DIAL_API_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"Recall","url":"https://recall-kappa-nine.vercel.app/mcp","headers":{"Authorization":"Bearer '"$DIAL_MCP_TOKEN"'"}}'
   curl -X POST https://api.getdial.ai/api/v1/webhooks -H "Authorization: Bearer $DIAL_API_KEY" -H 'Content-Type: application/json' \
     -d '{"targetUrl":"https://recall-kappa-nine.vercel.app/webhooks/dial","eventTypes":["call.ended","call.transcribed","message.received","message.status_changed"]}'
   ```

4. Apply the persona after any edit: `dial number set +12408962183 --inbound-instruction "$(cat backend/voice/instructions.txt)"`.
5. Call once with `DIAL_LOG_HEADERS=true`. The log lists the header names Dial sent, with phone numbers cut to their last four digits and other Dial values reduced to their length. If the caller and direction headers differ from the defaults, set `DIAL_CALLER_HEADER` and `DIAL_DIRECTION_HEADER`, then turn logging off.
6. Ask for a reminder in two minutes and hang up. Check that the reminder call arrives. After carrier registration is complete, separately verify fallback text delivery and its persisted delivery receipt. Events such as `call.ended`, `call.transcribed`, and `message.status_changed` are stored once each; transcripts contain personal speech, so retention defaults to 30 days and the ten-minute Google-sync cron keeps pruning even after webhooks are switched off. Enable message-status events only with the source account owner's approval; polling still works without that subscription. Verify the scheduled invocation after deployment. On Vercel, `CRON_SECRET` is required with webhooks or Google; boot fails without it.

Locally, Vercel Cron does not run: trigger delivery with `curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/cron/dial-reminders`.

Dial's [Context MCP documentation](https://docs.getdial.ai/documentation/platform/context-mcp) names `X-Dial-User-Number` (the other party), `X-Dial-Direction` and `X-Dial-Agent-Number` (your Dial number); step 5 confirms them on a live call. Memory tools require a known patient on an inbound call: `DEMO_CALLER_NUMBER` (the primary patient) or a number in `PATIENTS`. A missing, empty, unfilled (`{{user_number}}`) or malformed header, or an unknown number, gets "not authorized" and no data. Every lookup reads a store scoped to the caller's own records (records without a `patient` field belong to the primary patient, whose Google account is never shown to another patient). Reminder tools also allow outbound reminder calls to that caller, but only from `STEPH_NUMBER`. Tool discovery works without caller headers; data retrieval does not. Connection credentials alone never authorize a caller.

Vercel Deployment Protection must allow Dial and the laptop uploader to reach the deployment. Their application bearer tokens do not bypass Vercel's login protection. Use the project's production domain with the intended access settings when connecting these external clients.

**The caller-number allowlist is a demo restriction, not verified identity.** Set `CALLER_PIN` before connecting real Google data. `PATIENTS` scopes records per caller, but one database still holds everyone: for real users add verified identity, per-user storage and credentials, consent, and retention controls. Keep the bearer secrets server-side.

### Caregivers

`CAREGIVER_NUMBER` (or `caregiver` on a `PATIENTS` entry) receives two kinds of text from Steph's line: `notify_caregiver` alerts — the persona calls it after telling a caller who mentions a fall, pain or danger to call 911, and Steph never contacts 911 itself — and one daily summary built from that day's call transcripts, missed calls, alerts and texts (`/cron/caregiver-summary`). Quoted words are masked (phone numbers keep their last four digits) and clipped. A summary is claimed in the database before sending, so a timeout can never turn into two texts, and nothing is sent when there is nothing to report.

Reference: [Context MCP](https://docs.getdial.ai/documentation/platform/context-mcp), [webhooks](https://docs.getdial.ai/documentation/platform/webhooks), [placing calls](https://docs.getdial.ai/api-reference/rest-api/calls/make-call), [message delivery receipts](https://docs.getdial.ai/api-reference/events/message-status-changed). The backend places reminder calls and texts; it does not create phone numbers. US carriers [block outbound SMS/MMS from unregistered 10-digit numbers to US recipients](https://docs.getdial.ai/documentation/platform/manage-phone-numbers#register-a-us-number-for-10dlc). Steph's line was unregistered when checked October 11, 2026. Ordinary US SMS and fallback texts must not be presented as working until registration and real delivery are verified; voice calls are unaffected.

## Camera process

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r camera/requirements.txt
PYTHON=.venv/bin/python npm run camera -- --once
```

Omit `--once` for repeated capture. Defaults: webcam 0, one frame every 5 seconds. The npm command loads `.env`. Use `BACKEND_URL=https://recall-kappa-nine.vercel.app` and the production `CAMERA_TOKEN` for remote uploads; remote plain HTTP is rejected. Running capture requests OS webcam permission.

Use `PYTHON=.venv/bin/python npm run camera -- --preview` to position the tabletop locally; press `q` to stop. Preview mode also uploads snapshots. Capture requests 1280×720 and reduces JPEG quality as needed to remain under 500 KB. Set `GEMINI_API_KEY` on the backend and `DEMO_MODE=false` for live testing. Keep the laptop awake. Follow the [18-placement acceptance procedure](docs/object-memory.md#placement-acceptance) before claiming reliable object recall.

## Deployment infrastructure

### Vercel and managed Postgres

The existing [Vercel project `recall`](https://vercel.com/openfloor-51a7e770/recall) belongs to the **openfloor** team (`openfloor-51a7e770`). The team uses Vercel Pro (checked October 11, 2026); `vercel.json` schedules Google sync and retention cleanup every ten minutes, plus reminder delivery every minute. Its connected Git repository is `mattdomingo/speedhacks`, with `main` as the production branch. Pushes to `main` deploy production; other branches receive protected previews.

Neon resources `recall-production` and `recall-preview` use the Free plan in `iad1`, alongside the function region. Their initialized databases and API tokens are separate. Each database is connected only to its matching Vercel environment. At the October 11 hosting handoff, production ran with `DEMO_MODE=true` and `DEMO_CALLER_NUMBER` was not configured, so MCP tool discovery works but callers cannot retrieve evidence until a consented test number is configured and deployed.

Engineers should pull `main`, follow local startup above, and link the existing project if they need deployments:

```sh
npx vercel@latest link --project recall --scope openfloor-51a7e770
```

Do not create another production project or point previews at the production database. Ask the project owner for the correct environment's API tokens through a secure channel; they are Vercel Secrets, and `vercel env pull` returns `[SENSITIVE]` placeholders for them. Local `npm run setup` tokens work only against your local backend. Vercel Standard Protection keeps preview and generated deployment URLs private while the production domain above remains reachable with the application's bearer authentication. Use `vercel curl /health --deployment <preview-url>` for an authenticated preview health check.

The repository is configured for Vercel Services with a single Express service:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "services": {
    "recall": {
      "root": ".",
      "framework": "express",
      "entrypoint": "server.mjs"
    }
  },
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": { "service": "recall" }
    }
  ],
  "crons": [
    { "path": "/cron/google-sync", "schedule": "*/10 * * * *" },
    { "path": "/cron/dial-reminders", "schedule": "* * * * *" }
  ]
}
```

The catch-all preserves existing request paths: `/health`, `/mcp`, `/camera/frame`, and `/camera/observations`. There is no frontend at `/`; unimplemented paths return 404. Only `/health` is unauthenticated. No internal services or service bindings are needed because all backend modules run in `recall`. The laptop's `BACKEND_URL` is a manually configured public HTTPS origin, not an injected binding. Do not deploy `camera/capture.py` to Vercel: it requires a local webcam and OS permission.

The native Express runtime handles the backend; Vercel does not use the Dockerfile. The root `server.mjs` entrypoint loads the existing backend startup and lets Vercel's Express builder discover it. Postgres holds both observations and the latest JPEG. Database calls are asynchronous, and the connection pool uses Vercel's lifecycle helper. When `VERCEL=1`, startup fails without `DATABASE_URL` instead of using ephemeral SQLite.

For schema or configuration changes to the existing deployment:

1. Link the existing `recall` project as above. Confirm the target environment and database before changing either. Keep the Node 22 runtime specified in `package.json`.
2. Use the provider's TLS-enabled pooled `DATABASE_URL`, with the database near the function region. Preview and production must keep separate databases and credentials.
3. Configure the variables below in the intended Vercel environment. Keep local secrets in ignored `.env` files, never in `vercel.json` or client code. Configure `CRON_SECRET` for hosted Google sync, Dial webhook retention and reminder delivery.
4. Apply `npm run db:init` with the **preview** database URL first. It executes `backend/schema.sql`; migrations do not run during builds or startup. Deploy a protected preview and verify authenticated reads/writes and the affected integration there. Use only a disposable database for `TEST_DATABASE_URL` checks.
5. After preview validation, apply the same reviewed schema to the **production** database before merging dependent code to `main`. Check the resulting production deployment and scheduled cron. Keep the laptop's `BACKEND_URL` and Dial's `/mcp` URL pointed at the intended production origin.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Vercel and optional local Postgres testing | Managed Postgres connection URL; required on Vercel |
| `DIAL_MCP_TOKEN` | Backend and Dial configuration | At least 32 characters; must differ from the camera token |
| `CAMERA_TOKEN` | Backend and laptop | At least 32 characters; authenticates frames and observations |
| `GEMINI_API_KEY` | Backend only | Paid Gemini API project for camera vision (requests use `store:false`), and Steph's model when `STEPH_PROVIDER` selects Gemini; empty disables inference |
| `VISION_MODEL` | Backend only | Defaults to `gemini-3.5-flash-lite` |
| `DEMO_CALLER_NUMBER` | Backend | Consented caller in E.164 format; empty means no caller can retrieve evidence |
| `DEMO_MODE` | Backend | `true` seeds synthetic records; defaults to `false` if omitted |
| `BACKEND_URL` | Laptop only | Public backend origin, e.g. `https://YOUR_PROJECT.vercel.app`; local default follows `PORT` |
| `DATA_DIR` | Local SQLite only | Database directory; default `./data`; ignored when `DATABASE_URL` is set |
| `CALLER_PIN` | Backend | 4–8 digits callers must also say; set before connecting real Google data |
| `ADMIN_TOKEN`, `GOOGLE_*` | Backend | Google connection and sync; see [Google connection](#google-connection) |
| `CRON_SECRET` | Backend / Vercel Cron | At least 32 characters; required with hosted Google sync, Dial webhooks or reminders so scheduled requests can authenticate |
| `DIAL_WEBHOOK_SECRET`, `DIAL_*_HEADER`, `DIAL_LOG_HEADERS` | Backend | Dial webhooks and caller-header names |
| `DIAL_API_KEY` | Backend only | Dial `sk_live_` key for reminder calls and texts; unset turns reminders off |
| `DIAL_ALLOWED_NUMBERS` | Backend | Optional comma-separated E.164 allowlist; Dial never calls or texts anyone else (use while testing) |
| `CAREGIVER_NUMBER` | Backend | Caregiver for `DEMO_CALLER_NUMBER`: alerts and the daily summary |
| `PATIENTS` | Backend | Optional JSON array of `{number, name?, caregiver?, timeZone?}`; each caller sees only their own records |
| `STEPH_NUMBER` | Backend | Steph's Dial line; defaults to `+12408962183` |
| `KEEWANO_API_KEY` | Backend | Optional Keewano analytics; empty disables it |
| `PORT` | Local server/Compose | Default `3000`; Vercel manages its service port |
| `RECALL_APP_TOKEN` | Backend and iOS app | At least 32 characters, distinct from the other tokens; empty disables Steph's endpoints |
| `STEPH_PROVIDER` | Backend only | `auto` (default: Claude if its key is set, else Gemini), `claude` or `gemini` |
| `ANTHROPIC_API_KEY` | Backend only | Claude for `/ask` and `/reminders` |
| `STEPH_MODEL` | Backend only | Claude model; defaults to `claude-opus-5-5` |
| `STEPH_GEMINI_MODEL` | Backend only | Gemini model; defaults to `gemini-3.5-flash-lite` |
| `VOYAGE_API_KEY` | Backend only | Voyage AI embeddings for `/embed`; empty returns 503 |
| `EMBED_MODEL` | Backend only | Defaults to `voyage-3.5-lite` |

To use `vercel dev -L`, put local test database credentials and application secrets in `.env`. Use the port printed by Vercel for `/health`, `/mcp`, and `BACKEND_URL`. This exercises the same service routing as deployment without creating cloud resources. `npm start` still runs the backend directly for SQLite development.

After deployment, check `/health`, verify unauthenticated camera requests return 401, and test an authenticated upload and retrieval. `/health` pings the database and reports whether the Claude, Dial and Voyage keys work. Verify an authenticated cron request and its later scheduled production invocation; previews need a manual check. Record these separately from a real Google consent/sync/retrieval test and a real inbound Dial call with the observed caller headers and PIN. MCP smoke tests prove neither integration. Existing SQLite records stay in `DATA_DIR`; moving those records into Postgres requires a separate import.

The existing project and databases above were provisioned separately; these files alone do not provision them or a Dial number. See [Vercel Services](https://vercel.com/docs/services), [Express hosting](https://vercel.com/docs/frameworks/backend/express), and [database connection pools](https://vercel.com/kb/guide/connection-pooling-with-functions).

### Local Docker Compose

```sh
docker compose up --build
```

Compose includes environment injection, a healthcheck, and a persistent SQLite volume. The port binds to laptop loopback. Leave `DATABASE_URL` unset or empty to use that volume; a configured URL selects Postgres instead. For Docker hosts other than Vercel, SQLite requires persistent storage at `/app/data` and a single replica. Keep the camera on the laptop.

Do not use ephemeral container storage for SQLite. Neither Compose nor the Dockerfile provisions cloud hosting.

## Sponsor tools

| Sponsor | Use here | Status |
| --- | --- | --- |
| Dial | Steph's number (+12408962183), managed voice agent, Context MCP, signed webhooks, reminder calls and texts | Backend implemented; configure account and verify caller headers, a real reminder call and SMS delivery |
| Keewano | Tool, latency, evidence-origin, sync and call-event analytics | Optional event reporting; `KEEWANO_API_KEY` enables it. No product query loop is implemented |
| Alike | Shared decisions for coding agents (see [AGENTS.md](AGENTS.md#alike-coordination-when-connected)) | Development workflow; inspect capture/privacy settings before sharing sensitive work |
| Darwin | Agent discovery | Not integrated; current memory retrieval does not need provider discovery |
| Sparta | Local synthetic business-API testing | Generic loopback Google-mock endpoints are implemented; Sparta compatibility is unverified. The supplied kit has Stripe and a demo ticket desk, **no Gmail or Calendar** |

Offers checked against the [event resources](https://hackersquad.io/events/speedhacks-oct11/resources?tab=resources) on October 11, 2026; published offers do not prove account redemption:

- **Dial:** request **$100** with coupon `DIAL_FOR_SPEEDHACKS` and the same signup email at the [event quickstart](https://www.getdial.ai/hackathon/speedhacks/quickstart). Unused coupon credits expire at the end of the event day. New accounts have five-minute calls and two concurrent calls; confirm account limits after redemption.
- **Keewano:** the [SpeedHacks guide](https://docs.keewano.com/getting-started/speedhacks-quickstart) directs account owners to send `#SpeedHacks` in platform chat for full event access, MCP and team seats. The partner award requires meaningful queries that affect the product and at least one live query; optional event reporting alone does not qualify. Allow about five minutes for new events to become queryable.
- **Alike:** signup invitation `HACKS` appears in the [official docs](https://alike.help/); no monetary credit is stated.
- **Darwin:** [Search](https://darwin.so/speedhacks) is free. The [launch allowance](https://darwin.so/docs/admin/rate-limits) is one million requests per caller per rolling 24 hours until October 12, 2026, 7 PM PDT. Act beta access is by request; provider costs may still apply.
- **Sparta:** the [supplied starter](https://drive.google.com/file/d/1UdeeG0AtDsgHZbY-4fMcFRGozUCbVt-0/view) is free for local/internal testing and CI, without signup or bundled model credits. Its pinned `sparta_worlds@0.9.0-beta.3` needs Node 24+, so any experiment belongs in a separate harness. The [award rubric](https://drive.google.com/file/d/1B5u9p0D7WcUOlBL2t_389wMY2-n9WSpi/view) requires a sandbox test, failure, fix and comparable rerun.

The listed event resources provide no general Vercel, cloud or Postgres credit offer. Keep the existing infrastructure; Keewano analytics does not replace the evidence database. Partner awards are optional for the overall competition. The [submission rules](https://hackersquad.io/events/speedhacks-oct11/resources?tab=rules) require project details, accessible source and a demo of at most five minutes, explicitly submitted by **October 11, 2026, 5 PM PDT**. Label mocks and distinguish measured time savings from estimates.

For a local mock implementing Google's API paths, use an isolated test database and test-only OAuth credentials. Set `GOOGLE_API_BASE_URL=http://127.0.0.1:PORT`; set `GOOGLE_OAUTH_BASE_URL` to the mock OAuth origin to exercise consent and token exchange locally. Unset endpoints still target real Google. Start the mock, run `npm start`, then `npm run google -- connect`; verify the read-only adapter leaves the mock's records unchanged. Both overrides accept only `localhost`, `127.0.0.1` or `[::1]` as a plain origin and path, are refused on Vercel or with a non-local `DATABASE_URL`, and trigger a boot warning. A Google connection is tied to the token endpoint it was made with: a real connection already in the store is never sent to the mock (nor a mock connection to Google); disconnect it with matching settings first. These options do not supply a Gmail/Calendar mock or prove a Sparta integration.

Keewano receives no phone numbers or personal content: callers become HMAC-derived UUIDs, rejected callers share one anonymous ID, and events carry only tool names, counts, latency and origin labels. Without a persistent disk (Vercel), batches stay in memory and ship within about two seconds. Event definitions live in `backend/analytics/keewano.events.json`; append (never reorder), then run `npm run keewano:codegen`, which converts Keewano's generated TypeScript to plain JS with Node's built-in type stripping. CI fails if the generated file is stale.

## Checks

```sh
npm test
python3 -m unittest discover -s camera -p 'test_*.py'
```

`npm run eval:golden` scores live `/ask` answers against `ios/RecallTests/GoldenSet.json` (≥ 90% correct, every no-answer question "I'm not sure"). It uses whichever provider the backend runs and prints it; it spends real tokens, so it runs only with `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` in `.env` and a running backend (`BACKEND_URL`, `RECALL_APP_TOKEN`); otherwise it prints a skip. End-to-end test results and defects are tracked in `docs/testing/`.

After every successful Vercel production deployment, the **Deployment smoke** workflow probes the production domain without credentials: `/health`, a 401 or 503 on every protected route, and 404 at `/`. Run it on demand from the Actions tab, or locally with `node scripts/smoke-deploy.mjs https://recall-kappa-nine.vercel.app`. It proves liveness and authentication, not Google, Dial or recognition.

To run the backend suite against a disposable Postgres database:

```sh
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/speedhacks_test npm test
```

The test database user needs permission to create schemas. Each fixture creates and removes its own schema; the suite does not use `DATABASE_URL` or erase the database's existing tables. Use a direct local/test connection that supports PostgreSQL session options for these tests, not a production pooler.

GitHub Actions is configured to run the backend suite with SQLite and Postgres 17, plus the Python camera suite. This configuration is not proof that a hosted CI run passed. Checks cover MCP authentication and retrieval, two-frame confirmation, timestamp ordering, duplicate/held/ambiguous objects, bounded processing, restart recovery, rollback consistency, and camera limits. A runnable MCP smoke test and physical acceptance procedure are in the [handoff](docs/object-memory.md). Google OAuth (PKCE, single-use state, partial consent, revocation, undecryptable tokens), sync, live fallback and freshness are tested on both adapters against an in-process fake Google, along with time zones and DST, the caller PIN lockout, Dial webhook signatures (including behind Vercel's request helpers) and analytics privacy. Real calls, a real Google account, and webcam accuracy need separate verification.

The hosting handoff recorded the following checks for the foundation, before object recognition:

GitHub Actions runs the backend suite with SQLite and Postgres 17, plus the Python camera suite. The [hosting foundation run](https://github.com/mattdomingo/speedhacks/actions/runs/38169291132) passed on October 11, 2026: 11 backend tests per database and 2 Python tests. Checks cover MCP discovery and retrieval, caller restrictions, unknown evidence, validation, timestamp ordering, persistence, and camera upload limits.

Production verification also passed public health, root 404, unauthenticated rejection, authenticated JPEG upload/retrieval, durable Neon writes, MCP discovery, and rejection of callers without an allowlisted number. Synthetic verification data was removed afterward. Real Dial calls, Google access, webcam accuracy, and clinical usefulness remain unverified.

The protected preview was also checked: its authenticated observation write appeared only in the preview database, never production, and was removed afterward.

### iOS shared-memory pairing

The app can query the same authenticated calendar, email and camera evidence as Dial using a separate device credential. See [pairing, API and acceptance](docs/ios-memory.md). Legacy app tokens cannot read backend personal records.
