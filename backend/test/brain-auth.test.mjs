import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, SAM, START, appleKeys, fixture, signIn } from './brain-helpers.mjs';

test('Continue with Google returns the app a one-time code for a session; the app holds only that token', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/v1/me')).status, 401);
  const start = await f.api('/v1/auth/google/start', { body: { mode: 'self' } });
  const state = new URL(start.body.authorization_url).searchParams.get('state');
  const callback = await f.api(`/google/callback?state=${state}&code=auth-code`);
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get('location'));
  assert.equal(`${location.protocol}//${location.host}${location.pathname}`, 'recall://auth');
  const code = location.searchParams.get('code');
  const exchanged = await f.api('/v1/auth/exchange', { body: { code } });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.user.google.email, 'ada@example.com');
  assert.equal(exchanged.body.user.steph_number, '+12408962183');
  assert.equal((await f.api('/v1/auth/exchange', { body: { code } })).status, 401, 'login codes are single use');
  const reused = await f.api(`/google/callback?state=${state}&code=again`);
  assert.notEqual(reused.status, 302, 'a used sign-in state never hands the app another session');
  const me = await f.api('/v1/me', { token: exchanged.body.session_token });
  assert.equal(me.body.role, 'self');
  const stored = await f.store.users();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].owner, true);
  assert.equal(JSON.stringify(stored).includes(exchanged.body.session_token), false, 'only a hash of the session is stored');
});

test('a cancelled Google consent sends the app an error, not a session', async t => {
  const f = await fixture(t);
  const start = await f.api('/v1/auth/google/start', { body: {} });
  const state = new URL(start.body.authorization_url).searchParams.get('state');
  const callback = await f.api(`/google/callback?state=${state}&error=access_denied`);
  assert.equal(new URL(callback.headers.get('location')).searchParams.get('error'), 'access_denied');
});

test('Sign in with Apple checks Apple\'s signature, issuer, audience and expiry', async t => {
  const keys = appleKeys();
  const f = await fixture(t, { fetch: keys.fetch });
  const ok = await f.api('/v1/auth/apple', { body: { identity_token: keys.token({}), full_name: 'Ada Lovelace' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Ada Lovelace');
  const again = await f.api('/v1/auth/apple', { body: { identity_token: keys.token({}) } });
  assert.equal(again.body.user.id, ok.body.user.id);
  for (const claims of [{ aud: 'com.other.app' }, { iss: 'https://evil.example' }, { exp: Math.floor(START / 1000) - 1 }]) {
    assert.equal((await f.api('/v1/auth/apple', { body: { identity_token: keys.token(claims) } })).status, 401, JSON.stringify(claims));
  }
  const forged = `${keys.token({}).split('.').slice(0, 2).join('.')}.${Buffer.from('forged').toString('base64url')}`;
  assert.equal((await f.api('/v1/auth/apple', { body: { identity_token: forged } })).status, 401);
  const off = await fixture(t, { overrides: { APPLE_BUNDLE_IDS: undefined } });
  assert.equal((await off.api('/v1/auth/apple', { body: { identity_token: keys.token({}) } })).status, 503);
});

test('Steph texts a six-digit code from her number; wrong codes run out and sends are rate limited', async t => {
  const f = await fixture(t);
  const { token } = await signIn(f);
  assert.equal((await f.api('/v1/auth/phone/start', { token, body: { phone: '4155550123' } })).status, 400);
  const sent = await f.api('/v1/auth/phone/start', { token, body: { phone: ADA } });
  assert.deepEqual(sent.body, { sent: true, expires_in: 600 });
  assert.equal(f.dial.texts[0].from, '+12408962183');
  assert.match(f.dial.texts[0].body, /^Your Steph code is \d{6}$/);
  const code = f.dial.codeFor(ADA);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await f.api('/v1/auth/phone/verify', { token, body: { phone: ADA, code: wrong } })).status, 400);
  assert.equal((await f.api('/v1/auth/phone/verify', { token, body: { phone: ADA, code } })).status, 400, 'five misses spend the code');
  for (let i = 0; i < 4; i++) await f.api('/v1/auth/phone/start', { token, body: { phone: ADA } });
  assert.equal((await f.api('/v1/auth/phone/start', { token, body: { phone: ADA } })).status, 429);
  f.clock.now += 61 * 60_000;
  await f.api('/v1/auth/phone/start', { token, body: { phone: ADA } });
  const verified = await f.api('/v1/auth/phone/verify', { token, body: { phone: ADA, code: f.dial.codeFor(ADA) } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.phone, ADA);
  const other = await signIn(f, { email: 'sam@example.com' });
  await f.api('/v1/auth/phone/start', { token: other.token, body: { phone: ADA } });
  const taken = await f.api('/v1/auth/phone/verify', { token: other.token, body: { phone: ADA, code: f.dial.codeFor(ADA) } });
  assert.equal(taken.status, 409, 'a number belongs to one account');
});

test('the legacy demo caller becomes a real account when that number is verified', async t => {
  const f = await fixture(t, { overrides: { DEMO_CALLER_NUMBER: ADA } });
  const placeholder = await f.api('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${'d'.repeat(64)}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Dial-User-Number': ADA,
    'X-Dial-Direction': 'inbound', 'X-Dial-Agent-Number': '+12408962183' },
  body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_medication', arguments: {} } } });
  assert.equal(placeholder.status, 200);
  const before = await f.store.userBy('phone', ADA);
  assert.equal(before.settings.placeholder, true);
  const { user } = await signIn(f, { phone: ADA });
  assert.equal(user.phone, ADA);
  assert.equal((await f.store.users()).length, 1, 'the placeholder merged into the signed-in account');
  assert.equal((await f.store.memoryCount(user.id)), 1, 'its memories came along');
});

test('caregiver setup: the caregiver verifies themselves, then the patient\'s phone; the device session becomes the patient\'s', async t => {
  const f = await fixture(t);
  const caregiver = await signIn(f, { mode: 'caregiver', phone: SAM, email: 'sam@example.com' });
  assert.equal(caregiver.user.role, 'caregiver');
  const self = await signIn(f, { email: 'other@example.com' });
  assert.equal((await f.api('/v1/caregiver/patient/start', { token: self.token, body: { phone: ADA } })).status, 403);
  await f.api('/v1/caregiver/patient/start', { token: caregiver.token, body: { phone: ADA, name: 'Mom' } });
  assert.match(f.dial.texts.at(-1).body, /^Hi Mom, this is Steph\. Your Steph code is \d{6}$/);
  const result = await f.api('/v1/caregiver/patient/verify', { token: caregiver.token, body: { phone: ADA, code: f.dial.codeFor(ADA), name: 'Mom' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.role, 'patient');
  assert.equal(result.body.user.caregiver.phone_last4, '0199');
  const patient = await f.api('/v1/me', { token: result.body.session_token });
  assert.equal(patient.body.phone, ADA);
  assert.equal((await f.store.ownerUser()).id, patient.body.id, 'household data serves the patient');
  assert.equal((await f.api('/v1/me', { token: caregiver.token })).body.patient.name, 'Mom');
});
