import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createStorageBackend, NamespacedBackend, storageConfig } from '../dist/src/storage.js';
import { SplitStorageBackend } from '../dist/src/redis-storage.js';
import { StateDocument } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

test('Upstash is required; no missing configuration silently chooses another store', () => {
  const base = { BRIDGE_STORAGE_NAMESPACE: 'test' };
  assert.deepEqual(storageConfig(base), { kind: 'upstash', namespace: 'test' });
  assert.throws(() => storageConfig({}));
  assert.throws(() => storageConfig({ ...base, BRIDGE_STORAGE_BACKEND: 'unsupported' }));
  assert.throws(() => storageConfig({ BRIDGE_STORAGE_NAMESPACE: '../other' }));
  assert.throws(() => createStorageBackend(base));
  assert.throws(() => new StateDocument({ master: randomBytes(32).toString('base64url'), name: 'oauth' }), /backend is required/);
});

test('state and encrypted file bytes use distinct stores with stable namespace paths', async () => {
  const state = new MemoryBackend(), files = new MemoryBackend();
  state.readGrant = async () => 'encrypted-grant';
  const store = new NamespacedBackend(new SplitStorageBackend(state, files), 'test');
  const file = `temporary-uploads/v1/${'a'.repeat(43)}/0.json`;
  await store.compareExchange('state/v1/oauth.json', null, 'encrypted-state');
  await store.compareExchange(file, null, 'encrypted-file');
  assert.deepEqual(await state.list(''), ['generations/test/state/v1/oauth.json']);
  assert.deepEqual(await files.list(''), [`generations/test/${file}`]);
  assert.equal(await store.readGrant('state/v1/oauth.json', 'Grant:x'), 'encrypted-grant');
  assert.deepEqual(await store.list(''), ['state/v1/oauth.json', file]);
  for (const path of ['../other', '/state', 'state/../other', 'bad\\path', 'unrecognized/path']) assert.throws(() => store.read(path));
  await store.remove(['state/v1/oauth.json', file]);
  assert.deepEqual(await state.list(''), []); assert.deepEqual(await files.list(''), []);
});
