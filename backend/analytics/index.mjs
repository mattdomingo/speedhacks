import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { Keewano } from '@keewano/node-sdk';
import * as events from './keewano-events.generated.mjs';

// Callers who fail the allowlist share one id so strangers' numbers are never profiled.
const ANONYMOUS = '00000000-0000-4000-8000-000000000001';
// Platform events (Dial webhooks) that belong to no caller.
const SERVICE = '00000000-0000-4000-8000-000000000002';

// Stable pseudonymous UUID per caller: phone numbers never leave the backend.
export function pseudonym(secret, caller) {
  if (!caller) return ANONYMOUS;
  const bytes = createHmac('sha256', secret).update(`keewano-user:${caller}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUID version 8 (custom)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function originOf(item) {
  return item.demo ? 'demo' : item.origin ?? item.source;
}

// Product analytics only: tool names, counts, latency and provenance labels. Never
// record names, message text, calendar titles, object descriptions or phone numbers.
export function createAnalytics(config, { sdk = Keewano, log = console } = {}) {
  if (!config.KEEWANO_API_KEY) {
    return { enabled: false, toolCall() {}, rejected() {}, sync() {}, dialEvent() {}, async shutdown() {} };
  }
  sdk.init({
    apiKey: config.KEEWANO_API_KEY,
    customEventSet: events.customEventSet,
    dataDir: join(config.DATA_DIR, 'keewano'),
    ...(config.KEEWANO_ENDPOINT ? { endpoint: config.KEEWANO_ENDPOINT } : {}),
  }).catch(error => log.error(`Keewano init failed: ${error.message}`));

  // Reporting must never slow down or break a phone call.
  function report(userId, build) {
    try {
      if (!sdk.isReady()) return;
      sdk.reportUserBatch({ userId, build }).catch(error => log.warn(`Keewano report failed: ${error.message}`));
    } catch (error) {
      log.warn(`Keewano report failed: ${error.message}`);
    }
  }
  const userFor = caller => pseudonym(config.DIAL_MCP_TOKEN, caller);

  return {
    enabled: true,
    toolCall({ caller, tool, ms, result, failed }) {
      report(userFor(caller), user => {
        events.batchReportToolCalled(user, tool);
        events.batchReportToolLatencyMs(user, Math.max(0, Math.round(ms)));
        if (failed) return events.batchReportToolFailed(user, tool);
        events.batchReportEvidenceCount(user, result.evidence.length);
        if (!result.evidence.length) events.batchReportNoEvidence(user, tool);
        for (const origin of new Set(result.evidence.map(originOf))) events.batchReportEvidenceOrigin(user, `${tool}:${origin}`);
      });
    },
    rejected({ tool, reason }) {
      report(ANONYMOUS, user => events.batchReportCallerRejected(user, `${tool}:${reason}`));
    },
    sync({ caller, results }) {
      report(userFor(caller), user => {
        for (const result of results) events.batchReportGoogleSync(user, `${result.name}:${result.ok ? 'ok' : 'error'}`);
      });
    },
    dialEvent(type) {
      report(SERVICE, user => events.batchReportDialEvent(user, type));
    },
    async shutdown() {
      await sdk.shutdown().catch(error => log.warn(`Keewano shutdown failed: ${error.message}`));
    },
  };
}
