import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/app.js';
import type { Config, LogEntry } from '../src/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const ingest = 'ingest-test-token-123456';
const view = 'view-test-token-654321';
const headers = (token = ingest) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const log = (overrides: Record<string, unknown> = {}) => ({ deviceId: 'pad-001', message: '打印任务已接受', ...overrides });
function fixture(overrides: Partial<Config> = {}, now?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), 'printer-logs-'));
  const config: Config = { port: 3000, host: '127.0.0.1', dbPath: join(dir, 'logs.db'), ingestToken: ingest, viewToken: view, retentionDays: 7, maxLogs: 100000, corsOrigins: ['*'], ...overrides };
  let service = createService(config, { now, pollIntervalMs: 10 });
  cleanups.push(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, get service() { return service; }, restart() { service.close(); service = createService(config, { now, pollIntervalMs: 10 }); }, post(body: unknown, token = ingest) { return service.app.request('/api/logs', { method: 'POST', headers: headers(token), body: JSON.stringify(body) }); }, get(query = '', token = view) { return service.app.request(`/api/logs${query}`, { headers: headers(token) }); } };
}

test('accepts a log, supplies server fields and persists across restart', async () => {
  const f = fixture();
  const response = await f.post(log({ data: { code: 0 }, jobId: 'job-1' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { accepted: 1, ids: [1] });
  f.restart();
  const result = await (await f.get()).json();
  assert.equal(result.logs[0].message, '打印任务已接受');
  assert.equal(result.logs[0].level, 'info');
  assert.equal(result.logs[0].tag, 'printer');
  assert.deepEqual(result.logs[0].data, { code: 0 });
  assert.equal(result.logs[0].jobId, 'job-1');
  assert.equal(result.logs[0].timestamp, result.logs[0].receivedAt);
  assert.equal(result.latestId, 1);
});

test('separates write/read tokens and refuses missing, query-string and invalid tokens', async () => {
  const f = fixture();
  assert.equal((await f.service.app.request('/api/logs')).status, 401);
  assert.equal((await f.get('', ingest)).status, 401);
  assert.equal((await f.post(log(), view)).status, 401);
  assert.equal((await f.get('?token=' + view, 'wrong')).status, 401);
  assert.equal((await f.service.app.request('/api/logs/stream', { headers: headers(ingest) })).status, 401);
});

test('validates whole batches before inserting and rejects invalid JSON, types and oversized data', async () => {
  const f = fixture();
  for (const body of [{ logs: [log(), log({ level: 'fatal' })] }, { logs: [] }, log({ deviceId: '' }), log({ timestamp: 'yesterday' }), log({ data: 'x'.repeat(33000) }), Array(101).fill(log()), null]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.service.app.request('/api/logs', { method: 'POST', headers: headers(), body: '{' })).status, 400);
  assert.equal((await f.post(log({ message: 'x'.repeat(270000) }))).status, 413);
  assert.equal((await (await f.get()).json()).logs.length, 0);
});

test('filters, returns descending pages, and treats SQL wildcard characters literally', async () => {
  const f = fixture();
  assert.equal((await f.post({ logs: [log({ message: '100% done', level: 'error', jobId: 'j1', tag: 'usb' }), log({ deviceId: 'pad-002' }), log({ message: '100 done', level: 'error', jobId: 'j1', tag: 'usb' })] })).status, 201);
  const page = await (await f.get('?limit=2')).json();
  assert.deepEqual(page.logs.map((x: LogEntry) => x.id), [3, 2]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextBeforeId, 2);
  const older = await (await f.get('?limit=2&beforeId=2')).json();
  assert.deepEqual(older.logs.map((x: LogEntry) => x.id), [1]);
  assert.equal(older.hasMore, false);
  assert.equal(older.nextBeforeId, null);
  const filtered = await (await f.get('?deviceId=pad-001&level=error&jobId=j1&tag=usb&q=%25')).json();
  assert.deepEqual(filtered.logs.map((x: LogEntry) => x.id), [1]);
  assert.equal((await (await f.get('?q=%27%20OR%201%3D1--')).json()).logs.length, 0);
});

test('rejects invalid query parameters instead of silently ignoring them', async () => {
  const f = fixture();
  for (const query of ['?limit=0', '?limit=201', '?limit=1.2', '?beforeId=-1', '?level=fatal', '?from=bad', '?from=2026-10-28T00:00:00Z&to=2026-10-27T00:00:00Z']) {
    assert.equal((await f.get(query)).status, 400, query);
  }
  assert.equal((await f.service.app.request('/api/logs/stream?afterId=-1', { headers: headers(view) })).status, 400);
});

test('uses server receipt time for filtering/retention and bounds stored row count', async () => {
  let now = new Date('2026-10-27T00:00:00Z');
  const f = fixture({ maxLogs: 2 }, () => now);
  await f.post({ logs: [log({ timestamp: '2000-01-01T00:00:00Z' }), log(), log()] });
  let page = await (await f.get('?from=2026-10-27T00:00:00Z')).json();
  assert.deepEqual(page.logs.map((x: LogEntry) => x.id), [3, 2]);
  now = new Date('2026-11-05T00:00:00Z');
  f.restart();
  assert.equal((await (await f.get()).json()).logs.length, 0);
});

test('supports an explicit client timestamp and JSON context', async () => {
  const f = fixture();
  await f.post(log({ timestamp: '2026-10-27T08:00:00+08:00', sessionId: 'session-1', data: ['x', 2, true, null] }));
  const entry = (await (await f.get()).json()).logs[0];
  assert.equal(entry.timestamp, '2026-10-27T00:00:00.000Z');
  assert.equal(entry.sessionId, 'session-1');
  assert.deepEqual(entry.data, ['x', 2, true, null]);
});

test('provides health without exposing log counts, paths or credentials', async () => {
  const f = fixture();
  const response = await f.service.app.request('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, state: { text: string }) {
  const deadline = setTimeout(() => reader.cancel(), 2500);
  try {
    for (;;) {
      const end = state.text.indexOf('\n\n');
      if (end >= 0) {
        const frame = state.text.slice(0, end);
        state.text = state.text.slice(end + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        const id = frame.match(/^id: (.+)$/m)?.[1];
        return { event, data: data ? JSON.parse(data) : null, id };
      }
      const next = await reader.read();
      assert.equal(next.done, false, 'stream ended before event');
      state.text += new TextDecoder().decode(next.value);
    }
  } finally { clearTimeout(deadline); }
}

test('SSE delivers filtered new logs and replays by ID after reconnect', async () => {
  const f = fixture();
  await f.post({ logs: [log(), log({ deviceId: 'other' }), log()] });
  const response = await f.service.app.request('/api/logs/stream?afterId=1&deviceId=pad-001', { headers: headers(view) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  cleanups.push(() => { void reader.cancel(); });
  const state = { text: '' };
  assert.equal((await readEvent(reader, state)).event, 'ready');
  let event = await readEvent(reader, state);
  assert.equal(event.event, 'log');
  assert.equal(event.id, '3');
  await f.post(log({ message: 'new event' }));
  event = await readEvent(reader, state);
  assert.equal(event.id, '4');
  assert.equal(event.data.message, 'new event');
  await reader.cancel();
  const reconnect = await f.service.app.request('/api/logs/stream?afterId=3', { headers: headers(view) });
  const second = reconnect.body!.getReader();
  cleanups.push(() => { void second.cancel(); });
  const state2 = { text: '' };
  await readEvent(second, state2);
  assert.equal((await readEvent(second, state2)).id, '4');
  await second.cancel();
});

test('default stream starts at current latest and service shutdown closes idle streams', async () => {
  const f = fixture();
  await f.post(log());
  const response = await f.service.app.request('/api/logs/stream', { headers: headers(view) });
  const reader = response.body!.getReader();
  const state = { text: '' };
  const ready = await readEvent(reader, state);
  assert.equal(ready.event, 'ready');
  assert.equal(ready.data.afterId, 1);
  f.service.close();
  assert.equal((await reader.read()).done, true);
});

test('HEAD on streaming endpoint never allocates a background stream', async () => {
  const f = fixture();
  const response = await f.service.app.request('/api/logs/stream', { method: 'HEAD', headers: headers(view) });
  assert.equal(response.status, 405);
  assert.equal(await response.text(), '');
});

test('CORS preflight allows terminal headers without requiring credentials', async () => {
  const f = fixture();
  const response = await f.service.app.request('/api/logs', { method: 'OPTIONS', headers: { Origin: 'https://terminal.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers')!, /Authorization/);
});
