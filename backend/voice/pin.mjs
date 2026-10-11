import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

// Caller ID can be spoofed, so with CALLER_PIN set every memory lookup also needs the PIN.
// Five wrong attempts lock that number out for 15 minutes. Returns a rejection reason or null.
export async function checkPin(store, expected, caller, supplied) {
  if (!expected) return null;
  const callerHash = createHash('sha256').update(`caller-pin:${caller}`).digest('hex');
  if (await store.pinFailures(callerHash, WINDOW_SECONDS) >= MAX_FAILURES) return 'pin_locked';
  if (!supplied) return 'pin_missing';
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    await store.recordPinFailure(callerHash, WINDOW_SECONDS);
    return 'pin_wrong';
  }
  await store.clearPinFailures(callerHash);
  return null;
}

export const PIN_MESSAGES = {
  pin_missing: 'A PIN is required. Ask the caller for their memory PIN, then retry with it as pin. No personal records were retrieved.',
  pin_wrong: 'That PIN is not correct. No personal records were retrieved.',
  pin_locked: 'Too many wrong PIN attempts; try again in 15 minutes. No personal records were retrieved.',
};
