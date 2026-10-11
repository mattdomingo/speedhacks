import { createHash, randomUUID } from 'node:crypto';

export function frameId(frame) {
  return createHash('sha256').update(new Date(frame.timestamp).toISOString()).update(frame.jpeg).digest('hex');
}

export function claimAnalysis(state, frame, now) {
  if (state.leaseUntil > now) return { status: 'busy' };
  if (state.nextAttemptAt > now) return { status: 'throttled' };
  if (!frame || now - Date.parse(frame.timestamp) > 30_000) return { status: 'stale' };
  if (Date.parse(frame.timestamp) <= (state.lastAttemptCaptureMs ?? -Infinity)) return { status: 'ignored' };
  // An expired lease represents an interrupted analysis, not another confirming observation.
  if (state.leaseId) state.previous = null;
  state.leaseId = randomUUID();
  state.leaseUntil = now + 30_000;
  state.nextAttemptAt = now + 5_000;
  state.lastAttemptCaptureMs = Date.parse(frame.timestamp);
  state.attempts = (state.attempts || 0) + 1;
  return { status: 'processing', token: state.leaseId, previous: state.previous || null,
    frame: { ...frame, jpeg: Buffer.from(frame.jpeg), frameId: frameId(frame) } };
}

export function finishAnalysis(state, token, outcome, now) {
  if (state.leaseId !== token || state.leaseUntil <= now) return false;
  state.leaseId = null;
  state.leaseUntil = 0;
  state.lastLatencyMs = outcome.latencyMs;
  if (outcome.error) {
    state.previous = null;
    state.failures = (state.failures || 0) + 1;
    state.lastError = { message: outcome.error.message, timestamp: new Date(now).toISOString() };
    state.nextAttemptAt = Math.max(state.nextAttemptAt,
      now + Math.min(60_000, 5_000 * 2 ** Math.min(state.failures - 1, 4)),
      now + (outcome.error.retryAfterMs || 0));
  } else {
    state.previous = outcome.observation;
    state.lastAnalyzedAt = outcome.observation.timestamp;
    state.lastCompletedAt = new Date(now).toISOString();
    state.model = outcome.observation.model;
    state.failures = 0;
    state.lastError = null;
    state.lastUsage = outcome.usage;
    state.totalUsage ||= {};
    for (const [key, count] of Object.entries(outcome.usage || {})) {
      state.totalUsage[key] = (state.totalUsage[key] || 0) + count;
    }
  }
  return true;
}

export function cameraStatus(state, frame, configured, now = Date.now()) {
  const stale = !state.lastAnalyzedAt || now - Date.parse(state.lastAnalyzedAt) > 60_000;
  return {
    status: !configured ? 'not_configured' : state.lastError ? 'error' : stale ? 'stale' : 'live',
    analysisStale: stale,
    lastCapturedAt: frame?.timestamp || null,
    lastAnalyzedAt: state.lastAnalyzedAt || null,
    lastCompletedAt: state.lastCompletedAt || null,
    processing: Boolean(state.leaseUntil > now),
    nextAttemptAt: state.nextAttemptAt > now ? new Date(state.nextAttemptAt).toISOString() : null,
    lastError: state.lastError || null,
    attempts: state.attempts || 0,
    lastLatencyMs: state.lastLatencyMs ?? null,
    model: state.model || null,
    lastUsage: state.lastUsage || {},
    totalUsage: state.totalUsage || {},
  };
}
