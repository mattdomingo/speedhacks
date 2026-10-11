import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { openPostgresStore } from '../postgres.mjs';
import { createPhysicalMemory } from '../physical/pipeline.mjs';

test('Postgres coordinates separate instances, retains snapshots and fences interrupted analysis', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const schema = `vision_${randomUUID().replaceAll('-', '')}`;
  const stores = [];
  t.after(async () => {
    await Promise.all(stores.map(store => store.close()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const first = openPostgresStore(url.toString()), second = openPostgresStore(url.toString());
  stores.push(first, second);
  const base = Date.parse('2026-10-11T12:00:00Z');
  let now = base;
  const options = { now: () => now, analyze: async () => ({ detections: [
    { object: 'wallet', location: 'on the left', bbox: [100, 100, 200, 200], resting: true, uncertain: false },
  ] }) };
  const config = { GEMINI_API_KEY: 'test-only' };
  const memoryA = createPhysicalMemory(config, first, options), memoryB = createPhysicalMemory(config, second, options);
  await first.saveFrame(new Date(now).toISOString(), Buffer.from('first'));
  const claims = await Promise.all([first.claimCameraFrame(now), second.claimCameraFrame(now)]);
  assert.equal(claims.filter(item => item.status === 'processing').length, 1);
  const interrupted = claims.find(item => item.status === 'processing');
  now += 31_000;
  await first.saveFrame(new Date(now).toISOString(), Buffer.from('fresh'));
  assert.equal((await memoryB.processLatest()).confirmed, 0);
  assert.equal(await first.finishCameraFrame(interrupted.token, { error: { message: 'late response' } }, now), false);
  now += 5_000;
  await first.saveFrame(new Date(now).toISOString(), Buffer.from('confirmed'));
  assert.equal((await memoryA.processLatest()).confirmed, 1);
  const evidence = (await second.list('camera'))[0];
  assert.equal(evidence.object, 'wallet');
  assert.equal(Buffer.from((await second.cameraSnapshot(evidence.frameId)).jpeg).toString(), 'confirmed');
  assert.equal(await second.saveFrame(new Date(now).toISOString(), Buffer.from('duplicate')), false);
  assert.equal((await memoryB.processLatest()).inference, 'throttled');

  await admin.query(`CREATE FUNCTION reject_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test snapshot failure'; END $$;
    CREATE TRIGGER reject_snapshot BEFORE INSERT OR UPDATE ON camera_snapshots
    FOR EACH ROW EXECUTE FUNCTION reject_snapshot();`);
  now += 5_000;
  await first.saveFrame(new Date(now).toISOString(), Buffer.from('must-not-replace'));
  await assert.rejects(memoryA.processLatest(), /snapshot failure/);
  assert.deepEqual((await second.list('camera'))[0], evidence);
  assert.equal((await second.readCameraState()).lastAnalyzedAt, evidence.timestamp);
  assert.equal(Buffer.from((await second.cameraSnapshot(evidence.frameId)).jpeg).toString(), 'confirmed');
});
