# Digital-memory integration validation — October 11, 2026

Production Google connection, database persistence, authenticated sync, and signed Dial webhook delivery passed the checks below. The user confirmed the shared Dial team, and its production webhook was configured and tested. Keewano received hosted sync/webhook telemetry and a synthetic SDK probe. Production Context MCP, a real production phone conversation, and reminder delivery remain unverified. This is dated evidence, not a continuing production guarantee.

## Deployment and automated checks

[PR #10](https://github.com/mattdomingo/speedhacks/pull/10) merged as `8cbf309`. Its [main CI run](https://github.com/mattdomingo/speedhacks/actions/runs/38174391918) passed 89 SQLite tests with two Postgres-only skips, 91 Postgres tests, seven Python tests, and codegen consistency. The separate [deployment smoke run](https://github.com/mattdomingo/speedhacks/actions/runs/38174407567) passed. These results describe that revision.

The shared-team webhook credential was deployed in `dpl_4XzYNBjTBSNkK5TTDvTqsBpczYDx`, application commit `bd1661b`. That application revision passed [main CI checks](https://github.com/mattdomingo/speedhacks/actions/runs/38175881610) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38175978361). Its additional changes include [PR #12](https://github.com/mattdomingo/speedhacks/pull/12), which adds `google_connection.token_origin`.

After [PR #13](https://github.com/mattdomingo/speedhacks/pull/13) merged, the [production alias](https://recall-kappa-nine.vercel.app/health) advanced to `25e9e93`, deployment `dpl_FoTopDVNBhXV2BgP4CPHrxgGFMWh`, READY at 14:30:29 PDT (`21:30:29Z`). Its [CI checks](https://github.com/mattdomingo/speedhacks/actions/runs/38176652492) and [deployment smoke](https://github.com/mattdomingo/speedhacks/actions/runs/38176674275) passed. The later liveness, retained Google connection, and shared-team ping checks below succeeded after that change. This revision only added the initial version of this validation record; it introduced no schema change.

The first Google callback on that newer code failed because the database lacked `token_origin`. The additive column was then applied to the separate preview and production databases over TLS. Evidence counts were unchanged by the migration. Preview retained zero Google connections and zero Google evidence; production alone received the authorized connection and sync below.

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
| Keewano ingestion | With the production SDK key enabled, a console aggregate returned four `GoogleSync` events and one `DialEvent`, confirming hosted sync/webhook telemetry receipt. An earlier query also returned one `ToolCalled` and one `NoEvidence` for synthetic tool label `readiness_smoke_synthetic`. These checks do not prove complete event delivery or telemetry from a real hosted phone call |

The shared team's production webhook filters `call.ended` and `call.transcribed`; the provider test ping also reaches the receiver. Production now uses that webhook's signing secret in place of the earlier separate-account secret. The shared team's existing local-tunnel Context MCP connection, showing seven tools, and its existing webhook were preserved. Production Context MCP was not connected.

Retention is configured for 30 days. Google sync and retention cleanup are scheduled every ten minutes; reminder processing is scheduled every minute. The authenticated manual cron check establishes endpoint behavior, not proof that a scheduled invocation ran or that an expired event was deleted.

Google OAuth remains in Testing mode, where refresh tokens expire after seven days. Reconnection will be needed when that grant expires.

## Remaining acceptance checks

- **Production Dial conversation:** The shared team is confirmed and its local-test MCP connection remains present. The existing production `DIAL_MCP_TOKEN` was preserved; its secure handoff is pending, so production Context MCP is not connected. Complete that connection, verify caller headers on a real allowed inbound call, then test supported evidence and unknown/error answers with the required PIN. No real production phone call was completed in this run.
- **Reminders:** `DIAL_API_KEY` was subsequently present in production and absent in preview. Presence does not verify the credential or authorize a test call. Separately verify reminder delivery and any fallback text with the intended recipient.
- **Keewano product events:** After a real hosted call, confirm its expected tool events appear in Keewano without personal content. Keep that proof separate from the hosted sync/webhook events and synthetic tool probe above.
- **Scheduled operation:** Confirm the deployed cron invocations succeed and exercise retention against a controlled expired test event. Use `npm run google -- status` and `npm run google -- sync` with the intended backend when repeating connection checks. Apply schema changes with `npm run db:init` only after selecting the intended database explicitly; follow the [deployment instructions](../README.md#vercel-and-managed-postgres).
- **Physical recognition:** Camera recognition and its outstanding acceptance checks have a separate [validation record](object-memory-validation.md). Digital integration checks do not establish physical accuracy.

## Event credit

In the confirmed shared Dial team, `DIAL_FOR_SPEEDHACKS` was successfully redeemed for `$100`; billing showed a `$101.34` balance. The event coupon expires October 11, 2026 at 23:59 Pacific time. No other new paid resources were created during these integration checks. Existing infrastructure and future call usage remain separate from that credit observation.
