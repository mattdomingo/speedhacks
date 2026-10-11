import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiAnalyzer, parseVision } from '../physical/vision.mjs';
import { confirmedDetections } from '../physical/confirm.mjs';

const keys = { object: 'keys', location: 'beside the mug', bbox: [100, 100, 200, 200], resting: true, uncertain: false };
const frame = (second, detections = [keys]) => ({ frameId: String(second), timestamp: new Date(second * 1000).toISOString(), detections });
const reply = detections => ({ status: 'completed', steps: [{ type: 'model_output', content: [
  { type: 'text', text: JSON.stringify({ detections }) },
] }], usage: { total_input_tokens: 100, total_output_tokens: 40, total_tokens: 140 } });

test('confirmation needs distinct ordered frames within thirty seconds and overlapping boxes', () => {
  assert.deepEqual(confirmedDetections(null, frame(1)), []);
  assert.deepEqual(confirmedDetections(frame(1), frame(1)), []);
  assert.deepEqual(confirmedDetections(frame(2), frame(1)), []);
  assert.deepEqual(confirmedDetections(frame(1), frame(32)), []);
  assert.equal(confirmedDetections(frame(1), frame(31)).length, 1);
  const moved = { ...keys, bbox: [500, 500, 600, 600] };
  assert.deepEqual(confirmedDetections(frame(1), frame(6, [moved])), []);
  assert.equal(confirmedDetections(frame(6, [moved]), frame(11, [moved])).length, 1);
});

test('held, uncertain, missing and duplicate objects never confirm', () => {
  for (const detections of [[], [{ ...keys, resting: false }], [{ ...keys, uncertain: true }], [keys, keys]]) {
    assert.deepEqual(confirmedDetections(frame(1), frame(6, detections)), []);
    assert.deepEqual(confirmedDetections(frame(1, detections), frame(6)), []);
  }
});

test('vision rejects malformed shapes, unsupported labels and impossible boxes', () => {
  for (const item of [{ ...keys, object: 'cup' }, { ...keys, bbox: [2, 2, 1, 1] },
    { ...keys, bbox: [0, 0, 1001, 100] }, { ...keys, uncertain: undefined }, { ...keys, location: '' }]) {
    assert.throws(() => parseVision({ detections: [item] }));
  }
});

test('Gemini uses stateless authenticated inline images and validates the REST response', async () => {
  const analyze = createGeminiAnalyzer({ GEMINI_API_KEY: 'test-secret' }, async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-secret');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.equal(body.generation_config.max_output_tokens, 2048);
    assert.equal(body.input[1].data, Buffer.from('jpeg').toString('base64'));
    assert.equal(body.response_format.mime_type, 'application/json');
    return Response.json(reply([keys]));
  });
  const result = await analyze({ jpeg: Buffer.from('jpeg') });
  assert.deepEqual(result.detections, [keys]);
  assert.equal(result.usage.total_tokens, 140);
});

test('provider errors, incomplete responses and malformed output cannot become empty sightings', async () => {
  for (const response of [Response.json({ status: 'failed' }), Response.json(reply([{ ...keys, bbox: [] }])),
    Response.json({ status: 'completed', steps: [] })]) {
    await assert.rejects(createGeminiAnalyzer({}, async () => response)({ jpeg: Buffer.from('jpeg') }));
  }
  const limited = createGeminiAnalyzer({}, async () => new Response('private provider body', { status: 429, headers: { 'retry-after': '15' } }));
  await assert.rejects(limited({ jpeg: Buffer.from('jpeg') }), error => error.retryAfterMs === 15_000 && !error.message.includes('private'));
  const unauthorized = createGeminiAnalyzer({}, async () => new Response('', { status: 401 }));
  await assert.rejects(unauthorized({ jpeg: Buffer.from('jpeg') }), error => error.permanent === true);
  const timeout = createGeminiAnalyzer({}, async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(timeout({ jpeg: Buffer.from('jpeg') }), /timed out/);
});
