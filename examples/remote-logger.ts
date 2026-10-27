/**
 * Copy this dependency-free module into jy-uni-terminal.
 * Uses its own uni.request; never passes through the business request helper.
 * Data is an explicit whitelist. PDF bytes, print arguments and business auth
 * headers must never be sent to this service.
 */

export type PrinterLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PrinterLogData {
  eventType?: string;
  code?: number | string;
  status?: number | string;
  requestId?: string;
  stage?: string;
  durationMs?: number;
}

export interface PrinterLogInput {
  level?: PrinterLogLevel;
  tag?: string;
  message: string;
  jobId?: string;
  data?: PrinterLogData;
}

interface UniRequestOptions {
  url: string;
  method: 'POST';
  timeout: number;
  header: Record<string, string>;
  data: { logs: WireLog[] };
  success: (response: { statusCode: number }) => void;
  fail: (error: unknown) => void;
}

export interface UniLike {
  request(options: UniRequestOptions): unknown;
}

// Module-scoped declaration also lets this example type-check outside uni-app.
declare const uni: UniLike;

export interface RemoteLoggerOptions {
  baseUrl: string;
  ingestToken: string;
  deviceId: string;
  sessionId?: string;
  enabled?: boolean;
  client?: UniLike;
}

interface WireLog {
  deviceId: string;
  sessionId?: string;
  timestamp: string;
  level: PrinterLogLevel;
  tag: string;
  message: string;
  jobId?: string;
  data?: PrinterLogData;
}

interface QueuedLog {
  value: WireLog;
  retries: number;
}

export interface RemoteLogger {
  log(input: PrinterLogInput): void;
  error(error: unknown, context?: { jobId?: string; tag?: string }): void;
  /** Best effort; resolves even when the remote API is unavailable. */
  flush(): Promise<void>;
  /** Stops timers and discards pending logs, without affecting printing. */
  stop(): void;
  stats(): { queued: number; inFlight: number; dropped: number };
}

const QUEUE_LIMIT = 200;
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_RETRIES = 2;

function short(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function code(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return short(value, 64);
}

function safeData(value: PrinterLogData | undefined): PrinterLogData | undefined {
  if (!value) return undefined;
  return {
    eventType: short(value.eventType, 128),
    code: code(value.code),
    status: code(value.status),
    requestId: short(value.requestId, 128),
    stage: short(value.stage, 64),
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? value.durationMs
      : undefined,
  };
}

export function createRemoteLogger(options: RemoteLoggerOptions): RemoteLogger {
  const client = options.client ?? (typeof uni === 'undefined' ? undefined : uni);
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/logs`;
  const enabled = options.enabled !== false && Boolean(client);
  let queue: QueuedLog[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightCount = 0;
  let retryAt = 0;
  let dropped = 0;
  let stopped = false;

  function schedule(delayMs = FLUSH_INTERVAL_MS): void {
    if (stopped || !enabled || timer !== undefined || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, Math.max(100, delayMs, retryAt - Date.now()));
  }

  function sendBatch(batch: QueuedLog[]): Promise<number | null> {
    return new Promise((resolve) => {
      let settled = false;
      // A watchdog also bounds the wait if a platform fails to invoke callbacks.
      const watchdog = setTimeout(() => settle(null), REQUEST_TIMEOUT_MS + 250);
      function settle(status: number | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(status);
      }
      try {
        client?.request({
          url: endpoint,
          method: 'POST',
          timeout: REQUEST_TIMEOUT_MS,
          header: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.ingestToken}`,
          },
          data: { logs: batch.map((entry) => entry.value) },
          success: (response) => settle(response.statusCode),
          fail: () => settle(null),
        });
      } catch {
        settle(null);
      }
    });
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (stopped || !enabled || queue.length === 0) return Promise.resolve();
    if (Date.now() < retryAt) {
      schedule(retryAt - Date.now());
      return Promise.resolve();
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = queue.splice(0, BATCH_SIZE);
    // A JSON character takes at most 3 UTF-8 bytes, so this stays below 256 KiB
    // even for non-ASCII messages and JSON-escaped control characters.
    while (batch.length > 1 && JSON.stringify({ logs: batch.map((entry) => entry.value) }).length > 80_000) {
      const last = batch.pop();
      if (last) queue.unshift(last);
    }
    inFlightCount = batch.length;
    inFlight = (async () => {
      const status = await sendBatch(batch);
      if (stopped) return;
      if (status === 201) {
        retryAt = 0;
        return;
      }
      const retryable = status === null || status === 408 || status === 429 || status >= 500;
      const retry = retryable
        ? batch.filter((entry) => entry.retries < MAX_RETRIES)
          .map((entry) => ({ ...entry, retries: entry.retries + 1 }))
        : [];
      dropped += batch.length - retry.length;
      const combined = [...retry, ...queue];
      dropped += Math.max(0, combined.length - QUEUE_LIMIT);
      queue = combined.slice(-QUEUE_LIMIT);
      // Retrying does not call flush recursively; even explicit flush observes this delay.
      const retryDelay = retry.length > 0
        ? FLUSH_INTERVAL_MS * 2 ** Math.max(...retry.map((entry) => entry.retries))
        : FLUSH_INTERVAL_MS;
      retryAt = Date.now() + retryDelay;
    })().catch(() => {
      // Telemetry must never reject into the print flow or recursively log itself.
      dropped += batch.length;
      retryAt = Date.now() + FLUSH_INTERVAL_MS;
    }).finally(() => {
      inFlight = undefined;
      inFlightCount = 0;
      schedule();
    });
    return inFlight;
  }

  function log(input: PrinterLogInput): void {
    if (stopped || !enabled) return;
    try {
      if (queue.length >= QUEUE_LIMIT) {
        queue.shift();
        dropped += 1;
      }
      queue.push({
        retries: 0,
        value: {
          deviceId: options.deviceId.slice(0, 128),
          sessionId: short(options.sessionId, 128),
          timestamp: new Date().toISOString(),
          level: input.level ?? 'info',
          tag: short(input.tag, 64) || 'printer',
          message: input.message.slice(0, 2_000),
          jobId: short(input.jobId, 128),
          data: safeData(input.data),
        },
      });
      schedule();
    } catch {
      dropped += 1;
    }
  }

  return {
    log,
    error(error, context = {}) {
      try {
        const detail = typeof error === 'object' && error !== null
          ? error as Record<string, unknown>
          : {};
        log({
          level: 'error',
          tag: context.tag,
          message: short(detail.message, 2_000) || short(error, 2_000) || '打印调用失败',
          jobId: context.jobId ?? short(detail.jobId, 128),
          data: {
            code: code(detail.code),
            status: code(detail.status),
            requestId: short(detail.requestId, 128),
          },
        });
      } catch {
        dropped += 1;
      }
    },
    flush,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      dropped += queue.length;
      queue = [];
    },
    stats: () => ({ queued: queue.length, inFlight: inFlightCount, dropped }),
  };
}
