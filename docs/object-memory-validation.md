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
| Hosted Vercel, managed production database, and real phone call | Not exercised by this feature validation |

The local pipeline recorded two analysis attempts, no successful analysis, and no returned token usage. Separate diagnostic requests are outside that counter. Timed-out/failed calls may still incur charges; actual billed usage must be checked in the provider dashboard. No cost estimate or zero-usage claim is made.

Automated tests use deterministic detections and cover confirmation, movement, held/uncertain/ambiguous/absent objects, timestamp ordering, duplicate uploads, aliases, authentication, legacy demo exclusion, bounded processing, failure backoff, interrupted leases, restart continuity, and transactional photo/memory rollback. They validate application behavior, not model accuracy. The [placement procedure](object-memory.md#placement-acceptance) remains the release acceptance gate for the demo.

Camera capture stopped after the diagnostic snapshots. No room images or credentials are checked into Git. This report records local results; consult the PR checks separately for hosted CI status.
