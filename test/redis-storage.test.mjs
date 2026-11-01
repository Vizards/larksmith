import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { RedisBackend, REDIS_READ, REDIS_GRANT } from '../dist/src/redis-storage.js';
import { StateUnavailable, trackStateUsage } from '../dist/src/state.js';
import { createStorageBackend, storageConfig } from '../dist/src/storage.js';

const config = { url: 'https://synthetic.upstash.io', token: 'synthetic', master: randomBytes(32).toString('base64url') };
const path = 'generations/test/state/v1/oauth.json';

test('Redis errors are sanitized and cause a bounded outage gate without mutation retries', async () => {
  let calls = 0, now = 0;
  const backend = new RedisBackend(config, { now: () => now, client: { async eval() { calls++; throw Error('private upstream response'); } } });
  await trackStateUsage(async usage => {
    await assert.rejects(backend.read(path), e => e instanceof StateUnavailable && !e.message.includes('private'));
    await assert.rejects(backend.compareExchange('generations/test/state/v1/uploads.json', null, '{}'), StateUnavailable);
    assert.equal(calls, 1); assert.equal(usage.blocked, 1);
    now = 60_000;
    await assert.rejects(backend.read(path), StateUnavailable);
    assert.equal(calls, 2);
  });
});

test('Redis coalesces overlapping reads but never caches a completed authorization result', async () => {
  let calls = 0;
  const backend = new RedisBackend(config, { client: { async eval(script) {
    assert.equal(script, REDIS_READ); calls++; return ['revision', 'encrypted'];
  } } });
  await trackStateUsage(async usage => {
    await Promise.all(Array.from({ length: 10 }, () => backend.read(path)));
    assert.equal(calls, 1); assert.equal(usage.coalesced, 9);
    await backend.read(path); assert.equal(calls, 2);
  });
});

test('Grant projections fail closed if revision and body do not match', async () => {
  const backend = new RedisBackend(config, { client: { async eval(script) {
    assert.equal(script, REDIS_GRANT);
    return ['new', JSON.stringify({ revision: 'old', body: 'encrypted' })];
  } } });
  await assert.rejects(backend.readGrant(path, `Grant:${'a'.repeat(43)}`), StateUnavailable);
});

test('Upstash requires a namespaced HTTPS endpoint and credentials before I/O', () => {
  assert.throws(() => storageConfig({ BRIDGE_STORAGE_BACKEND: 'upstash' }));
  assert.throws(() => createStorageBackend({ BRIDGE_STORAGE_BACKEND: 'upstash', BRIDGE_STORAGE_NAMESPACE: 'test' }));
  for (const url of ['http://synthetic.upstash.io', 'https://synthetic.upstash.io.evil.test', 'https://synthetic.upstash.io/path']) assert.throws(() => new RedisBackend({ ...config, url }));
  const backend = new RedisBackend(config);
  assert.throws(() => backend.read('state/v1/oauth.json'));
  assert.throws(() => backend.readGrant(path, 'Grant:raw-id'));
});
