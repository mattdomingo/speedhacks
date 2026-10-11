import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { createPhysicalMemory } from '../physical/pipeline.mjs';

const keys = { object: 'keys', location: 'beside the mug', bbox: [100, 100, 200, 200], resting: true, uncertain: false, visibility: 'clear' };
const config = { GEMINI_API_KEY: 'test-only', VISION_MODEL: 'gemini-3.5-flash-lite' };
const baseTime = Date.parse('2026-10-11T12:00:00Z');

function fixture(t, analyze) {
  const dir = mkdtempSync(join(tmpdir(), 'object-memory-'));
  const store = openStore(dir);
  let time = baseTime;
  const now = () => time;
  const memory = createPhysicalMemory(config, store, { now, analyze: analyze || (async () => ({ detections: [keys] })) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, memory, now,
    setTime(seconds) { time = baseTime + seconds * 1000; },
    save(seconds) {
      time = baseTime + seconds * 1000;
      const frame = { timestamp: new Date(time).toISOString(), jpeg: Buffer.from(`jpeg-${seconds}`) };
      store.saveFrame(frame.timestamp, frame.jpeg);
      return frame;
    },
  };
}

test('confirmed memory and its photograph update together and survive disappearance', async t => {
  let detections = [keys];
  const f = fixture(t, async () => ({ detections, usage: { total_tokens: 20 } }));
  f.save(0);
  assert.equal((await f.memory.processLatest()).confirmed, 0);
  f.save(5);
  assert.equal((await f.memory.processLatest()).confirmed, 1);
  const original = f.store.list('camera')[0];
  assert.equal(original.demo, false);
  assert.equal(original.timestamp, new Date(baseTime + 5000).toISOString());
  assert.equal(Buffer.from(f.store.cameraSnapshot(original.frameId).jpeg).toString(), 'jpeg-5');
  detections = [];
  f.save(10);
  await f.memory.processLatest();
  assert.deepEqual(f.store.list('camera')[0], original);
  detections = [{ ...keys, location: 'on the right', bbox: [500, 500, 600, 600] }];
  f.save(15);
  assert.equal((await f.memory.processLatest()).confirmed, 0);
  f.save(20);
  assert.equal((await f.memory.processLatest()).confirmed, 1);
  assert.equal(f.store.list('camera').length, 1);
  assert.equal(f.store.cameraSnapshot(original.frameId), undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM camera_snapshots').get().n, 1);
  assert.equal((await f.memory.status()).totalUsage.total_tokens, 100);
  f.setTime(81);
  assert.equal((await f.memory.status()).status, 'stale');
  assert.equal((await f.memory.status()).analysisStale, true);
});

test('held, occluded, ambiguous and absent detections preserve the last confirmed memory', async t => {
  let detections = [keys];
  const f = fixture(t, async () => ({ detections }));
  for (const seconds of [0, 5]) { f.save(seconds); await f.memory.processLatest(); }
  const saved = f.store.list('camera')[0];
  let seconds = 5;
  for (const candidates of [[{ ...keys, resting: false }], [{ ...keys, uncertain: true }], [keys, keys], []]) {
    detections = candidates;
    for (let i = 0; i < 2; i++) {
      f.save(seconds += 5);
      assert.equal((await f.memory.processLatest()).confirmed, 0);
      assert.deepEqual(f.store.list('camera')[0], saved);
    }
  }
  assert.equal(Buffer.from(f.store.cameraSnapshot(saved.frameId).jpeg).toString(), 'jpeg-5');
});

test('occlusion preserves the photo and timestamp; recovery requires two clear views', async t => {
  const phone = { ...keys, object: 'phone', location: 'on the floor to the right' };
  let detections = [phone];
  const f = fixture(t, async () => ({ detections }));
  for (const seconds of [0, 5]) { f.save(seconds); await f.memory.processLatest(); }
  const saved = f.store.list('camera')[0];
  detections = [{ ...phone, visibility: 'partially_occluded', location: 'on top of the cap' }];
  for (const seconds of [10, 15]) {
    f.save(seconds);
    assert.equal((await f.memory.processLatest()).confirmed, 0);
    assert.deepEqual(f.store.list('camera')[0], saved);
    assert.equal(Buffer.from(f.store.cameraSnapshot(saved.frameId).jpeg).toString(), 'jpeg-5');
  }
  detections = [phone];
  f.save(20);
  assert.equal((await f.memory.processLatest()).confirmed, 0);
  assert.deepEqual(f.store.list('camera')[0], saved);
  f.save(25);
  assert.equal((await f.memory.processLatest()).confirmed, 1);
  const recovered = f.store.list('camera')[0];
  assert.equal(recovered.location, phone.location);
  assert.equal(recovered.timestamp, new Date(baseTime + 25_000).toISOString());
  assert.equal(Buffer.from(f.store.cameraSnapshot(recovered.frameId).jpeg).toString(), 'jpeg-25');
});

test('concurrent requests share one lease and analyze only the newest pending frame', async t => {
  let finish;
  const seen = [];
  const f = fixture(t, async frame => {
    seen.push(frame.timestamp);
    if (seen.length === 1) await new Promise(resolve => { finish = resolve; });
    return { detections: [keys] };
  });
  f.save(0);
  const active = f.memory.processLatest();
  await new Promise(resolve => setImmediate(resolve));
  f.save(5);
  assert.equal((await f.memory.processLatest()).inference, 'busy');
  f.save(10);
  finish();
  await active;
  assert.equal((await f.memory.processLatest()).confirmed, 1);
  assert.deepEqual(seen, [0, 10].map(s => new Date(baseTime + s * 1000).toISOString()));
});

test('rate limits, duplicate frames and confirmation state survive a new store connection', async t => {
  const f = fixture(t);
  f.save(0);
  await f.memory.processLatest();
  const second = openStore(f.dir);
  t.after(() => second.close());
  let calls = 0;
  const memory = createPhysicalMemory(config, second, { now: f.now,
    analyze: async () => { calls++; return { detections: [keys] }; } });
  f.save(1);
  assert.equal((await memory.processLatest()).inference, 'throttled');
  f.save(5);
  assert.equal((await memory.processLatest()).confirmed, 1);
  assert.equal(second.saveFrame(new Date(baseTime).toISOString(), Buffer.from('old')), false);
  f.setTime(10);
  assert.equal((await memory.processLatest()).inference, 'ignored');
  assert.equal(calls, 1);
  assert.equal(second.list('camera')[0].timestamp, new Date(baseTime + 5000).toISOString());
});

test('requests start no faster than twelve per minute', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { detections: [] }; });
  for (let seconds = 0; seconds < 60; seconds++) {
    f.save(seconds);
    await f.memory.processLatest();
  }
  assert.equal(calls, 12);
});

