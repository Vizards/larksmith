import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { RedisBackend, SplitStorageBackend } from '../dist/src/redis-storage.js';
import { NamespacedBackend } from '../dist/src/storage.js';
import { StateDocument, deriveKey, seal } from '../dist/src/state.js';
import { createOAuthAdapter, IDLE_SECONDS } from '../dist/src/oauth-state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

// Explicit opt-in. Uses real EVAL/Lua through independent REST clients, with
// synthetic data in a unique generation. No production objects are read.
test('real Redis: cross-instance CAS, replay/revocation, small Grant reads and file routing', { skip: process.env.TEST_REDIS_CLOUD !== '1', timeout: 180_000 }, async () => {
  const master = randomBytes(32).toString('base64url');
  const namespace = `probe-${randomUUID()}`;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const files = new MemoryBackend();
  const backend = () => new NamespacedBackend(new SplitStorageBackend(new RedisBackend({ master, url, token }), files), namespace);
  const state = () => new StateDocument({ master, name: 'oauth', backend: backend(), retries: 30 });
  let now = 1000000;
  const adapter = name => new (createOAuthAdapter(state(), () => now))(name);
  const store = backend();
  try {
    await Promise.all(Array.from({ length: 8 }, () => state().update(doc => { doc.count = (doc.count || 0) + 1; })));
    assert.equal((await state().read()).count, 8);
    const stale = await store.read('state/v1/oauth.json');
    await adapter('Grant').upsert('g', { exp: now + IDLE_SECONDS }, IDLE_SECONDS);
    assert.equal(await store.compareExchange('state/v1/oauth.json', stale.etag, stale.body), false);
    await adapter('AuthorizationCode').upsert('c', { grantId: 'g' }, 120);
    const results = await Promise.allSettled([adapter('AuthorizationCode').consume('c'), adapter('AuthorizationCode').consume('c')]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(await adapter('Grant').find('g'), undefined);
    await assert.rejects(adapter('Grant').upsert('g', {}, IDLE_SECONDS));
    await adapter('Grant').upsert('live', { exp: now + IDLE_SECONDS }, IDLE_SECONDS);
    await adapter('RefreshToken').upsert('r1', { grantId: 'live' }, IDLE_SECONDS);
    now += IDLE_SECONDS - 60;
    await adapter('RefreshToken').consume('r1');
    now += 120;
    assert.ok(await adapter('Grant').find('live'), 'projection follows atomic idle-window renewal');
    await state().update(doc => { doc.padding = 'synthetic '.repeat(16000); });
    const whole = await store.read('state/v1/oauth.json');
    const projection = await store.readGrant('state/v1/oauth.json', `Grant:${state().identifier('live')}`);
    assert.ok(Buffer.byteLength(projection) < Buffer.byteLength(whole.body) / 100);
    assert.ok(!whole.body.includes('synthetic'));
    assert.ok(!projection.includes('consumed'));
    const chunkPath = `temporary-uploads/v1/${'a'.repeat(43)}/0.json`;
    await store.compareExchange(chunkPath, null, seal({ data: Buffer.from('synthetic file').toString('base64') }, deriveKey(master, 'temporary-upload-chunks'), chunkPath));
    assert.ok((await files.list('')).every(path => path.includes('/temporary-uploads/v1/')));
    assert.ok(await adapter('Grant').find('live'));
    assert.equal(await adapter('Grant').find('g'), undefined);
    await adapter('Grant').destroy('live');
    assert.equal(await adapter('Grant').find('live'), undefined);
    await assert.rejects(adapter('RefreshToken').upsert('late', { grantId: 'live' }, IDLE_SECONDS));
    console.log(JSON.stringify({ syntheticRedisProbe: { namespace, concurrentIncrements: 8, replayRejected: true, revocation: true, fullReadBytes: Buffer.byteLength(whole.body), grantReadBytes: Buffer.byteLength(projection) } }));
  } finally {
    await store.remove(await store.list(''));
    assert.deepEqual(await store.list(''), []);
  }
});
