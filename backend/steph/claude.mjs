import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { STEPH_SYSTEM_PROMPT, CARD_TYPES, cardFormat } from './prompt.mjs';

const cardSchema = z.object({
  answer: z.string(),
  card_type: z.enum(CARD_TYPES),
  memory_ids: z.array(z.string()),
  buttons: z.array(z.string()),
});

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
    if (!(error instanceof Anthropic.APIError)) throw error;
    console.error('Claude request failed:', error.status ?? error.name);
    return null;
  }
  if (response.stop_reason !== 'end_turn') {
    console.error('Claude stopped without an answer:', response.stop_reason);
    return null;
  }
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
  try {
    return cardSchema.parse(JSON.parse(text));
  } catch {
    console.error('Claude returned an invalid card');
    return null;
  }
}

// Never trust model-cited IDs or label counts: keep only memories the phone sent.
export function shapeCard(card, memories) {
  const answer = card?.answer.trim();
  if (!answer) return null;
  const known = new Set(memories.map(memory => memory.id));
  const buttons = card.buttons.map(label => label.trim()).filter(Boolean).slice(0, 2);
  return {
    answer, card_type: card.card_type,
    memory_ids: [...new Set(card.memory_ids)].filter(id => known.has(id)),
    buttons: buttons.length ? buttons : ['Thanks!'],
  };
}
