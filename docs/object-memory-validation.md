# Object-memory validation — October 11, 2026

Implementation checks passed locally. The later Flash-Lite recovery check below confirmed all three real objects through hosted MCP. The formal 18-placement tabletop acceptance remains deferred; one floor arrangement is not an accuracy benchmark.

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


## Live recognition recovery with Flash-Lite

On October 11, production at application commit `261807d` was redeployed with `VISION_MODEL=gemini-3.5-flash-lite`. The application already supports this explicit configuration; the accompanying code change updates defaults, fixtures, and setup documentation for future deployments. No API contract, schema, confirmation threshold, or dependency changed.

The old 3.8 model repeatedly returned 503/timeouts, then a 429 with a multi-hour `Retry-After`. The uploader was paused for controlled diagnostics. Three requests with the same real camera image and the unchanged Interactions request (`store:false`) correctly detected its phone and wallet using 3.5 Flash-Lite. The two timed repeats took 1,781 and 1,844 ms and reported 1,419 and 1,432 total tokens. Replaying this diagnostic image did not write memories or count as fresh confirmation evidence.

After updating and redeploying the production configuration, only transient backoff, error/failure, and candidate state from the old model was cleared while no analysis was active. A database transaction verified all existing evidence and snapshot hashes were unchanged; counters and historical analysis metadata were preserved. Fresh webcam uploads then resumed.

| Check | Actual result |
| --- | --- |
| Fresh hosted phone and wallet confirmation | Both confirmed by the second successful analyzed capture at 20:38:02Z; subsequent frames kept confirming them |
| Fresh keys placement | After the user placed keys, all three categories confirmed at 20:38:43Z |
| Hosted MCP retrieval at 20:38:54Z | All three `supported`, `demo:false`, model `gemini-3.5-flash-lite`, with capture time 20:38:48Z |
| Location and supporting photograph | Visual inspection matched phone left, keys between phone and wallet, wallet right; items were resting on carpet, not a tabletop |
| Evidence access | Authenticated JPEG retrieval succeeded with `Cache-Control: no-store` and the record's capture time |
| Last analysis at that MCP check | 1,879 ms, no provider error, camera `live` |
| Camera pause beyond 60 seconds | At 20:40:01Z, camera status became `stale`; all three sighting records and JPEG hashes matched the pause baseline exactly; no new analysis attempts |
| Resume after pause | First successful fresh capture at 20:40:17Z confirmed zero categories; the next qualifying analysis at 20:40:27Z confirmed all three again |
| Production access checks after redeploy | Health HTTP 200 with live mode; unauthenticated camera status/frame/evidence and MCP HTTP 401 |
| Backend tests after the model-default change | 53 passed; 2 Postgres-only tests skipped locally |

This is positive camera → hosted inference → two-frame confirmation → Postgres → MCP evidence for one real arrangement of all three categories. It does not establish the 16/18 tabletop target, occlusion/pickup behavior with real objects, or a working phone call. Paid usage from diagnostic calls is separate from hosted counters; failed requests may also be billed.

Across the first live Flash-Lite run, hosted attempts increased from 17 to 28 (11 successful analyses). Returned usage increased by 15,951 total tokens: 13,816 input and 2,135 output, with zero additional thought tokens. Throttled uploads made no inference request. These are reported token counts, not a billing total.
