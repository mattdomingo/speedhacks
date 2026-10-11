import { createHash, createHmac, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from 'node:crypto';

const E164 = /^\+[1-9]\d{7,14}$/;
const SESSION_BYTES = 32;
const LOGIN_CODE_MINUTES = 5;
const PHONE_CODE_MINUTES = 10;
const PHONE_SENDS_PER_HOUR = 5;
const PHONE_ATTEMPTS = 5;
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const iso = ms => new Date(ms).toISOString();

export function maskPhone(phone) {
  return phone ? `…${String(phone).slice(-4)}` : null;
}

// Identity, sessions and phone verification. The app only ever holds a random session token;
// the database keeps its SHA-256. Every third-party token stays on the backend.
export function createAuth({ config, store, dial, google, now = Date.now, fetch: fetchImpl = fetch, log = console }) {
  const pepper = config.DIAL_MCP_TOKEN;
  const codeHash = (userId, purpose, phone, code) =>
    createHmac('sha256', pepper).update(`${userId}:${purpose}:${phone}:${code}`).digest('hex');
  let appleKeys = { at: 0, keys: [] };

  async function issueSession(user) {
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    await store.createSession(sha256(token), user.id, iso(now()));
    return token;
  }

  // A placeholder exists only for the legacy DEMO_CALLER_NUMBER allowlist; a real sign-in takes it over.
  const isPlaceholder = user => Boolean(user?.settings?.placeholder) && !user.google_email && !user.apple_sub;

  async function claimPhone(user, phone) {
    const holder = await store.userBy('phone', phone);
    if (holder && holder.id !== user.id) {
      if (!isPlaceholder(holder)) throw new AuthError('That number already belongs to another Steph account', 409);
      await store.updateUser(holder.id, { phone: null }, iso(now()));
      await store.mergeUser(holder.id, user.id);
      if (holder.owner) await store.setOwner(user.id, iso(now()));
    }
    return store.updateUser(user.id, { phone }, iso(now()));
  }

  async function appleKey(kid) {
    if (now() - appleKeys.at > 3_600_000 || !appleKeys.keys.some(key => key.kid === kid)) {
      const response = await fetchImpl(APPLE_KEYS_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new AuthError('Apple sign-in is unavailable right now', 503);
      appleKeys = { at: now(), keys: (await response.json()).keys ?? [] };
    }
    const jwk = appleKeys.keys.find(key => key.kid === kid);
    if (!jwk) throw new AuthError('Apple sign-in token was not recognized', 401);
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  async function verifyApple(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new AuthError('Apple sign-in token is malformed', 401);
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch {
      throw new AuthError('Apple sign-in token is malformed', 401);
    }
    if (header.alg !== 'RS256') throw new AuthError('Apple sign-in token is malformed', 401);
    const valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), await appleKey(header.kid),
      Buffer.from(parts[2], 'base64url'));
    const audiences = (config.APPLE_BUNDLE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
    if (!valid || claims.iss !== APPLE_ISSUER || !audiences.includes(claims.aud) ||
        !(claims.exp * 1000 > now()) || typeof claims.sub !== 'string' || !claims.sub) {
      throw new AuthError('Apple sign-in token was not accepted', 401);
    }
    return claims;
  }

  return {
    issueSession,
    maskPhone,

    async userForToken(token) {
      if (typeof token !== 'string' || token.length < 20) return undefined;
      return store.sessionUser(sha256(token));
    },

    // Express middleware: resolves the session or answers 401.
    requireSession() {
      return async (req, res, next) => {
        try {
          const [scheme, token] = (req.get('authorization') ?? '').split(' ');
          const user = scheme === 'Bearer' ? await this.userForToken(token) : undefined;
          if (!user) return res.status(401).json({ error: 'Unauthorized' });
          req.user = user;
          next();
        } catch (error) {
          next(error);
        }
      };
    },

    // mode: 'self' | 'caregiver' (new sign-in) or 'link' (an existing user connects Google).
    async startGoogle(mode, userId) {
      if (!google?.configured) throw new AuthError('Google sign-in is not configured', 503);
      const url = new URL(await google.beginConnect());
      const state = url.searchParams.get('state');
      await store.saveLoginIntent(state, mode, userId ?? null, iso(now()));
      return url.toString();
    },

    async isLoginState(state) {
      return typeof state === 'string' && Boolean(await store.loginIntent(state));
    },

    // Finishes a Google sign-in started by startGoogle. Returns where to send the browser.
    async completeGoogle(code, state) {
      const intent = await store.takeLoginIntent(state);
      if (!intent || Date.parse(intent.created_at) < now() - 15 * 60_000) throw new AuthError('This sign-in link expired', 400);
      const { email } = await google.completeConnect(code, state);
      if (!email) throw new AuthError('Google did not share an email address', 400);
      const stamp = iso(now());
      let user = intent.mode === 'link' ? await store.user(intent.user_id) : await store.userBy('google_email', email);
      if (user) {
        const other = await store.userBy('google_email', email);
        if (other && other.id !== user.id) throw new AuthError('That Google account belongs to another Steph account', 409);
        user = await store.updateUser(user.id, { google_email: email }, stamp);
      } else {
        user = await store.createUser({ google_email: email, role: intent.mode === 'caregiver' ? 'caregiver' : 'self',
          name: email.split('@')[0] }, stamp);
      }
      // One Google account per deployment (DEC-016): its data serves the person who connected it,
      // or the patient a caregiver later links.
      if (user.role !== 'caregiver') await store.setOwner(user.id, stamp);
      if (intent.mode === 'link') return { linked: true, user };
      const loginCode = randomBytes(24).toString('base64url');
      await store.saveLoginCode(sha256(loginCode), user.id, iso(now() + LOGIN_CODE_MINUTES * 60_000));
      const target = new URL(config.APP_CALLBACK_URL);
      target.searchParams.set('code', loginCode);
      return { redirect: target.toString(), user };
    },

    async exchange(code) {
      const userId = typeof code === 'string' ? await store.takeLoginCode(sha256(code), iso(now())) : undefined;
      if (!userId) throw new AuthError('Sign-in code expired or was already used', 401);
      const user = await store.user(userId);
      return { session_token: await issueSession(user), user };
    },

    async apple(identityToken, fullName) {
      if (!config.APPLE_BUNDLE_IDS) throw new AuthError('Apple sign-in is not configured', 503);
      const claims = await verifyApple(identityToken);
      const stamp = iso(now());
      let user = await store.userBy('apple_sub', claims.sub);
      if (!user) {
        user = await store.createUser({ apple_sub: claims.sub, name: fullName?.trim() || null, role: 'self' }, stamp);
        if (!(await store.ownerUser())) await store.setOwner(user.id, stamp);
      }
      return { session_token: await issueSession(user), user: await store.user(user.id) };
    },

    // purpose: 'self' (the signed-in person's own number) or 'patient' (a caregiver adds someone).
    // via: 'sms' (autofills on iPhone) or 'call', where Steph reads the code aloud — the fallback while
    // carriers reject texts from a number without A2P/10DLC registration.
    async startPhone(user, phone, purpose = 'self', name, via = 'sms') {
      if (!E164.test(phone ?? '')) throw new AuthError('Use a phone number in international format, like +14155550123');
      if (!dial) throw new AuthError('Texting is not configured', 503);
      if (purpose === 'patient' && user.role !== 'caregiver') throw new AuthError('Only a caregiver can add someone', 403);
      const since = iso(now() - 3_600_000);
      if (await store.phoneSendsSince(user.id, since) >= PHONE_SENDS_PER_HOUR) throw new AuthError('Too many codes; try again in an hour', 429);
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await store.savePhoneCode(user.id, purpose, phone, codeHash(user.id, purpose, phone, code), iso(now() + PHONE_CODE_MINUTES * 60_000));
      await store.recordPhoneSend(user.id, iso(now()));
      const greeting = purpose === 'patient' && name ? `Hi ${name.trim().slice(0, 40)}, this is Steph. ` : '';
      if (via === 'call') {
        const digits = code.split('').join(', ');
        await dial.placeCall({ to: phone, from: config.STEPH_NUMBER, maxSeconds: 90, idempotencyKey: `code-${user.id}-${now()}`,
          instruction: ['You are Steph, an AI assistant, calling only to read a sign-in code.',
            `Say: "Hi, this is Steph, an AI assistant. Your Steph code is ${digits}." Then say the code again, slowly, digit by digit: ${digits}.`,
            'Offer to repeat it once more. Do not discuss anything else. Then say goodbye and end the call.'].join('\n') });
      } else {
        await dial.sendText({ to: phone, from: config.STEPH_NUMBER, body: `${greeting}Your Steph code is ${code}` });
      }
      log.info?.(`Sent a Steph phone code by ${via} to ${maskPhone(phone)}`);
      return { sent: true, via, expires_in: PHONE_CODE_MINUTES * 60 };
    },

    async verifyPhone(user, phone, code, purpose = 'self', name) {
      const row = await store.attemptPhoneCode(user.id, purpose);
      const expected = row && row.phone === phone && row.expires_at > iso(now()) && row.attempts <= PHONE_ATTEMPTS
        ? Buffer.from(row.code_hash, 'hex') : undefined;
      const supplied = Buffer.from(codeHash(user.id, purpose, phone, String(code ?? '')), 'hex');
      if (!expected || !timingSafeEqual(expected, supplied)) {
        if (row && row.attempts >= PHONE_ATTEMPTS) await store.deletePhoneCode(user.id, purpose);
        throw new AuthError('That code is not right or has expired');
      }
      await store.deletePhoneCode(user.id, purpose);
      if (purpose === 'self') return { user: await claimPhone(user, phone) };
      // A caregiver set this up: the device session becomes the patient's.
      const stamp = iso(now());
      let patient = await store.createUser({ role: 'patient', caregiver_id: user.id, name: name?.trim() || null }, stamp);
      patient = await claimPhone(patient, phone);
      await store.setOwner(patient.id, stamp);
      return { session_token: await issueSession(patient), user: await store.user(patient.id) };
    },

    // Maps a Dial caller (inbound) or callee (outbound) to a Steph user by verified number. The legacy
    // DEMO_CALLER_NUMBER allowlist maps to a placeholder owner until someone verifies that number.
    async userForPhone(phone) {
      if (!E164.test(phone ?? '')) return undefined;
      const user = await store.userBy('phone', phone);
      if (user) return user;
      if (config.DEMO_CALLER_NUMBER && phone === config.DEMO_CALLER_NUMBER) {
        const stamp = iso(now());
        try {
          const placeholder = await store.createUser({ phone, role: 'self', settings: { placeholder: true } }, stamp);
          if (!(await store.ownerUser())) await store.setOwner(placeholder.id, stamp);
          return store.user(placeholder.id);
        } catch {
          return store.userBy('phone', phone);
        }
      }
      return undefined;
    },
  };
}
