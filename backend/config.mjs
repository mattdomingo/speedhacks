import { z } from 'zod';

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
    // Steph's Dial line; reminder calls and texts come from it.
    STEPH_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).default('+12408962183'),
    DIAL_API_KEY: z.string().trim().default(''),
    DIAL_WEBHOOK_SECRET: z.string().trim().default(''),
    CRON_SECRET: z.string().min(32).or(z.literal('')).default(''),
    PATIENT_TIME_ZONE: z.string().refine(zone => {
      try { return Boolean(new Intl.DateTimeFormat('en-US', { timeZone: zone })); } catch { return false; }
    }, 'Unknown time zone').default('America/Los_Angeles'),
  }).parse({ ...env, DATABASE_URL: env.DATABASE_URL || undefined });
  if (env.VERCEL === '1' && !config.DATABASE_URL) {
    throw new Error('Set DATABASE_URL on Vercel; local SQLite is not durable there');
  }
  if (config.DIAL_MCP_TOKEN === config.CAMERA_TOKEN) {
    throw new Error('Use separate Dial and camera secrets');
  }
  if (config.CRON_SECRET && [config.DIAL_MCP_TOKEN, config.CAMERA_TOKEN].includes(config.CRON_SECRET)) {
    throw new Error('Use a separate cron secret');
  }
  return config;
}
