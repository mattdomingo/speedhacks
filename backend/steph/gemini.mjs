import { STEPH_SYSTEM_PROMPT, cardFormat } from './prompt.mjs';
import { parseCard } from './claude.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini says "too busy" with 429; the route answers 503 instead of the 502 used for bad answers.
export class StephBusyError extends Error {}

export function createGemini(apiKey, fetchImpl = fetch, { timeoutMs = 20_000 } = {}) {
  return { apiKey, fetchImpl, timeoutMs };
}

// Same contract as askClaude: a parsed card, or null when Gemini blocks, stops early or fails.
// The system prompt is sent verbatim; the user turn is the same askTurn/reminderTurn text.
// Provider bodies can echo private inputs, so only statuses and finish reasons are logged.
export async function askGemini({ apiKey, fetchImpl, timeoutMs }, model, content, { system = STEPH_SYSTEM_PROMPT, format = cardFormat, parse = parseCard, signal, maxTokens } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: content }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: format.schema,
          ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
          // A voice reply waits on this: one sentence over at most 24 supplied memories.
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
    });
  } catch (error) {
    console.error('Gemini request failed:', error.name);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    console.error('Gemini request failed:', response.status);
    if (response.status === 429) throw new StephBusyError('Steph is busy right now');
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    console.error('Gemini returned a body that is not JSON');
    return null;
  }
  if (body.promptFeedback?.blockReason) {
    console.error('Gemini blocked the prompt:', body.promptFeedback.blockReason);
    return null;
  }
  const [candidate] = body.candidates ?? [];
  if (candidate?.finishReason !== 'STOP') {
    console.error('Gemini stopped without an answer:', candidate?.finishReason ?? 'no candidate');
    return null;
  }
  // Thought summaries (thought: true) are skipped; the answer is the last text part.
  const text = (candidate.content?.parts ?? []).filter(part => typeof part.text === 'string' && !part.thought).at(-1)?.text ?? '';
  const card = parse(text);
  if (!card) console.error('Gemini returned an invalid card');
  return card;
}

// Cheapest authenticated read, for /health. Google answers 400 (not 401) for a bad key.
export async function checkGeminiKey(apiKey, fetchImpl = fetch, timeoutMs = 5_000) {
  const response = await fetchImpl(`${API}/models?pageSize=1`, {
    headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  if (!response.ok) throw Object.assign(new Error(`Gemini models list returned ${response.status}`), { status: response.status });
}
