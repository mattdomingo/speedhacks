import { createGeminiAnalyzer, parseVision } from './vision.mjs';
import { confirmedDetections } from './confirm.mjs';
import { cameraStatus } from './state.mjs';

export function createPhysicalMemory(config, store, { analyze = createGeminiAnalyzer(config), now = Date.now } = {}) {
  const configured = Boolean(config.GEMINI_API_KEY);
  const model = config.VISION_MODEL || 'gemini-3.8-flash';
  return {
    async status() {
      const [state, frame] = await Promise.all([store.readCameraState(), store.latestFrame()]);
      return cameraStatus(state, frame, configured, now());
    },
    async processLatest() {
      if (!configured) return { inference: 'not_configured' };
      const lease = await store.claimCameraFrame(now());
      if (lease.status !== 'processing') return { inference: lease.status };
      const started = now();
      let outcome;
      try {
        const result = await analyze(lease.frame);
        const { detections } = parseVision({ detections: result.detections });
        const observation = { frameId: lease.frame.frameId, timestamp: lease.frame.timestamp, model, detections };
        const previous = lease.previous?.model === model ? lease.previous : null;
        const records = confirmedDetections(previous, observation).map(item => ({
          object: item.object, location: item.location, bbox: item.bbox,
          id: `vision-${item.object}`, source: 'camera', demo: false, model,
          timestamp: observation.timestamp, frameId: observation.frameId,
          text: `${item.object} last seen ${item.location}`,
        }));
        outcome = { observation, records, jpeg: lease.frame.jpeg, usage: result.usage || {}, latencyMs: now() - started };
      } catch (error) {
        outcome = { error: { message: error.name === 'ZodError' ? 'Vision response failed validation' : error.message,
          retryAfterMs: error.retryAfterMs || 0 }, latencyMs: now() - started };
      }
      const saved = await store.finishCameraFrame(lease.token, outcome, now());
      return { inference: !saved ? 'superseded' : outcome.error ? 'failed' : 'analyzed',
        analyzedFrameId: lease.frame.frameId, confirmed: saved ? outcome.records?.length || 0 : 0 };
    },
  };
}
