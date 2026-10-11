# Object-memory validation — October 11, 2026

Implementation checks passed locally. Physical recognition acceptance is deferred; no accuracy claim is supported yet.

| Check | Actual result |
| --- | --- |
| Backend suite, SQLite | 26 passed; 1 Postgres-only test skipped |
| Backend suite with disposable PostgreSQL 18.4 | 27 passed; no skips |
| Python camera suite | 7 passed |
| MCP smoke script | Passed against the HTTP integration fixture with a stubbed vision provider, including supported and unknown results |
| MacBook camera | Permission granted; captured and uploaded JPEGs at 1280×720 |
| First camera analysis | Timed out at 20,009 ms; no sighting saved |
| Second camera analysis | Provider HTTP 503 at 5,272 ms; no sighting saved |
| Provider connectivity control | Small text request completed in 4,379 ms; this does not validate image recognition |
| Follow-up analysis of the retained image | Provider HTTP 503; no memory write attempted |
| 18 tabletop placements and physical occlusion/pickup/disconnection checks | Deferred at the user's request |
| Hosted Vercel and managed production database | See production readiness checks below |
| Real phone call | Not exercised; MCP-only testing does not require phone provisioning |

The local pipeline recorded two analysis attempts, no successful analysis, and no returned token usage. Separate diagnostic requests are outside that counter. Timed-out/failed calls may still incur charges; actual billed usage must be checked in the provider dashboard. No cost estimate or zero-usage claim is made.

Automated tests use deterministic detections and cover confirmation, movement, held/uncertain/ambiguous/absent objects, timestamp ordering, duplicate uploads, aliases, authentication, legacy demo exclusion, bounded processing, failure backoff, interrupted leases, restart continuity, and transactional photo/memory rollback. They validate application behavior, not model accuracy. The [placement procedure](object-memory.md#placement-acceptance) remains the release acceptance gate for the demo.

Camera capture stopped after the diagnostic snapshots. No room images or credentials are checked into Git. Consult the PR checks separately for hosted CI status.

## Production readiness checks

On October 11, the merged application at `5d27094` was redeployed to `https://recall-kappa-nine.vercel.app` with `DEMO_MODE=false`, the backend Gemini key, and a reserved MCP test identity. The additive camera schema was applied to the existing Neon production database; its three existing evidence records were preserved.

| Check | Actual result |
| --- | --- |
| Public health | HTTP 200, `{"ok":true,"demo":false}` |
| Authenticated camera status | HTTP 200 with `Cache-Control: no-store`; provider configuration present |
| Missing camera/MCP token | HTTP 401 on status, raw frame, evidence, and MCP routes |
| Non-allowlisted MCP identity | Tool call rejected |
| Authenticated missing evidence | HTTP 404 |
| Hosted MCP smoke | Passed for keys, phone, and wallet; all returned `unknown` without synthetic evidence |
| Camera client in the main checkout | OpenCV installed in `.venv`; seven Python tests passed; 1280×720 snapshot uploaded to production |
| Production image analysis | Three fresh snapshots: timeout at 20,005 ms, HTTP 503 at 1,582 ms, then HTTP 503 at 5,159 ms after backoff; no sighting saved |
| Separate Gemini 3.6 Flash diagnostics | Retained-image and text requests returned HTTP 429; provider reported project quota exceeded; no memory writes or production model change |
| Gemini 3.8 Flash retained-image retry | Valid response in 5,940 ms with no target detections; 1,256 input, 10 output, 79 thought, and 1,345 total tokens; no memory write |
| Gemini 3.1 Flash-Lite retained-image diagnostic | Valid response after 25,029 ms with no target detections; 1,369 total tokens; no memory write or production model change |

The hosted pipeline recorded three attempts with no successful analysis or returned usage. Separate provider diagnostics are outside that counter. The successful direct image retry proves that one provider response validated; it does not establish hosted reliability or recognition accuracy. Transport and MCP checks passed, including `unknown` results with camera error metadata after provider failure. Check the Gemini project's [rate limits](https://ai.dev/rate-limit) and obtain a successful hosted image response before the placement test; the 18-placement accuracy gate remains deferred.
