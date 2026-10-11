import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createApns } from '../brain/apns.mjs';

test('APNs requests carry an ES256 provider token, the topic and the Steph payload; gone tokens are reported', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const requests = [];
  let status = 200;
  let body = '';
  const apns = createApns({ APNS_KEY_ID: 'ABCDEFGHIJ', APNS_TEAM_ID: 'TEAM123456', APNS_TOPIC: 'com.speedhacks.recall',
    APNS_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }) }, {
    request: async (host, path, headers, payload) => { requests.push({ host, path, headers, payload }); return { status, body }; },
  });
  const device = { apns_token: 'ab'.repeat(32), environment: 'sandbox' };
  assert.equal(await apns.send(device, { title: 'Steph', body: 'Time for your pill', data: { timeline_id: 't_1', kind: 'medication' } }), 'sent');
  const [request] = requests;
  assert.equal(request.host, 'https://api.sandbox.push.apple.com');
  assert.equal(request.path, `/3/device/${device.apns_token}`);
  assert.equal(request.headers['apns-topic'], 'com.speedhacks.recall');
  assert.deepEqual(JSON.parse(request.payload), { aps: { alert: { title: 'Steph', body: 'Time for your pill' }, sound: 'default' },
    steph: { timeline_id: 't_1', kind: 'medication' } });
  const [header, claims, signature] = request.headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'ABCDEFGHIJ' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM123456');
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  status = 410;
  assert.equal(await apns.send(device, { title: 'Steph', body: 'x' }), 'gone');
  status = 400;
  body = JSON.stringify({ reason: 'BadDeviceToken' });
  assert.equal(await apns.send(device, { title: 'Steph', body: 'x' }), 'gone');
  status = 403;
  body = JSON.stringify({ reason: 'InvalidProviderToken' });
  await assert.rejects(apns.send(device, { title: 'Steph', body: 'x' }), /InvalidProviderToken/);
  assert.equal(createApns({}), null);
});
