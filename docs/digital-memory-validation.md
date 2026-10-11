# Digital-memory integration validation — October 11, 2026

Production Google connection, database persistence, and authenticated sync passed the checks below. Signed Dial webhook delivery passed in the workspace open during setup; the user subsequently reported signing into a new Dial team, and final team selection is pending. A synthetic Keewano SDK probe reached its query console. Dial Context MCP, a real phone conversation, and reminder delivery remain unverified. This is dated evidence, not a continuing production guarantee.

## Deployment and automated checks

[PR #10](https://github.com/mattdomingo/speedhacks/pull/10) merged as `8cbf309`. Its [main CI run](https://github.com/mattdomingo/speedhacks/actions/runs/38174391918) passed 89 SQLite tests with two Postgres-only skips, 91 Postgres tests, seven Python tests, and codegen consistency. The separate [deployment smoke run](https://github.com/mattdomingo/speedhacks/actions/runs/38174407567) passed. These results describe that revision.

The later production deployment checked here was `dpl_HwgMceDA8DvkzekWPq71oYHoyPHC`, application commit `bd1661b`, marked READY and serving [recall-kappa-nine.vercel.app](https://recall-kappa-nine.vercel.app/health). Both its [main CI checks](https://github.com/mattdomingo/speedhacks/actions/runs/38175881610) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38175978361) passed. Its additional changes include [PR #12](https://github.com/mattdomingo/speedhacks/pull/12), which adds `google_connection.token_origin`.

The first Google callback on that newer code failed because the database lacked `token_origin`. The additive column was then applied to the separate preview and production databases over TLS. Evidence counts were unchanged by the migration. Preview retained zero Google connections and zero Google evidence; production alone received the authorized connection and sync below.

## Hosted integration evidence

Times below are October 11 in Pacific daylight time, with UTC values where recorded.

| Check | Observed result |
| --- | --- |
| Public liveness | `/health` returned HTTP 200 |
| Missing application credentials | MCP and camera requests returned HTTP 401 |
| Unsigned Dial webhook | `/webhooks/dial` returned HTTP 401 |
| Google OAuth | The designated account connected with read-only Calendar and Gmail scopes; account identity was checked without recording its address here |
| Initial Google sync | Calendar: 10 records at 14:21:00 PDT (`21:21:00Z`). Gmail: 100 records at 14:21:03 PDT (`21:21:03Z`) |
| Persisted Google credentials | Database inspection confirmed an encrypted refresh-token envelope and explicit Google `token_origin`; production had no alternate Google endpoint configuration |
| Subsequent authenticated sync | `GET /cron/google-sync` with the configured cron credential returned HTTP 200, successful Calendar/Gmail results with counts 10/100, and the `prunedDialEvents` field. Latest successful sync timestamps were 14:23:24/14:23:27 PDT (`21:23:24Z`/`21:23:27Z`), with no recorded errors. This exercised the persisted connection after initial OAuth |
| Signed Dial test ping | In the workspace open during setup, Dial's dashboard showed a successful provider-generated ping; one `webhook.ping` was persisted at 14:21:19.647 PDT (`21:21:19.647Z`). This has not been reverified in the newly reported team |
| Keewano ingestion | Its SQL console returned one `ToolCalled` and one `NoEvidence` event for the synthetic tool label `readiness_smoke_synthetic`. The production SDK key was enabled. This proves synthetic SDK ingestion; it does not prove telemetry from a real hosted phone call |

The setup workspace's webhook subscription filters `call.ended` and `call.transcribed`; the provider test ping also reaches the receiver. Retention is configured for 30 days. Google sync and retention cleanup are scheduled every ten minutes; reminder processing is scheduled every minute. The authenticated manual cron check establishes endpoint behavior, not proof that a scheduled invocation ran or that an expired event was deleted.

Google OAuth remains in Testing mode, where refresh tokens expire after seven days. Reconnection will be needed when that grant expires.

## Remaining acceptance checks

- **Dial team and conversation:** Confirm the intended team and recheck its webhook, number, and credit before completing setup. Dial changes were paused after the reported team switch. The existing `DIAL_MCP_TOKEN` was preserved; its secure handoff was pending, and no Context MCP connection was created. Verify caller headers on a real allowed inbound call, then test both supported evidence and unknown/error answers with the required PIN. No real phone call was completed in this run.
- **Reminders:** `DIAL_API_KEY` was absent, so reminder calls and texts were not enabled. Configure it in the intended environment, then separately verify reminder delivery and any fallback text.
- **Keewano product events:** After a real hosted call, confirm its expected tool events appear in Keewano without personal content. Keep that proof separate from the synthetic ingestion probe above.
- **Scheduled operation:** Confirm the deployed cron invocations succeed and exercise retention against a controlled expired test event. Use `npm run google -- status` and `npm run google -- sync` with the intended backend when repeating connection checks. Apply schema changes with `npm run db:init` only after selecting the intended database explicitly; follow the [deployment instructions](../README.md#vercel-and-managed-postgres).
- **Physical recognition:** Camera recognition and its outstanding acceptance checks have a separate [validation record](object-memory-validation.md). Digital integration checks do not establish physical accuracy.

## Event credit

In the Dial workspace open during setup, the `$100` SpeedHacks coupon was redeemed and the dashboard showed a `$102` balance. This credit has not been verified in the newly reported team. The event coupon expires October 11, 2026 at 23:59 Pacific time. No other new paid resources were created during these integration checks. Existing infrastructure and future call usage remain separate from that credit observation.
