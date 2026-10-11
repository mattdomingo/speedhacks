import { z } from 'zod';
import { isTimeZone } from './time.mjs';

const secret = z.string().min(32);
const optional = schema => z.preprocess(value => value === '' ? undefined : value, schema.optional());
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_TOKEN_KEY', 'ADMIN_TOKEN'];

export function readConfig(env = process.env) {
  const config = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().min(1).default('./data'),
    DATABASE_URL: z.string().url().regex(/^postgres(?:ql)?:\/\//).optional(),
    DIAL_MCP_TOKEN: z.string().min(32),
    CAMERA_TOKEN: z.string().min(32),
    GEMINI_API_KEY: z.string().trim().default(''),
    VISION_MODEL: z.string().trim().min(1).default('gemini-3.8-flash'),
    DEMO_CALLER_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).or(z.literal('')).default(''),
    DEMO_MODE: z.enum(['true', 'false']).default('false'),
    VERCEL: z.string().optional(),
    // Second factor for callers: caller ID alone is spoofable. Set before connecting real Google data.
    CALLER_PIN: optional(z.string().regex(/^\d{4,8}$/, 'Expected 4 to 8 digits')),
    // IANA zone for "today" and calendar dates; defaults to the Google calendar's zone, then UTC.
    TIMEZONE: optional(z.string().refine(isTimeZone, 'Unknown IANA time zone')),
    // Dial Context MCP caller headers; names are configurable until confirmed on a live call.
    DIAL_CALLER_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default('x-dial-user-number'),
    DIAL_DIRECTION_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default('x-dial-direction'),
    // Logs header names (values redacted) on /mcp to confirm what Dial sends.
    DIAL_LOG_HEADERS: z.enum(['true', 'false']).default('false'),
    DIAL_WEBHOOK_SECRET: optional(z.string().min(16)),
    DIAL_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    // Steph's Dial line: reminder calls and texts come from it, and reminder tools only answer on it.
    STEPH_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).default('+12408962183'),
    // Dial REST key for placing reminder calls and texts; unset turns reminders off.
    DIAL_API_KEY: optional(z.string().min(1)),
    // Protects /google/* admin routes; Vercel Cron sends CRON_SECRET to /cron/google-sync.
    ADMIN_TOKEN: optional(secret),
    CRON_SECRET: optional(secret),
    GOOGLE_CLIENT_ID: optional(z.string().min(1)),
    GOOGLE_CLIENT_SECRET: optional(z.string().min(1)),
    GOOGLE_REDIRECT_URI: optional(z.url({ protocol: /^https?$/ })),
    GOOGLE_TOKEN_KEY: optional(z.string().regex(/^[0-9a-f]{64}$/i, 'Expected 64 hex characters')),
    GOOGLE_CALENDAR_IDS: z.string().default('primary'),
    GOOGLE_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
    // Live Google lookups happen mid-call; keep them well inside the voice agent's patience.
    GOOGLE_LIVE_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(1500),
    GMAIL_SYNC_QUERY: z.string().default('newer_than:30d -category:promotions -category:social'),
    // Each message costs 20 Gmail quota units; 250 stays under 6,000 units per user per minute.
    GMAIL_SYNC_LIMIT: z.coerce.number().int().min(1).max(250).default(100),
    // Optional Keewano product analytics; unset disables it entirely.
    KEEWANO_API_KEY: optional(z.string().min(1)),
    KEEWANO_ENDPOINT: optional(z.url({ protocol: /^https$/ })),
    // Only on a server with a persistent disk; unset keeps unsent batches in memory.
    KEEWANO_DATA_DIR: optional(z.string().min(1)),
  }).parse({ ...env, DATABASE_URL: env.DATABASE_URL || undefined });
  if (env.VERCEL === '1' && !config.DATABASE_URL) {
    throw new Error('Set DATABASE_URL on Vercel; local SQLite is not durable there');
  }
  const secrets = [config.DIAL_MCP_TOKEN, config.CAMERA_TOKEN, config.ADMIN_TOKEN, config.DIAL_WEBHOOK_SECRET, config.CRON_SECRET].filter(Boolean);
  if (new Set(secrets).size !== secrets.length) {
    throw new Error('Use separate Dial, camera, admin, webhook and cron secrets');
  }
  // Google is all-or-nothing so a half-configured deployment fails at boot, not mid-call.
  const google = GOOGLE_KEYS.filter(key => config[key]);
  if (google.some(key => key.startsWith('GOOGLE_CLIENT')) && google.length !== GOOGLE_KEYS.length) {
    throw new Error(`Google integration needs ${GOOGLE_KEYS.filter(key => !config[key]).join(', ')}`);
  }
  // On Vercel the scheduled cron is the only scheduled Google sync and Dial-transcript cleanup.
  if (env.VERCEL === '1' && (config.GOOGLE_CLIENT_ID || config.DIAL_WEBHOOK_SECRET) && !config.CRON_SECRET) {
    throw new Error('Set CRON_SECRET on Vercel so the scheduled cron can sync Google and prune Dial events');
  }
  if (config.GOOGLE_REDIRECT_URI) {
    const { protocol, hostname, pathname } = new URL(config.GOOGLE_REDIRECT_URI);
    if (protocol !== 'https:' && !LOCAL_HOSTS.includes(hostname)) {
      throw new Error('GOOGLE_REDIRECT_URI must use HTTPS outside localhost');
    }
    if (pathname !== '/google/callback') throw new Error('GOOGLE_REDIRECT_URI must end in /google/callback');
  }
  return config;
}
