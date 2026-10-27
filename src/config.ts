import { z } from 'zod';
import type { Config } from './types.js';

const positiveInteger = (fallback: number, max: number) => z.preprocess(
  (value) => value === undefined ? fallback : value,
  z.coerce.number().int().min(1).max(max),
);
const environment = z.object({
  PORT: positiveInteger(3000, 65535),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  DB_PATH: z.string().trim().min(1).default('./data/logs.db'),
  INGEST_TOKEN: z.string().trim().min(16).max(512),
  VIEW_TOKEN: z.string().trim().min(16).max(512),
  RETENTION_DAYS: positiveInteger(7, 3650),
  MAX_LOGS: positiveInteger(100000, 10000000),
  CORS_ORIGINS: z.string().default('*').transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean)).refine(
    (origins) => origins.length > 0 && (origins.length === 1 && origins[0] === '*' || origins.every((origin) => {
      try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.origin === origin; } catch { return false; }
    })), 'Use * or comma-separated HTTP(S) origins without trailing slash',
  ),
}).refine((env) => env.INGEST_TOKEN !== env.VIEW_TOKEN, { path: ['VIEW_TOKEN'], message: 'Must differ from INGEST_TOKEN' });

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = environment.safeParse(env);
  if (!result.success) {
    // Do not include user-supplied values: they may contain credentials.
    throw new Error('Invalid configuration: ' + result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  const value = result.data;
  return { port: value.PORT, host: value.HOST, dbPath: value.DB_PATH, ingestToken: value.INGEST_TOKEN, viewToken: value.VIEW_TOKEN, retentionDays: value.RETENTION_DAYS, maxLogs: value.MAX_LOGS, corsOrigins: value.CORS_ORIGINS };
}
