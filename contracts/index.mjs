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

// Optional on every memory tool; required at runtime only when the backend sets CALLER_PIN.
const pin = z.string().trim().regex(/^\d{4,8}$/).optional()
  .describe('Caller PIN, only when a previous answer said a PIN is required');
export const scheduleInput = z.object({ date: z.iso.date(), pin });
export const messagesInput = z.object({ query: shortText, pin });
export const objectInput = z.object({ object: shortText, pin });

export function memoryResult(evidence) {
  return { status: evidence.length ? 'supported' : 'unknown', evidence };
}

// Phone reminders. `at` is wall-clock time in the person's time zone; the agent never does offset math.
export const setReminderInput = z.object({
  text: z.string().trim().min(1).max(300),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM local time').optional(),
  in_minutes: z.number().int().min(1).max(10_080).optional(),
  channel: z.enum(['call', 'text']).default('call'),
  pin,
});
export const listRemindersInput = z.object({ pin });
export const cancelReminderInput = z.object({ id: z.string().min(1).max(100), pin });
export const clockInput = z.object({});
