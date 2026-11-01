import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { deriveKey, unseal, StateDocument } from '../dist/src/state.js';
import { RedisBackend } from '../dist/src/redis-storage.js';
import { NamespacedBackend } from '../dist/src/storage.js';
import { MemoryBackend } from './support/memory-backend.mjs';

const master = Buffer.alloc(32, 7).toString('base64url');
const fixture = JSON.parse(await readFile(new URL('./fixtures/state-v1.json', import.meta.url), 'utf8'));

test('v1 encryption, record identifiers and staged file format remain stable', async () => {
  for (const [purpose, expected] of Object.entries(fixture.keys)) assert.deepEqual([...deriveKey(master, purpose)], expected);
  const backend = new MemoryBackend();
  for (const [name, body] of Object.entries(fixture.documents)) {
    await backend.compareExchange(`state/v1/${name}.json`, null, body);
    const doc = await new StateDocument({ master, name, backend }).read();
    assert.equal(doc.records.synthetic.marker, name);
  }
  const state = new StateDocument({ master, name: 'uploads', backend });
  assert.equal(state.identifier(JSON.stringify(['synthetic-client', 'primary', 'synthetic-request'])), fixture.identifier);
  assert.equal(Buffer.from(unseal(fixture.chunk.body, deriveKey(master, 'temporary-upload-chunks'), fixture.chunk.path).data, 'base64').toString(), 'synthetic bytes');
});

test('v1 Redis addresses retain their namespace and encrypted state across instances', async () => {
  const calls = [];
  const client = { async eval(script, keys) { calls.push(keys); return ['synthetic-revision', fixture.documents.oauth]; } };
  const store = new NamespacedBackend(new RedisBackend({ url: 'https://synthetic.upstash.io', token: 'synthetic', master }, { client }), 'test');
  const doc = await new StateDocument({ master, name: 'oauth', backend: store }).read();
  assert.equal(doc.records.synthetic.marker, 'oauth');
  assert.deepEqual(calls, [['lark-mcp:{test}:state/v1/oauth.json']]);
});
