import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';

const secrets = { INGEST_TOKEN: 'write-token-at-least-16', VIEW_TOKEN: 'read-token-at-least-16' };
test('requires distinct credentials and safe numerical configuration', () => {
  for (const env of [{}, { ...secrets, VIEW_TOKEN: secrets.INGEST_TOKEN }, { ...secrets, INGEST_TOKEN: 'short' }, { ...secrets, PORT: '0' }, { ...secrets, MAX_LOGS: '-1' }, { ...secrets, RETENTION_DAYS: 'NaN' }]) {
    assert.throws(() => readConfig(env), /Invalid configuration/);
  }
  const config = readConfig(secrets);
  assert.equal(config.port, 3000);
  assert.equal(config.retentionDays, 7);
  assert.equal(config.maxLogs, 100000);
});
test('accepts explicit origins and never exposes secret values in configuration errors', () => {
  assert.deepEqual(readConfig({ ...secrets, CORS_ORIGINS: 'https://example.com, http://localhost:5173' }).corsOrigins, ['https://example.com', 'http://localhost:5173']);
  assert.throws(() => readConfig({ ...secrets, CORS_ORIGINS: 'https://example.com/path' }), /Invalid configuration/);
  try { readConfig({ ...secrets, VIEW_TOKEN: secrets.INGEST_TOKEN }); assert.fail('must reject equal keys'); } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secrets.INGEST_TOKEN));
  }
});
