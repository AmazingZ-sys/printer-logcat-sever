import { z } from 'zod';

const shortText = (length: number) => z.string().trim().min(1).max(length);
const isoTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const level = z.enum(['debug', 'info', 'warn', 'error']);
const input = z.strictObject({
  deviceId: shortText(128),
  message: z.string().min(1).max(16384).refine((value) => value.trim().length > 0, 'Message must not be blank'),
  level: level.default('info'),
  tag: shortText(80).default('printer'),
  jobId: shortText(128).optional(),
  sessionId: shortText(128).optional(),
  timestamp: isoTime.optional(),
  data: z.json().refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32768, 'data exceeds 32 KiB').optional(),
});
export const ingestion = z.union([input.transform((entry) => [entry]), z.strictObject({ logs: z.array(input).min(1).max(100) }).transform((body) => body.logs)]);
const integerQuery = (min: number, max = Number.MAX_SAFE_INTEGER) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));
const filters = z.object({
  deviceId: shortText(128).optional(),
  level: level.optional(),
  tag: shortText(80).optional(),
  jobId: shortText(128).optional(),
  q: shortText(256).optional(),
  from: isoTime.optional(),
  to: isoTime.optional(),
});
const validRange = (query: { from?: string; to?: string }) => !query.from || !query.to || query.from <= query.to;
export const historyQuery = filters.extend({ limit: integerQuery(1, 200).default(100), beforeId: integerQuery(1).optional() }).refine(validRange, 'from must not be later than to');
export const streamQuery = filters.extend({ afterId: integerQuery(0).optional() }).refine(validRange, 'from must not be later than to');
