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
const endDate = z.iso.date().optional().describe('Inclusive last date; omit for a single day. Maximum 31 days per request.');
const validRange = ({ date, end_date }) => !end_date || (date && end_date >= date && Date.parse(end_date) - Date.parse(date) < 31 * 86_400_000);
const rangeMessage = { message: 'end_date requires date and must be within 31 days on or after it', path: ['end_date'] };
export const scheduleInput = z.object({ date: z.iso.date(), end_date: endDate, pin }).refine(validRange, rangeMessage);
export const messagesInput = z.object({
  query: shortText.optional().describe('Sender or topic keywords. Omit for recent emails when the caller has no specific clue.'),
  date: z.iso.date().optional().describe('First local date to search; omit for the configured recent-mail window.'),
  end_date: endDate,
  pin,
}).refine(validRange, rangeMessage);
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

// Steph (iOS app). Unknown keys are stripped so they never reach the model.
const isoTime = z.iso.datetime({ offset: true });
const timeZone = z.string().max(64).refine(zone => {
  try { return Boolean(new Intl.DateTimeFormat('en-US', { timeZone: zone })); } catch { return false; }
}, 'Unknown time zone').nullish();
export const memorySchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['photo', 'event', 'person', 'place', 'note']),
  summary: z.string().trim().min(1).max(600),
  people: z.array(z.string().max(100)).max(20).default([]),
  place: z.string().max(200).nullish(),
  timestamp: isoTime,
  source: z.string().max(100),
  confidence: z.number().min(0).max(1),
});
export const embedSchema = z.object({
  texts: z.array(z.string().trim().min(1).max(2000)).min(1).max(64),
  input_type: z.enum(['document', 'query']).default('document'),
});
export const askSchema = z.object({
  question: z.string().trim().min(1).max(500),
  now: isoTime,
  time_zone: timeZone,
  memories: z.array(memorySchema).max(24).default([]),
});
export const remindersSchema = z.object({
  now: isoTime,
  time_zone: timeZone,
  candidates: z.array(z.object({
    id: z.string().min(1).max(100),
    kind: z.enum(['meeting', 'promise', 'birthday', 'parking', 'carry']),
    title: z.string().trim().min(1).max(300),
    when: isoTime.nullish(),
    person: z.string().max(100).nullish(),
    memories: z.array(memorySchema).min(1).max(12),
  })).min(1).max(5),
});
