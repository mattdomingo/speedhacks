import { z } from 'zod';

const STOP = new Set(('a an and are at be did do does for from had has have how i in is it its me my of on or ' +
  'the their there this to was were what when where which who why will with you your again about tell remind ' +
  'today tomorrow yesterday please steph').split(' '));
const SYNONYMS = {
  pill: ['medication', 'medicine', 'meds', 'dose'], pills: ['medication', 'medicine', 'meds', 'dose'],
  medicine: ['medication', 'pill', 'meds'], meds: ['medication', 'pill', 'medicine'],
  mom: ['mother', 'mum'], mother: ['mom', 'mum'], dad: ['father'], father: ['dad'],
  package: ['delivery', 'parcel', 'shipment', 'order'], delivery: ['package', 'parcel', 'shipment'],
  flight: ['airline', 'boarding', 'gate', 'departure'], car: ['parking', 'parked'], parked: ['parking', 'car'],
  doctor: ['appointment', 'clinic', 'dr'], sleep: ['slept', 'sleeping'],
};

export function queryWords(query) {
  const words = String(query ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(word => word.length > 1 && !STOP.has(word));
  return [...new Set(words.flatMap(word => [word, ...(SYNONYMS[word] ?? [])]))].slice(0, 12);
}

// Ranks lexical candidates: matched words in summary/people weigh most, then place and details,
// then recency and confidence. Pure function so both adapters rank identically.
export function rankMemories(candidates, words, nowMs, limit = 12) {
  const scored = candidates.map(memory => {
    const summary = memory.summary.toLowerCase();
    const people = memory.people.join(' ').toLowerCase();
    const place = (memory.place ?? '').toLowerCase();
    const details = JSON.stringify(memory.details ?? {}).toLowerCase();
    let score = 0;
    for (const word of words) {
      if (summary.includes(word)) score += 2;
      if (people.includes(word)) score += 2;
      if (place.includes(word)) score += 1;
      if (details.includes(word)) score += 0.5;
    }
    const time = Date.parse(memory.time ?? memory.updated_at);
    const days = Number.isFinite(time) ? Math.abs(nowMs - time) / 86_400_000 : 365;
    score += words.length ? 1 / (1 + days / 7) : 2 / (1 + days);
    return { memory, score: score * (0.5 + 0.5 * memory.confidence) };
  });
  return scored.filter(entry => !words.length || entry.score > 0.6).sort((a, b) => b.score - a.score)
    .slice(0, limit).map(entry => entry.memory);
}

export async function searchMemories(store, userId, { query, from, to, types, limit = 12 }, nowMs) {
  const words = queryWords(query);
  let candidates = await store.memoryCandidates(userId, { words, from, to, types });
  if (!candidates.length && words.length && (from || to || types?.length)) {
    candidates = await store.memoryCandidates(userId, { from, to, types });
  }
  return rankMemories(candidates, words, nowMs, limit);
}

// What a tool result or app reply shows for a memory: never internal ids of other users.
export function publicMemory(memory) {
  return { id: memory.id, type: memory.type, summary: memory.summary, people: memory.people, place: memory.place,
    time: memory.time, source: memory.source, confidence: memory.confidence,
    ...(Object.keys(memory.details ?? {}).length ? { details: memory.details } : {}) };
}

const text = (max) => z.string().trim().min(1).max(max);
export const MEMORY_TYPES = ['photo', 'event', 'person', 'place', 'note', 'task', 'health', 'location', 'fact', 'conversation'];

// A memory uploaded from the phone: text only, never images.
export const uploadedMemory = z.object({
  source_ref: text(200),
  type: z.enum(MEMORY_TYPES),
  summary: text(600),
  people: z.array(z.string().trim().max(100)).max(20).default([]),
  place: z.string().trim().max(200).nullish(),
  time: z.iso.datetime({ offset: true }).nullish(),
  source: z.enum(['photos', 'apple-calendar', 'apple-reminders', 'contacts', 'location', 'health', 'app']),
  confidence: z.number().min(0).max(1).default(0.8),
  details: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).default({}),
});
export const memorySync = z.object({
  upserts: z.array(uploadedMemory).max(200).default([]),
  deletes: z.array(text(200)).max(200).default([]),
});

export function normalizeTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
