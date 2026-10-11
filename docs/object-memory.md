# Object memory: operation and phone handoff

One stationary camera, one user, one keys/phone/wallet instance each, on a fixed tabletop. Answers describe the last reliable sighting, including capture time: “I last saw your keys beside the mug at 12:42.” They do not establish the current location or who moved anything.

## Start

1. Install dependencies and create local secrets with `npm ci && npm run setup`. In the ignored backend `.env`, set `GEMINI_API_KEY` from a paid Gemini project, `DEMO_MODE=false`, and the existing `DEMO_CALLER_NUMBER` allowlist. Never put the provider key in camera-only configuration or phone code.
2. For Vercel, use the existing managed Postgres connection and run `npm run db:init` against that environment. The additive schema preserves evidence and raw frames. Local SQLite migrates additively on open. These changes do not import SQLite records into Postgres.
3. Start the backend with `npm start`, or use its deployed HTTPS origin. The camera needs only `CAMERA_TOKEN` and `BACKEND_URL`; the local npm convenience command loads `.env`.
4. Install `camera/requirements.txt` in `.venv`, allow macOS camera access, then run `PYTHON=.venv/bin/python npm run camera -- --preview`. Preview also uploads. Aim at the tabletop so small keys are clearly resolved; keep the camera fixed and laptop awake. Press `q` to stop, or use Ctrl-C without preview.

Each upload can wait for up to 20 seconds of inference plus database/network time. Model output is capped at 2,048 tokens; the uploader allows 35 seconds. Configure the hosting function duration to cover that budget. Work finishes inside the request; there is no timer or background worker that must survive Vercel suspension.

## Confirmation and retention

- The provider returns keys/phone/wallet, visible location, bounding box `[ymin,xmin,ymax,xmax]` on a 0–1000 scale, and resting/uncertain flags. Zod validates all responses.
- Save only a unique, certain, resting category seen in two consecutive successful analyses, with distinct capture times at most 30 seconds apart and box intersection-over-union of at least 0.5. Missing, held, uncertain, or duplicate-category detections break that category's confirmation chain. Failed analysis breaks all chains.
- A database lease allows one request at a time across Vercel instances. Starts are at least five seconds apart (at most 12/minute). Failures back off for 5–60 seconds, honoring longer provider Retry-After values. New uploads replace the pending raw frame. A busy/throttled pending frame is attempted on a subsequent fresh upload; no upload means no further work.
- The latest successful candidate persists across ordinary serverless cold starts. Expired interrupted leases invalidate continuity; a gap over 30 seconds requires a fresh pair. This adapts the original process-restart rule to Vercel, where requests may use different instances.
- Record and supporting JPEG commit in one transaction. Lease fencing prevents late replies from overwriting newer results. Duplicated or older capture times never supply new evidence. The latest raw frame and one automatic memory/photo per category are retained; earlier manual records remain compatible. Replaced evidence images return 404 unless another category still uses that frame.

The backend uses native fetch with inline JPEGs and `store:false` on Gemini's Interactions API. Paid-project data policy and disabled interaction storage are separate controls; neither is a blanket zero-retention promise. See [image detection](https://ai.google.dev/gemini-api/docs/image-understanding), [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [paid-tier data use](https://ai.google.dev/gemini-api/docs/pricing), and [interaction storage](https://ai.google.dev/gemini-api/docs/interactions-overview).

## Phone contract

Keep the existing MCP authentication and inbound caller headers. `find_object({object})` accepts aliases including `my keys`, `keyring`, `cellphone`, and `mobile phone`. `status` remains `supported` or `unknown`; `camera` is additive. Always speak the evidence timestamp, even when camera analysis is recent. Fresh camera analysis can coexist with an old sighting of an object now hidden.

Illustrative supported response (camera metadata abbreviated):

```json
{
  "status": "supported",
  "evidence": [{
    "id": "vision-keys",
    "source": "camera",
    "object": "keys",
    "location": "beside the mug on the left of the desk",
    "text": "keys last seen beside the mug on the left of the desk",
    "timestamp": "2026-10-11T19:42:00.000Z",
    "demo": false,
    "bbox": [600, 100, 700, 250],
    "model": "gemini-3.8-flash",
    "frameId": "69c47b36818a0ad36ba63539e9ffcf4bd590f8b7409a127d1a60b3889f5f2c44"
  }],
  "camera": { "status": "live", "lastCapturedAt": "2026-10-11T19:42:00.000Z", "lastAnalyzedAt": "2026-10-11T19:42:00.000Z" }
}
```