test('expired leases cannot overwrite a newer analysis or confirm across interrupted work', async t => {
  const f = fixture(t);
  f.save(0);
  const abandoned = f.store.claimCameraFrame(f.now());
  f.save(31);
  const replacement = f.store.claimCameraFrame(f.now());
  assert.equal(replacement.status, 'processing');
  assert.equal(replacement.previous, null);
  assert.equal(f.store.finishCameraFrame(abandoned.token, { error: { message: 'late' } }, f.now()), false);
  assert.equal(f.store.readCameraState().leaseId, replacement.token);
});

test('provider failures preserve memory, back off and break confirmation continuity', async t => {
  let fail = false;
  const f = fixture(t, async () => {
    if (fail) throw Object.assign(new Error('Vision provider returned HTTP 429'), { retryAfterMs: 15_000 });
    return { detections: [keys] };
  });
  for (const s of [0, 5]) { f.save(s); await f.memory.processLatest(); }
  const saved = f.store.list('camera')[0];
  fail = true;
  f.save(10);
  assert.equal((await f.memory.processLatest()).inference, 'failed');
  assert.equal((await f.memory.status()).status, 'error');
  f.save(15);
  assert.equal((await f.memory.processLatest()).inference, 'throttled');
  assert.deepEqual(f.store.list('camera')[0], saved);
  f.setTime(70);
  assert.equal((await f.memory.status()).analysisStale, true);
  assert.equal((await f.memory.status()).status, 'error');
  fail = false;
  f.save(75);
  assert.equal((await f.memory.processLatest()).confirmed, 0);
  f.save(80);
  assert.equal((await f.memory.processLatest()).confirmed, 1);
});

test('snapshot write failure rolls back evidence and analysis state', async t => {
  const f = fixture(t);
  f.save(0);
  await f.memory.processLatest();
  f.store.db.exec(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON camera_snapshots
    BEGIN SELECT RAISE(ABORT, 'test snapshot failure'); END;`);
  f.save(5);
  await assert.rejects(f.memory.processLatest(), /snapshot failure/);
  assert.deepEqual(f.store.list('camera'), []);
  assert.equal(f.store.readCameraState().lastAnalyzedAt, new Date(baseTime).toISOString());
});

test('missing credentials and stale frames never call the provider', async t => {
  const f = fixture(t, async () => { throw new Error('must not call'); });
  f.save(0);
  f.setTime(31);
  assert.equal((await f.memory.processLatest()).inference, 'stale');
  const disabled = createPhysicalMemory({}, f.store);
  assert.equal((await disabled.processLatest()).inference, 'not_configured');
  assert.equal((await disabled.status()).status, 'not_configured');
});
