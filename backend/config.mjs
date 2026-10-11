import { z } from 'zod';

export function readConfig(env = process.env) {
  const config = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().min(1).default('./data'),
    DIAL_MCP_TOKEN: z.string().min(32),
    CAMERA_TOKEN: z.string().min(32),
    DEMO_CALLER_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).or(z.literal('')).default(''),
    DEMO_MODE: z.enum(['true', 'false']).default('false'),
  }).parse(env);
  if (config.DIAL_MCP_TOKEN === config.CAMERA_TOKEN) {
    throw new Error('Use separate Dial and camera secrets');
  }
  return config;
}