Unknown means no retained supported observation, not proof the object is absent:

```json
{
  "status": "unknown",
  "evidence": [],
  "camera": { "status": "live", "lastCapturedAt": "2026-10-11T19:42:00.000Z", "lastAnalyzedAt": "2026-10-11T19:42:00.000Z" }
}
```

After 60 seconds without successful analysis, the supported record above stays intact and `camera.status` becomes `stale`. Example camera portion at 19:43:01Z:

```json
{
  "status": "stale",
  "lastCapturedAt": "2026-10-11T19:42:00.000Z",
  "lastAnalyzedAt": "2026-10-11T19:42:00.000Z",
  "processing": false,
  "lastError": null
}
```

Say the historical location and time, and explain that the camera has not checked recently. `analysisStale` also reports the 60-second limit when status is `error` or `not_configured`; those states are not evidence of a new object location. Existing manual observations remain usable. Live mode excludes `demo:true` camera records left in older databases. Phone provisioning and voice behavior belong to the phone integration.

### MCP smoke test

No provisioned phone number or Dial account is required. For MCP-only testing, set `DEMO_CALLER_NUMBER=+14155550123` in both the backend environment and the local `.env`; redeploy after changing hosted configuration. This reserved number is only an authorization value in request headers. The existing `DIAL_MCP_TOKEN` is still required, and no phone call is placed.

With the backend running, `DEMO_MODE=false`, its matching `DIAL_MCP_TOKEN` and allowlisted `DEMO_CALLER_NUMBER` loaded locally (plus `CALLER_PIN` if the backend sets one):

```sh
node --env-file=.env scripts/smoke-object-memory.mjs
```

Set `BACKEND_URL` for the hosted server. The script discovers `find_object`, queries all three categories, checks timestamps/freshness metadata, rejects synthetic evidence, and prints results. It performs read-only MCP calls, with no Dial call and no paid inference. Supported and unknown are both valid smoke-test outcomes; this alone does not measure recognition accuracy. The same script is exercised by the automated HTTP/MCP integration test using a stubbed analyzer.

### Camera diagnostics

Use `Bearer CAMERA_TOKEN` for `/camera/status`, `/camera/frame`, and `/camera/evidence/{frameId}`. All camera responses use `Cache-Control: no-store`; images never have public URLs. Status reports last capture, successful analysis capture time, completion time, lease activity, error, retry time, request count, latest latency, and available provider token usage. `lastAnalyzedAt` tracks any valid analyzed scene, including empty scenes.

`POST /camera/frame` preserves `{timestamp,jpegBase64}` and returns `frameId`, `status:stored|ignored`, and actual `inference`. `analyzedFrameId` identifies the frame actually analyzed, which may be newer than this upload under concurrency. `confirmed` counts updated categories. `analyzed` alone is not a confirmed sighting. Other inference states are `busy`, `throttled`, `ignored`, `stale`, `failed`, `superseded`, and `not_configured`.

## Placement acceptance

Do not substitute generated images or unit-test fixtures for this check. Use six arrangements, recording all three items each time (18 placements):

| Round | Left | Center | Right |
| --- | --- | --- | --- |
| 1 | keys | phone | wallet |
| 2 | wallet | keys | phone |
| 3 | phone | wallet | keys |
| 4 | keys | phone | wallet |
| 5 | wallet | keys | phone |
| 6 | phone | wallet | keys |

For each round, move the items, remove hands, record placement time and visible landmarks, and wait at most 30 seconds for MCP to return a new timestamp with the correct location. Do not count a prior round's memory as success. Record one row per item: round, object, expected location, actual location, placement time, capture time, retrieval time, latency, correctness. Require at least 16/18 correct within 30 seconds.

Separately test an empty scene, occlusion, pickup, and disconnection. Existing valid records must keep their old location and time; no disappearance should invent a destination. Check `camera.status` becomes stale after disconnection. Test extra same-category objects as an ambiguity case.

Save aggregate diagnostics before and after testing: attempts, totalUsage, error counts, and latency. Token counters cover successful responses that supplied usage; timed-out requests may still be billed and require the provider usage dashboard. Keep room photos and personal details out of Git and PRs. This runbook is a procedure, not a claim that acceptance passed.
