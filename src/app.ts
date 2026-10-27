import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LogStore } from './store.js';
import { historyQuery, ingestion, streamQuery } from './validation.js';
import type { Config } from './types.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createService(config: Config, options: { now?: () => Date; pollIntervalMs?: number } = {}) {
  const store = new LogStore(config, options.now);
  const app = new Hono();
  let closed = false;
  const streams = new Set<() => void>();
  const expectedIngest = digest(config.ingestToken);
  const expectedView = digest(config.viewToken);
  const maintenance = setInterval(() => {
    try { store.prune(); } catch { console.error('Log retention cleanup failed'); }
  }, 60000);
  maintenance.unref();

  app.use('*', secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] }, strictTransportSecurity: false }));
  app.use('/api/*', cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (closed) return c.json({ error: 'Service is shutting down' }, 503);
    const value = c.req.header('Authorization');
    const token = value?.startsWith('Bearer ') ? value.slice(7) : '';
    const expected = c.req.method === 'POST' && c.req.path === '/api/logs' ? expectedIngest : expectedView;
    if (!token || !timingSafeEqual(digest(token), expected)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Invalid or missing bearer token' }, 401);
    }
    await next();
  });
  app.get('/healthz', (c) => { store.check(); return c.json({ status: 'ok' }); });
  app.post('/api/logs', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request body exceeds 256 KiB' }, 413) }), async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
    const parsed = ingestion.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid log payload: provide deviceId, message and supported field types; max 100 logs per batch' }, 400);
    const ids = store.insert(parsed.data);
    return c.json({ accepted: ids.length, ids }, 201);
  });
  app.get('/api/logs', (c) => {
    const parsed = historyQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid history query or time range' }, 400);
    return c.json(store.history(parsed.data, parsed.data.limit, parsed.data.beforeId));
  });
  // Hono otherwise handles HEAD via GET and discards the body without
  // cancelling the stream, leaving an orphaned database polling loop.
  app.get('/api/logs/stream', (c) => {
    if (c.req.method === 'HEAD') {
      c.header('Allow', 'GET');
      return c.body(null, 405);
    }
    const parsed = streamQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid stream query or time range' }, 400);
    let cursor = parsed.data.afterId ?? store.latestId();
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async (stream) => {
      let active = true;
      let wake: (() => void) | undefined;
      const stop = () => { active = false; wake?.(); stream.abort(); };
      streams.add(stop);
      stream.onAbort(() => { active = false; wake?.(); });
      const wait = () => new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, options.pollIntervalMs ?? 1000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
      try {
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ afterId: cursor }) });
        let heartbeatAt = Date.now();
        while (active && !closed && !stream.aborted) {
          const logs = store.after(parsed.data, cursor);
          for (const log of logs) {
            if (!active || closed) break;
            await stream.writeSSE({ event: 'log', id: String(log.id), data: JSON.stringify(log) });
            cursor = log.id;
          }
          if (Date.now() - heartbeatAt >= 15000) {
            await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ timestamp: new Date().toISOString() }) });
            heartbeatAt = Date.now();
          }
          if (logs.length < 100 && active && !closed) await wait();
        }
      } catch {
        // Disconnected consumers and shutdown must not retain polling loops.
      } finally { active = false; wake?.(); streams.delete(stop); }
    });
  });

  const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
  app.get('/', serveStatic({ root: publicRoot, path: 'index.html' }));
  app.get('/styles.css', serveStatic({ root: publicRoot, path: 'styles.css' }));
  app.get('/app.js', serveStatic({ root: publicRoot, path: 'app.js' }));
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((_error, c) => { console.error('Request failed:', c.req.method, c.req.path); return c.json({ error: 'Internal server error' }, 500); });

  return {
    app,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      for (const stop of streams) stop();
      store.close();
    },
  };
}
