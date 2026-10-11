import { z } from 'zod';

export const shortText = z.string().trim().min(1).max(500);
export const observationSchema = z.object({
  object: shortText,
  location: shortText,
  timestamp: z.iso.datetime({ offset: true }),
}).strict();

export const frameSchema = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  jpegBase64: z.string().min(4).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export const scheduleInput = z.object({ date: z.iso.date() });
export const messagesInput = z.object({ query: shortText });
export const objectInput = z.object({ object: shortText });

export function memoryResult(evidence) {
  return { status: evidence.length ? 'supported' : 'unknown', evidence };
}
