# Recall

Phone memory assistant hackathon scaffold. A person calls a number, asks about a plan or misplaced object, and hears an answer grounded in timestamped evidence.

Engineers and coding agents: start with [AGENTS.md](AGENTS.md) for shared working rules, ownership, verification, and the [decision log](AGENTS.md#decision-log).

Production API: **https://recall-kappa-nine.vercel.app**. Check [health](https://recall-kappa-nine.vercel.app/health); connect Dial to `https://recall-kappa-nine.vercel.app/mcp`. This is an API backend; `/` returns 404.

The camera observer recognizes keys, a phone, and a wallet on a fixed tabletop and remembers their last confirmed locations. Configure a paid Gemini project on the backend to enable recognition. Without a key, uploads still work and report `not_configured`. Google accounts and Dial calls remain separate integrations.

## Architecture

```mermaid
flowchart LR
    Caller[Person calling] <--> Dial[Dial managed voice agent]
    Dial <-->|Context MCP: authenticated tools| Backend[Hosted backend]
    Backend <-->|Digital module: planned adapter| Google[Calendar and email]
    Backend <-->|Read and write evidence| Store[(Managed Postgres on Vercel)]
    Camera[Laptop webcam process] -->|HTTPS: authenticated frames| Backend
    Backend <-->|Stateless snapshot analysis| Vision[Gemini vision]
```

One monorepo, two running processes: a hosted Node/Express backend and a Python webcam process on a laptop. Digital and physical memory are modules within the same backend. Vercel's `services` configuration contains one hosted service, `recall`; `camera/` is a hardware capture client, not a deployable HTTP service. Local development and Docker Compose use SQLite unless `DATABASE_URL` is set.

Dial owns speech recognition, conversation, and speech playback. Its managed voice agent calls the backend's MCP tools during the call. The camera collects evidence before a call; object lookup retrieves historical observations rather than describing only the current room.

The camera makes outbound HTTPS requests, requiring no public laptop port. The backend retains the latest raw frame plus one confirmed record/photo per category. It requires two matching, certain sightings of a resting object before updating memory. Missing objects preserve the previous location and capture time. See the [object-memory runbook and phone handoff](docs/object-memory.md).

## Ownership

| Engineer | Owns | Next work |
| --- | --- | --- |
| 1: Phone and deployment | `backend/voice/`, `backend/app.mjs`, database adapters, Vercel and Docker configuration | Maintain hosted infrastructure, connect Dial MCP, and test a real call |
| 2: Digital memory | `backend/digital/` | Add Google authorization and Calendar/email retrieval with source references |
| 3: Physical memory | `camera/`, `backend/physical/` | Validate real tabletop accuracy, latency, and missed placements |

`contracts/index.mjs` defines shared payload validation and tool inputs. Coordinate changes here before changing producers or consumers. Engineer 1 owns the shared backend deployment.

Store calls may be asynchronous: always `await` reads and writes so both SQLite and Postgres work. Finish required processing and writes before sending an HTTP response. Keep durable state in the database; a process-local cache or a background task after the response is not durable on Vercel. Schema changes belong in `backend/schema.sql` and must be applied to each environment before code depends on them.

## Local startup

Requires Node 22.15.x–22.x and npm; optional camera capture uses Python 3.12+. Node's built-in SQLite API is experimental in this version.

```sh
npm ci
npm run setup
```

Setup creates an ignored, owner-readable `.env` with distinct secrets. It never overwrites an existing file. Set `DEMO_CALLER_NUMBER` there to a consented test caller's E.164 number, then:

```sh
npm start
```

Health: `http://127.0.0.1:3000/health`. MCP: `http://127.0.0.1:3000/mcp`. Watch mode: `npm run dev`.

`DEMO_MODE=true` seeds synthetic calendar, email, and keys memories dated today in UTC. Seeded records have `demo: true`. Setting the flag to false stops seeding and excludes synthetic camera records from lookup, including fixtures already in the database. It does not erase records. Live object evidence always takes priority over fixtures. This scaffold has one demo user and no connected Google account.

## Contracts

| Endpoint/tool | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | Liveness and demo status |
| `POST /mcp` | `Bearer DIAL_MCP_TOKEN` | Stateless Streamable HTTP MCP; other methods return 405 |
| `get_schedule({date})` | Authorized inbound demo caller | Plans for an explicit `YYYY-MM-DD` date |
| `search_messages({query})` | Authorized inbound demo caller | Search fixture emails |
| `find_object({object})` | Authorized inbound demo caller | Latest matching observation by capture time |
| `whats_today()` | Demo caller on Steph's line, inbound or outbound | Local date and time in `PATIENT_TIME_ZONE` |
| `set_reminder({text, in_minutes \| at, channel?})` | Demo caller on Steph's line, inbound or outbound | Schedule a call (default) or text; `at` is local `YYYY-MM-DDTHH:MM` |
| `list_reminders()` / `cancel_reminder({id})` | Demo caller on Steph's line, inbound or outbound | The caller's upcoming reminders, soonest first |
| `GET /dial/dispatch` | `Bearer CRON_SECRET` | Vercel Cron, every minute: deliver due reminders and reconcile unsettled calls |
| `POST /dial/webhook` | Dial `X-Dial-Signature` | `call.ended` outcomes; deduplicated on `X-Dial-Event-ID` |
| `POST /camera/frame` | `Bearer CAMERA_TOKEN` | Store latest JPEG, at most 500 KB; return frame ID and actual inference status |
| `GET /camera/frame` | `Bearer CAMERA_TOKEN` | Retrieve latest JPEG with `X-Captured-At` |
| `GET /camera/status` | `Bearer CAMERA_TOKEN` | Capture/analysis freshness, processing errors, latency, token usage |
| `GET /camera/evidence/:frameId` | `Bearer CAMERA_TOKEN` | Retrieve a retained confirming JPEG; no public image URLs |
| `POST /camera/observations` | `Bearer CAMERA_TOKEN` | Persist a placement observation |

Observation body:

```json
{
  "object": "keys",
  "location": "beside the blue mug on the desk",
  "timestamp": "2026-10-11T14:14:00-07:00"
}
```

Frame bodies still contain `timestamp` and `jpegBase64`. Upload acceptance does not imply recognition: `inference` can be `analyzed`, `busy`, `throttled`, `ignored`, `stale`, `failed`, `superseded`, or `not_configured`. An analyzed frame may confirm zero objects.

Memory tools return `{"status":"supported","evidence":[...]}` or `{"status":"unknown","evidence":[]}`. Each evidence record has an ID, source, text, timestamp, and demo flag. Unauthorized/failed tools return errors, not proof that nothing happened. Calendar plans do not prove attendance; camera observations are last-seen locations.

## Steph's phone line and reminders

Steph's Dial number is **+1 240 896 2183** (Dial nickname `Steph`, default `STEPH_NUMBER`). Its inbound instruction is `backend/voice/instructions.txt`. Calling it reaches Steph; reminder calls and texts come from it.

A caller asks, "Remind me in ten minutes to take the laundry out" or "Remind me tomorrow at 9 to call Sarah." Steph calls `whats_today` for clock times, then `set_reminder`, and reads back the spoken time. The reminder is stored in the database. Every minute Vercel Cron calls `/dial/dispatch`, which claims due reminders under a two-minute database lease and phones the caller from Steph's line, or texts them for `channel: "text"`. On the reminder call, the same person can ask to be reminded again.

- **Outcome:** Dial's signed `call.ended` webhook marks an answered call `delivered`. A busy, unanswered, failed or cancelled call becomes `missed` and gets one fallback text. A transition is a conditional update, so duplicate or concurrent deliveries cannot send a second text.
- **Retries:** call placement uses the Dial `Idempotency-Key` `reminder-<id>`, so a retried claim returns the original call instead of dialing again. Transient errors retry for up to 3 attempts; a 4xx (for example 402, no credit) fails at once. Texts have no idempotency key and are never retried.
- **Lost webhooks:** a reminder still `calling` after 10 minutes is settled from `GET /calls/{id}` only once Dial reports the call terminated.
- `shortcut:` an answered call counts as delivered even if voicemail picked up; add transcript checks if that matters. Calls are capped at 180 s while the Dial account is on its free tier (300 s maximum, 2 concurrent calls).

### Connect production (Engineer 1)

1. Set these Production variables in Vercel: `DIAL_API_KEY`, `CRON_SECRET` (`openssl rand -hex 32`), `DEMO_CALLER_NUMBER` (the consented caller's number, never committed), `DEMO_MODE=false`, and `PATIENT_TIME_ZONE` if not Pacific.
2. Apply `backend/schema.sql` to the production database with `npm run db:init` before merging. It adds the `reminders` and `dial_events` tables and preserves existing data.
3. Merge to deploy. A per-minute cron needs a Vercel Pro team; on Hobby the deployment is rejected, so check the preview build first.
4. Connect Dial's Context MCP (account-wide) and the webhook. Use the production `DIAL_MCP_TOKEN`:

   ```sh
   curl -X POST https://api.getdial.ai/api/v1/context-mcps -H "Authorization: Bearer $DIAL_API_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"Recall","url":"https://recall-kappa-nine.vercel.app/mcp","headers":{"Authorization":"Bearer '"$DIAL_MCP_TOKEN"'"}}'
   curl -X POST https://api.getdial.ai/api/v1/webhooks -H "Authorization: Bearer $DIAL_API_KEY" -H 'Content-Type: application/json' \
     -d '{"targetUrl":"https://recall-kappa-nine.vercel.app/dial/webhook","eventTypes":["call.ended"]}'
   ```

   Put the returned `whsec_…` secret in `DIAL_WEBHOOK_SECRET` and redeploy.
5. Re-apply the persona after editing it: `dial number set +12408962183 --inbound-instruction "$(cat backend/voice/instructions.txt)"`.
6. Call Steph from the allowlisted phone, ask for a reminder in two minutes, and hang up. Check that the reminder call arrives, then that an unanswered call produces a text.

Locally, Vercel Cron does not run. Trigger delivery yourself with `curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/dial/dispatch`. Dial reaches a local backend only through an HTTPS tunnel.

Dial supplies `X-Dial-User-Number`, `X-Dial-Direction` and `X-Dial-Agent-Number` during calls. Memory tools require the configured caller on an inbound call. Reminder tools also allow outbound reminder calls to that caller, but only from `STEPH_NUMBER`. Tool discovery works without caller headers; data retrieval does not. Connection credentials alone never authorize a caller.

Vercel Deployment Protection must allow Dial and the laptop uploader to reach the deployment. Their application bearer tokens do not bypass Vercel's login protection. Use the project's production domain with the intended access settings when connecting these external clients.

**The caller-number allowlist is a demo restriction, not verified identity.** Before real personal records, add caller verification, user-scoped storage and credentials, consent, and retention controls. The store is single-user. Keep the bearer secrets server-side.

Reference: [Context MCP](https://docs.getdial.ai/documentation/platform/context-mcp), [webhooks](https://docs.getdial.ai/documentation/platform/webhooks), [placing calls](https://docs.getdial.ai/api-reference/rest-api/calls/make-call). The backend places reminder calls and texts; it does not create phone numbers. US SMS from a number without carrier (10DLC) registration may be filtered, so treat the fallback text as best-effort.

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

The existing [Vercel project `recall`](https://vercel.com/openfloor-51a7e770/recall) belongs to the **openfloor** team (`openfloor-51a7e770`). Its connected Git repository is `mattdomingo/speedhacks`, with `main` as the production branch. Pushes to `main` deploy production; other branches receive protected previews.

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
  ]
}
```

The catch-all preserves existing request paths: `/health`, `/mcp`, `/camera/frame`, and `/camera/observations`. There is no frontend at `/`; unimplemented paths return 404. Only `/health` is unauthenticated. No internal services or service bindings are needed because all backend modules run in `recall`. The laptop's `BACKEND_URL` is a manually configured public HTTPS origin, not an injected binding. Do not deploy `camera/capture.py` to Vercel: it requires a local webcam and OS permission.

The native Express runtime handles the backend; Vercel does not use the Dockerfile. The root `server.mjs` entrypoint loads the existing backend startup and lets Vercel's Express builder discover it. Postgres holds both observations and the latest JPEG. Database calls are asynchronous, and the connection pool uses Vercel's lifecycle helper. When `VERCEL=1`, startup fails without `DATABASE_URL` instead of using ephemeral SQLite.

To recreate this infrastructure in a different Vercel project:

1. Create or select a Vercel project for this repository, with its root directory set to the repository root and project framework preset set to **Services**. Use a Node 22 runtime as specified in `package.json`.
2. Connect a managed Postgres database through the [Vercel Marketplace](https://vercel.com/docs/postgres), or use an existing provider. Select a database region near the Vercel function region. Set `DATABASE_URL` to the provider's pooled connection URL with TLS. Keep preview and production databases separate; a preview must not write production memories.
3. Set the environment variables below in each Vercel environment you intend to deploy. Keep local secrets in ignored `.env` files, never in `vercel.json` or client code.
4. Initialize each new database once before serving traffic. With its `DATABASE_URL` in your local ignored `.env` or exported shell environment, run `npm run db:init`. This executes `backend/schema.sql` and preserves existing tables and records. It does not copy existing SQLite data, and migrations do not run during Vercel builds or function startup.
5. Link the repository with `npx vercel@latest link`, verify locally using `npx vercel@latest dev -L`, then deploy a preview with `npx vercel@latest --target preview`. After checking it, publish with `npx vercel@latest --prod`. Vercel otherwise assigns a new project's first deployment to production. Set the laptop's `BACKEND_URL` to the production HTTPS origin and configure Dial's `/mcp` URL.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Vercel and optional local Postgres testing | Managed Postgres connection URL; required on Vercel |
| `DIAL_MCP_TOKEN` | Backend and Dial configuration | At least 32 characters; must differ from the camera token |
| `CAMERA_TOKEN` | Backend and laptop | At least 32 characters; authenticates frames and observations |
| `GEMINI_API_KEY` | Backend only | Paid Gemini API project; empty disables inference; requests use `store:false` |
| `VISION_MODEL` | Backend only | Defaults to `gemini-3.8-flash` |
| `DEMO_CALLER_NUMBER` | Backend | Consented caller in E.164 format; empty means no caller can retrieve evidence |
| `DEMO_MODE` | Backend | `true` seeds synthetic records; defaults to `false` if omitted |
| `STEPH_NUMBER` | Backend | Steph's Dial line; defaults to `+12408962183` |
| `DIAL_API_KEY` | Backend only | Dial `sk_live_` key; empty turns reminders off |
| `DIAL_WEBHOOK_SECRET` | Backend only | Signing secret of the `call.ended` webhook subscription; empty returns 503 |
| `CRON_SECRET` | Backend (Vercel Cron) | At least 32 characters, distinct from the other tokens; empty returns 503 from `/dial/dispatch` |
| `PATIENT_TIME_ZONE` | Backend | IANA zone for spoken and local reminder times; defaults to `America/Los_Angeles` |
| `BACKEND_URL` | Laptop only | Public backend origin, e.g. `https://YOUR_PROJECT.vercel.app`; local default follows `PORT` |
| `DATA_DIR` | Local SQLite only | Database directory; default `./data`; ignored when `DATABASE_URL` is set |
| `PORT` | Local server/Compose | Default `3000`; Vercel manages its service port |

To use `vercel dev -L`, put local test database credentials and application secrets in `.env`. Use the port printed by Vercel for `/health`, `/mcp`, and `BACKEND_URL`. This exercises the same service routing as deployment without creating cloud resources. `npm start` still runs the backend directly for SQLite development.

After deployment, check `/health`, verify unauthenticated camera requests return 401, and test an authenticated upload and retrieval. `/health` is liveness only; it does not prove database connectivity. Run the MCP tests and a real Dial call before claiming the voice integration works. Existing SQLite records stay in `DATA_DIR`; moving those records into Postgres requires a separate import.

The existing project and databases above were provisioned separately; these files alone do not provision them or a Dial number. See [Vercel Services](https://vercel.com/docs/services), [Express hosting](https://vercel.com/docs/frameworks/backend/express), and [database connection pools](https://vercel.com/kb/guide/connection-pooling-with-functions).

### Local Docker Compose

```sh
docker compose up --build
```

Compose includes environment injection, a healthcheck, and a persistent SQLite volume. The port binds to laptop loopback. Leave `DATABASE_URL` unset or empty to use that volume; a configured URL selects Postgres instead. For Docker hosts other than Vercel, SQLite requires persistent storage at `/app/data` and a single replica. Keep the camera on the laptop.

Do not use ephemeral container storage for SQLite. Neither Compose nor the Dockerfile provisions cloud hosting.

## Checks

```sh
npm test
python3 -m unittest discover -s camera -p 'test_*.py'
```

To run the backend suite against a disposable Postgres database:

```sh
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/speedhacks_test npm test
```

The test database user needs permission to create schemas. Each fixture creates and removes its own schema; the suite does not use `DATABASE_URL` or erase the database's existing tables. Use a direct local/test connection that supports PostgreSQL session options for these tests, not a production pooler.

GitHub Actions is configured to run the backend suite with SQLite and Postgres 17, plus the Python camera suite. This configuration is not proof that a hosted CI run passed. Checks cover MCP authentication and retrieval, two-frame confirmation, timestamp ordering, duplicate/held/ambiguous objects, bounded processing, restart recovery, rollback consistency, and camera limits. A runnable MCP smoke test and physical acceptance procedure are in the [handoff](docs/object-memory.md). Real calls, Google access, and webcam accuracy need separate verification.

The hosting handoff recorded the following checks for the foundation, before object recognition:

GitHub Actions runs the backend suite with SQLite and Postgres 17, plus the Python camera suite. The [hosting foundation run](https://github.com/mattdomingo/speedhacks/actions/runs/38169291132) passed on October 11, 2026: 11 backend tests per database and 2 Python tests. Checks cover MCP discovery and retrieval, caller restrictions, unknown evidence, validation, timestamp ordering, persistence, and camera upload limits.

Production verification also passed public health, root 404, unauthenticated rejection, authenticated JPEG upload/retrieval, durable Neon writes, MCP discovery, and rejection of callers without an allowlisted number. Synthetic verification data was removed afterward. Real Dial calls, Google access, webcam accuracy, and clinical usefulness remain unverified.

The protected preview was also checked: its authenticated observation write appeared only in the preview database, never production, and was removed afterward.
