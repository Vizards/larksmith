import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { deriveKey, seal, StateDocument, StateUnavailable, unseal } from '../dist/src/state.js';
import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';
import { isConditionalConflict } from '../dist/src/blob-errors.js';
import { MemoryBackend } from './support/memory-backend.mjs';

test('only the two known conditional conflicts are retryable', () => {
  assert.equal(isConditionalConflict(new BlobPreconditionFailedError()), true);
  assert.equal(isConditionalConflict(new BlobError('The conditional request cannot succeed due to a conflicting operation against this resource.')), true);
  assert.equal(isConditionalConflict(new BlobError('Access denied')), false);
  assert.equal(isConditionalConflict(new Error('network timeout')), false);
});

test('state encryption detects corruption, wrong key and namespace swaps', () => {
  const master = randomBytes(32).toString('base64url');
  const key = deriveKey(master, 'test');
  const encoded = seal({ refreshToken: 'synthetic-private-token' }, key, 'alpha');
  assert.ok(!encoded.includes('synthetic-private-token'));
  assert.deepEqual(unseal(encoded, key, 'alpha'), { refreshToken: 'synthetic-private-token' });
  assert.throws(() => unseal(encoded, key, 'beta'), StateUnavailable);
  assert.throws(() => unseal(encoded, randomBytes(32), 'alpha'), StateUnavailable);
  const corrupt = JSON.parse(encoded);
  corrupt.data = Buffer.from('corrupt').toString('base64url');
  assert.throws(() => unseal(JSON.stringify(corrupt), key, 'alpha'), StateUnavailable);
});

test('concurrent state transactions preserve every increment across instances', async () => {
  const backend = new MemoryBackend();
  const master = randomBytes(32).toString('base64url');
  const make = name => new StateDocument({ master, name, backend, delay: false, retries: 30 });
  await Promise.all(Array.from({ length: 20 }, () => make('oauth').update(doc => { doc.counter = (doc.counter || 0) + 1; })));
  assert.equal((await make('oauth').read()).counter, 20);
  await make('alpha').update(doc => { doc.counter = 10; });
  await make('beta').update(doc => { doc.counter = 11; });
  assert.equal((await make('alpha').read()).counter, 10);
  assert.equal((await make('beta').read()).counter, 11);
});

test('one-time consume wins once under contention', async () => {
  const state = new StateDocument({ master: randomBytes(32).toString('base64url'), name: 'oauth', backend: new MemoryBackend(), delay: false });
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => state.update(doc => {
    if (doc.consumed) throw new Error('ALREADY_CONSUMED');
    doc.consumed = true;
    return 'accepted';
  })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 3);
});
