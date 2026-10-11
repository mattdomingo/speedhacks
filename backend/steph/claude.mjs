import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { STEPH_SYSTEM_PROMPT, CARD_TYPES, cardFormat } from './prompt.mjs';

// Lenient on shape (the backend repairs it), strict on content: the answer must be a non-empty string.
const cardSchema = z.object({
  answer: z.string(),
  card_type: z.unknown().optional(),
  memory_ids: z.array(z.unknown()).optional(),
  buttons: z.array(z.unknown()).optional(),
}).passthrough();

// The first balanced {...} in text, skipping braces inside strings: recovers JSON wrapped in prose.
export function firstJsonObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

// Parses a model reply into {answer, card_type, memory_ids, buttons}, or null when no answer can be found.
export function parseCard(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = firstJsonObject(text);
  }
  const parsed = cardSchema.safeParse(value);
  if (!parsed.success) return null;
  const { answer, card_type, memory_ids = [], buttons = [] } = parsed.data;
  return {
    answer,
    card_type: CARD_TYPES.includes(card_type) ? card_type : 'answer',
    memory_ids: memory_ids.filter(id => typeof id === 'string'),
    buttons: buttons.filter(label => typeof label === 'string'),
  };
}

export function createClaude(apiKey) {
  return new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
}

// Returns a parsed card, or null when Claude declines, is cut off, or fails upstream.
export async function askClaude(client, model, content) {
  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      // Low effort: a voice reply waits on this, and the answer is one sentence over at most 24 supplied memories.
      output_config: { effort: 'low', format: cardFormat },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: STEPH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
  } catch (error) {
    // Timeouts, 5xx, 429 and connection failures all become a calm 502; nothing about the prompt is logged.
    console.error('Claude request failed:', error instanceof Anthropic.APIError ? error.status ?? error.name : error.name);
    return null;
  }
  if (response.stop_reason !== 'end_turn') {
    console.error('Claude stopped without an answer:', response.stop_reason);
    return null;
  }
  const text = (response.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
  const card = parseCard(text);
  if (!card) console.error('Claude returned an invalid card');
  return card;
}

// Never trust model-cited IDs or label counts: keep only memories the phone sent.
export function shapeCard(card, memories) {
  const answer = card?.answer?.trim();
  if (!answer) return null;
  const known = new Set(memories.map(memory => memory.id));
  const buttons = card.buttons.map(label => label.trim()).filter(Boolean).slice(0, 2);
  return {
    answer, card_type: card.card_type,
    memory_ids: [...new Set(card.memory_ids)].filter(id => known.has(id)),
    buttons: buttons.length ? buttons : ['Thanks!'],
  };
}
