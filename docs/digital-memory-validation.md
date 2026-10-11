# Digital-memory integration validation — October 11, 2026

Production Google connection, database persistence, scheduled sync, signed Dial webhook delivery, Context MCP discovery, and expired-event retention passed the checks below. The user confirmed the shared Dial team, whose production MCP connection showed seven tools. Keewano received hosted sync/webhook telemetry and a synthetic SDK probe. The later supervised phone test recorded in [PR #17](https://github.com/mattdomingo/speedhacks/pull/17) reports successful keys, Calendar, and Gmail answers, confirmed by the user. That test deliberately omitted the PIN; the final production configuration also had `CALLER_PIN` unset. Real reminder delivery and call-specific Keewano tool telemetry remain separate checks. This is dated evidence, not a continuing production guarantee.

## Deployment and automated checks

[PR #10](https://github.com/mattdomingo/speedhacks/pull/10) merged as `8cbf309`. Its [main CI run](https://github.com/mattdomingo/speedhacks/actions/runs/38174391918) passed 89 SQLite tests with two Postgres-only skips, 91 Postgres tests, seven Python tests, and codegen consistency. The separate [deployment smoke run](https://github.com/mattdomingo/speedhacks/actions/runs/38174407567) passed. These results describe that revision.

The shared-team webhook credential was deployed in `dpl_4XzYNBjTBSNkK5TTDvTqsBpczYDx`, application commit `bd1661b`. That application revision passed [main CI checks](https://github.com/mattdomingo/speedhacks/actions/runs/38175881610) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38175978361). Its additional changes include [PR #12](https://github.com/mattdomingo/speedhacks/pull/12), which adds `google_connection.token_origin`.

After [PR #13](https://github.com/mattdomingo/speedhacks/pull/13) merged, the [production alias](https://recall-kappa-nine.vercel.app/health) advanced to `25e9e93`, deployment `dpl_FoTopDVNBhXV2BgP4CPHrxgGFMWh`, READY at 14:30:29 PDT (`21:30:29Z`). Its [CI checks](https://github.com/mattdomingo/speedhacks/actions/runs/38176652492) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38176674275) passed. The later liveness, retained Google connection, and shared-team ping checks below succeeded after that change. This revision only added the initial version of this validation record; it introduced no schema change.

The first Google callback on that newer code failed because the database lacked `token_origin`. The additive column was then applied to the separate preview and production databases over TLS. Evidence counts were unchanged by the migration. Preview retained zero Google connections and zero Google evidence; production alone received the authorized connection and sync below.

### Final SMS and infrastructure rollout

[PR #16](https://github.com/mattdomingo/speedhacks/pull/16) merged as `6fd0658`. Its [main CI](https://github.com/mattdomingo/speedhacks/actions/runs/38178219562) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38178237545) passed. Full local Node 22 suites passed 117 SQLite tests with two Postgres-only skips and 119 Postgres tests. Regression coverage includes pending/failed send responses, early and lost receipts, concurrent settlement, ambiguous sends and process interruptions without duplicate sends, and repeated legacy migrations.

The SMS schema was applied first to preview, then production, over TLS. Read-back confirmed both message-tracking columns and the `texting` constraint; evidence counts were preserved and both reminder tables contained zero rows. The protected preview health check passed. Production deployment `dpl_F9EYFZCt64fz8dKM8Yct8RPoQyfT` reached READY on the production alias; a later supervised-demo redeployment, `dpl_BBZFmvCtbaWxXBMSE5NG1A4vbZPQ`, used the same application commit. Health returned 200, unauthenticated MCP and webhook requests returned 401, and Google remained connected with both read-only scopes and no sync errors. These checks establish the rollout, not actual reminder or carrier delivery.

## Hosted integration evidence

Times below are October 11 in Pacific daylight time, with UTC values where recorded.

| Check | Observed result |
| --- | --- |
| Public liveness | `/health` returned HTTP 200 with `demo:false`, including after the shared-team webhook redeployment |
| Missing application credentials | MCP and camera requests returned HTTP 401 |
| Unsigned Dial webhook | `/webhooks/dial` returned HTTP 401 |
| Google OAuth | The designated account connected with read-only Calendar and Gmail scopes; account identity was checked without recording its address here |
| Initial Google sync | Calendar: 10 records at 14:21:00 PDT (`21:21:00Z`). Gmail: 100 records at 14:21:03 PDT (`21:21:03Z`) |
| Persisted Google credentials | Database inspection confirmed an encrypted refresh-token envelope and explicit Google `token_origin`; production had no alternate Google endpoint configuration |
| Subsequent authenticated sync | `GET /cron/google-sync` with the configured cron credential returned HTTP 200, successful Calendar/Gmail results with counts 10/100, and the `prunedDialEvents` field. That check recorded successful sync timestamps of 14:23:24/14:23:27 PDT (`21:23:24Z`/`21:23:27Z`), with no errors. The connection remained present with counts 10/100 and no sync errors after the final redeployment |
| Signed Dial test ping | In the authorized shared team, an additional production webhook was created and its signing secret deployed. The provider dashboard confirmed “Ping delivered”; the latest retained ping was timestamped 14:31:16.276 PDT (`21:31:16.276Z`) |
| Completed inbound call | `call.ended` and `call.transcribed` arrived at 14:32:41.457/14:32:43.274 PDT (`21:32:41.457Z`/`21:32:43.274Z`). Safe metadata confirmed inbound/completed and a caller outside the configured allowlist. Neither payload contained structured MCP traces; the transcription event contained only its call ID. This proves event delivery, not successful authorized memory retrieval |
| Scheduled Google sync | Vercel request logs recorded HTTP 200 at `21:20:42.141Z`, `21:30:42.607Z`, and `21:40:42.176Z`, each with `clientUserAgent: vercel-cron/1.0`. The manual `21:23:24.035Z` request had a different user agent. These runs establish automatic invocation separately from the manual check |
| Scheduled reminder processing | Vercel request logs recorded HTTP 200 at `21:54:02.146Z` and `21:55:02.120Z`, both with `clientUserAgent: vercel-cron/1.0`. The reminders table was empty; successful automatic invocation does not establish reminder delivery |
| Expired-event retention | A read-only precheck found zero expired events. One clearly synthetic event was inserted with a received timestamp 31 days old. The authenticated Google-sync cron returned HTTP 200, `prunedDialEvents: 1`, and successful Google sync results. Database read-back confirmed the synthetic event was absent. No personal record or transcript was used for the test |
| Production Context MCP | The shared team's dashboard showed “Recall memory (production)” as Connected at `https://recall-kappa-nine.vercel.app/mcp`, using Static Auth, with seven tools. This establishes connection and discovery, not authorization or memory retrieval during a real call |
| Keewano ingestion | With the production SDK key enabled, a console aggregate returned four `GoogleSync` events and one `DialEvent`, confirming hosted sync/webhook telemetry receipt. An earlier query also returned one `ToolCalled` and one `NoEvidence` for synthetic tool label `readiness_smoke_synthetic`. These checks do not prove complete event delivery or telemetry from a real hosted phone call |

The shared team's production webhook filters `call.ended` and `call.transcribed`; the provider test ping also reaches the receiver. Production now uses that webhook's signing secret in place of the earlier separate-account secret. The team subsequently replaced its local-tunnel Context MCP entry with the production connection above; no duplicate MCP entry was added. The existing local webhook and production `DIAL_MCP_TOKEN` were preserved.

Retention is configured for 30 days. Google sync and retention cleanup are scheduled every ten minutes; reminder processing is scheduled every minute. Scheduled invocations and controlled deletion of an expired event were verified separately above.

Google OAuth remains in Testing mode, where refresh tokens expire after seven days. Reconnection will be needed when that grant expires.

## Remaining acceptance checks

- **Production Dial conversation:** The original call above did not establish authorized retrieval. Later metadata checks found five completed inbound calls matching the configured caller. [PR #17](https://github.com/mattdomingo/speedhacks/pull/17) then records the owner's explicit supervised-demo choice to omit the PIN and confirmation that a fresh call answered keys, Calendar, and Gmail questions successfully; its call diagnostics confirmed inbound caller headers. Production environment metadata independently confirmed the PIN was unset. Earlier PIN-required checks describe the earlier configuration, not the demo exception. A successful PIN-protected real call remains unverified if that protection is restored; unknown/error spoken answers also need their own acceptance check.
- **Reminders:** `DIAL_API_KEY` was subsequently present in production and absent in preview. Presence does not verify the credential or authorize a test call. Separately verify reminder delivery with the intended recipient. The shared team's number was shown as unregistered for 10DLC; ordinary outbound US SMS is blocked until carrier registration is approved. No registration purchase or real outbound reminder/SMS test was performed in this run. HTTP acceptance alone must not count as delivered; see [DEC-020](../AGENTS.md#dec-020--confirm-sms-delivery-and-never-resend-ambiguous-attempts).
- **Keewano product events:** After a real hosted call, confirm its expected tool events appear in Keewano without personal content. Keep that proof separate from the hosted sync/webhook events and synthetic tool probe above.
- **Repeat checks:** Use `npm run google -- status` and `npm run google -- sync` with the intended backend when repeating connection checks. Apply schema changes with `npm run db:init` only after selecting the intended database explicitly; follow the [deployment instructions](../README.md#vercel-and-managed-postgres).
- **Physical recognition:** Camera recognition and its outstanding acceptance checks have a separate [validation record](object-memory-validation.md). Digital integration checks do not establish physical accuracy.

## Event credit

In the confirmed shared Dial team, `DIAL_FOR_SPEEDHACKS` was successfully redeemed for `$100`; billing showed a `$101.34` balance. The event coupon expires October 11, 2026 at 23:59 Pacific time. No other new paid resources were created during these integration checks. Existing infrastructure and future call usage remain separate from that credit observation.
