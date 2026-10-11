# Object-memory validation — October 11, 2026

Implementation checks passed locally. The later Flash-Lite and occlusion-fix checks below confirmed all three real objects through hosted MCP. The formal 18-placement tabletop acceptance remains deferred; the limited floor checks are not that accuracy benchmark.

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

## October 11, 2026 — Partial-occlusion failure and fix

The user shortened the placement procedure to three unique layouts instead of six repeated rounds. Two layouts passed (6/6 object locations); first fresh retrievals took 8.1 and 12.9 seconds from the testing command, not precisely from physical placement. The third layout is pending. These were floor arrangements, so they do not meet the formal tabletop acceptance gate.

The subsequent cap-over-phone check failed on the previous implementation: captures at 20:56:46Z and 20:56:52Z stored the phone as resting on top of the cap. Visual inspection of the retained evidence showed the cap covering part of the phone. Stable category/bounding boxes and `uncertain:false` were insufficient to validate visibility or the spatial relationship.

Commit `ca8f40a` adds required `clear|partially_occluded|unclear` visibility and accepts only two consecutive clear detections. A partially obscured or legacy candidate cannot confirm even when identity is certain. The public/manual contracts, databases, and dependencies are unchanged. The change preserves existing records; it does not automatically repair a bad record from an older version.

| Check | Actual result |
| --- | --- |
| Clear real-image diagnostic | All three categories assessed clear; 6,183 ms; 1,651 total tokens |
| Covered real-image diagnostics | Both calls assessed the phone partially occluded despite `uncertain:false`; 4,895 / 4,756 ms; 1,593 / 1,570 total tokens. Neither result is eligible to update memory |
| Hosted covered scene | Existing phone record, timestamp, and JPEG hash stayed identical across fresh analyzed captures at 21:06:02Z and 21:06:12Z |
| Uncovered recovery on the verified fix build | All three categories explicitly clear and freshly confirmed at 21:09:30Z, 21:09:41Z, and 21:09:51Z; observed inference latency 2,136–2,477 ms |
| PIN-authenticated hosted MCP at 21:09:46Z | All three aliases returned `supported`, `demo:false`, camera `live`, and capture time 21:09:41Z. Wallet left, keys center, phone right matched the retained photo |
| Local checks | SQLite: 91 passed, 2 Postgres-only skips; disposable Postgres: 93 passed; Python: 7 passed; codegen check passed |
| Hosted CI | Push and PR checks passed for `ca8f40a`, including SQLite, Postgres 17, and Python |
| Production access checks | Public liveness and protected-route smoke checks passed after deployment |

A concurrent deployment of `main` replaced the first fix deployment during testing. That version was detected through deployment metadata and candidates missing visibility; its recovery result was excluded. The fix was redeployed as `dpl_oTBTQCPT5ttunVqsTGud4TRwtGwu` before the verified recovery/MCP checks above. PR #6 remains open; a later deployment from unpatched `main` would replace this test build again.

The three direct diagnostic requests used 4,814 reported total tokens and did not write memories or count as fresh frames. Hosted recovery usage increased by 3,300 total tokens across two subsequent analyses (2,776 input, 524 output). These are observed usage windows, not a complete bill. Private diagnostic JPEGs were removed after review.

This verifies the reported cap-over-phone failure and recovery in the tested scene. Visibility is still judged by the model. Controlled noisy-video, low-light, blur, complete concealment, pickup, and the full 18-placement tabletop acceptance remain unverified by this run.

## Steph phone connection readiness

On October 11, the existing Steph line was connected to `https://recall-kappa-nine.vercel.app/mcp`. Production was redeployed from main `bd1661b` with the consented real caller, the existing PIN, Dial credentials, the matching production webhook secret, and `America/Los_Angeles` as the test time zone. No caller number or secret is recorded here.

| Check | Result |
| --- | --- |
| Dial line | Ready, calling enabled, English, and no call forwarding |
| Context MCP | Exactly one connected production connection with seven tools; the former development MCP connection was removed after Dial rejected duplicate tool names |
| Real caller MCP access | PIN-authenticated `find_object` returned supported historical camera evidence; missing PIN and the former reserved caller were rejected |
| Clock | `whats_today` returned the configured Pacific time zone |
| Signed production webhook | A Dial-generated `webhook.ping` passed signature verification and was read back from Postgres |
| Voice instructions | Added observation time-zone and stale-camera rules to the current live prompt; read-back preserved its other instructions |
| Camera at this checkpoint | Uploads resumed, but the newly deployed Gemini configuration repeatedly hit the twenty-second inference timeout. Stored sightings remained available; fresh placement recognition was not established |
| Real inbound camera-question call | Not performed by this readiness run; the user must make the call and verify the spoken result |

The pre-existing development webhook also subscribes to incoming messages and remains registered; this camera integration replaced the MCP connection only. No reminder, outbound call, or SMS was created during verification. Follow the [phone procedure](object-memory.md#test-with-stephs-phone-line) and check the later readiness updates below before judging a new placement.

### Paid-key recovery and shared phone connection change

The user confirmed that the saved backend Gemini key belongs to the intended paid project. A direct retained-image request using that key succeeded in 4,946 ms with 1,398 reported total tokens and no target detections. This diagnostic did not write memories. The key was applied to Production and latest main `0f04256` was redeployed as `dpl_HJSxx9fZVCzAhYKMAvYe2PUTEyip`; the production alias was verified READY on that deployment. The model, twenty-second timeout, confirmation rules, and stored evidence were unchanged.

Fresh webcam uploads resumed at 21:39:02Z. Subsequent hosted analyses succeeded, with sampled latencies of 2,863 and 3,697 ms. By the 21:40:17Z MCP check, keys, phone, and wallet all returned `supported`, `demo:false`, and fresh capture time 21:40:12Z; camera status was `live`, with no error. The latest analysis latency was 2,791 ms. Across the observed recovery window, attempts increased from 330 to 340 and returned usage increased by 15,785 total tokens (13,880 input, 1,905 output). The direct diagnostic is separate from those counters. Health and unauthenticated camera/MCP rejection checks passed. These results establish provider and pipeline recovery, not another controlled placement benchmark.

A final Dial read-back found that the shared account's production Context MCP had been replaced at 21:37:41Z by a development-tunnel connection with ten tools, and the live voice instructions no longer contained the two camera additions. The author and reason for that change were not established. The development connection was left intact pending the user's choice because replacing it with production would remove three development-only tools. Thus the camera/backend recovery is verified, but the earlier production phone connection check no longer describes the current line. A real camera-question call remains unverified.
