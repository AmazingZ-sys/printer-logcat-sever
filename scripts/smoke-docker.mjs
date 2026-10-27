import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execute = promisify(execFile);
const name = `printer-log-smoke-${randomBytes(5).toString('hex')}`;
const volume = `${name}-data`;
const ingestToken = randomBytes(24).toString('hex');
const viewToken = randomBytes(24).toString('hex');
const docker = async (...args) => (await execute('docker', args, {
  env: { ...process.env, INGEST_TOKEN: ingestToken, VIEW_TOKEN: viewToken },
  timeout: 60000,
})).stdout.trim();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
let volumeCreated = false;
let containerCreated = false;
let reader;
// Some Node versions unref a fetch socket while awaiting stream cancellation.
// Keep the smoke runner alive until its finally block has cleaned up Docker.
const keepAlive = setInterval(() => {}, 1000);
try {
  const image = JSON.parse(await docker('image', 'inspect', 'printer-logcat-server:local'))[0];
  assert.equal(image.Config.User, 'node');
  assert.ok(!image.Config.Env.some((value) => /^(INGEST_TOKEN|VIEW_TOKEN)=/.test(value)));
  await docker('volume', 'create', volume);
  volumeCreated = true;
  await docker('run', '-d', '--name', name, '-p', '127.0.0.1::3000', '--mount', `type=volume,source=${volume},target=/app/data`, '-e', 'INGEST_TOKEN', '-e', 'VIEW_TOKEN', 'printer-logcat-server:local');
  containerCreated = true;
  assert.equal(await docker('exec', name, 'id', '-u'), '1000');
  let base = 'http://' + await docker('port', name, '3000/tcp');
  async function ready() {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Container did not become ready');
  }
  await ready();
  for (const path of ['/', '/app.js', '/styles.css']) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/api/logs')).status, 401);
  assert.equal((await fetch(base + '/api/logs', { headers: auth(ingestToken) })).status, 401);
  const body = { deviceId: 'docker-smoke-pad', level: 'error', jobId: 'docker-smoke-job', message: 'Container persistence and SSE check', data: { code: 'TIMEOUT' } };
  const post = await fetch(base + '/api/logs', { method: 'POST', headers: { ...auth(ingestToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(post.status, 201);
  const stream = await fetch(base + '/api/logs/stream?afterId=0', { headers: auth(viewToken), signal: AbortSignal.timeout(10000) });
  reader = stream.body.getReader();
  let text = '';
  while (!text.includes('event: log') || !text.includes('\n\n', text.indexOf('event: log'))) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'SSE ended before delivering the log');
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /Container persistence and SSE check/);
  await reader.cancel();
  reader = undefined;
  await docker('restart', '--time', '12', name);
  // Docker may assign a different ephemeral host port after restarting.
  const restartedBase = 'http://' + await docker('port', name, '3000/tcp');
  if (base !== restartedBase) console.log('Docker reassigned the temporary test port on restart.');
  base = restartedBase;
  await ready();
  const history = await (await fetch(base + '/api/logs?jobId=docker-smoke-job', { headers: auth(viewToken) })).json();
  assert.equal(history.logs.length, 1);
  assert.equal(history.logs[0].message, body.message);
  await docker('stop', '--time', '12', name);
  const container = JSON.parse(await docker('inspect', name))[0];
  assert.equal(container.State.ExitCode, 0);
  console.log(`Docker smoke passed (${image.Os}/${image.Architecture}): non-root UID 1000, assets, auth, ingest, SSE, persistent volume, restart and clean shutdown.`);
} catch (error) {
  if (containerCreated) {
    console.error('Container logs:', await docker('logs', name));
    console.error('Current published port:', await docker('port', name, '3000/tcp'));
  }
  throw error;
} finally {
  if (reader) await reader.cancel().catch(() => {});
  if (containerCreated) await docker('rm', '-f', name);
  if (volumeCreated) await docker('volume', 'rm', volume);
  clearInterval(keepAlive);
}
