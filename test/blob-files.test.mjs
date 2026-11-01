import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';
import { BlobFilesBackend } from '../dist/src/blob-files.js';
import { StateUnavailable, trackStateUsage } from '../dist/src/state.js';
const filePath = index => `generations/test/temporary-uploads/v1/${'a'.repeat(43)}/${index}.json`;

const blobResponse = (body, etag = '1') => ({ statusCode: 200, blob: { etag, size: Buffer.byteLength(body) }, stream: new Response(body).body });

test('Blob coalesces overlapping reads but never caches a completed file read', async () => trackStateUsage(async usage => {
  let calls = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const backend = new BlobFilesBackend({ now: Date.now, put: async () => {}, get: async () => {
    calls++;
    await waiting;
    return blobResponse('synthetic');
  } });
  const pending = Array.from({ length: 20 }, () => backend.read(filePath(0)));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(pending), Array(20).fill({ etag: '1', body: 'synthetic' }));
  await backend.read(filePath(0));
  assert.equal(calls, 2, 'a later request reads current file bytes');
  assert.deepEqual(usage, { reads: 2, writes: 0, coalesced: 19, blocked: 0 });
}));

test('a completed write prevents a new read joining an older in-flight snapshot', async () => {
  let release;
  let calls = 0;
  const backend = new BlobFilesBackend({ now: Date.now, put: async () => {}, get: async () => {
    if (++calls === 1) {
      await new Promise(resolve => { release = resolve; });
      return blobResponse('old', '1');
    }
    return blobResponse('new', '2');
  } });
  const oldRead = backend.read(filePath(0));
  await backend.compareExchange(filePath(0), '1', 'new');
  assert.equal((await backend.read(filePath(0))).body, 'new');
  release();
  assert.equal((await oldRead).body, 'old');
  assert.equal((await backend.read(filePath(0))).body, 'new');
});

test('Blob outage fails closed, suppresses repeated reads and writes, then recovers', async () => {
  let now = 0, reads = 0, writes = 0, fail = true;
  const backend = new BlobFilesBackend({ now: () => now,
    get: async () => { reads++; if (fail) throw new BlobError('private upstream details'); return blobResponse('recovered'); },
    put: async () => { writes++; },
  });
  await assert.rejects(backend.read(filePath(0)), error => error instanceof StateUnavailable && !error.message.includes('private'));
  fail = false;
  for (let i = 0; i < 10; i++) await assert.rejects(backend.read(i % 2 ? filePath(1) : filePath(0)), StateUnavailable);
  await assert.rejects(backend.compareExchange(filePath(2), '1', 'new'), StateUnavailable);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  now = 60_000;
  assert.equal((await backend.read(filePath(0))).body, 'recovered');
  assert.equal(reads, 2);
});

test('conditional write conflict remains retryable; other write failures open the outage gate', async () => {
  let conflict = true, writes = 0, reads = 0;
  const backend = new BlobFilesBackend({ now: () => 0,
    get: async () => { reads++; return blobResponse('unchanged'); },
    put: async () => { writes++; throw conflict ? new BlobPreconditionFailedError() : new BlobError('denied'); },
  });
  assert.equal(await backend.compareExchange(filePath(0), '1', 'new'), false);
  assert.equal((await backend.read(filePath(0))).body, 'unchanged');
  conflict = false;
  await assert.rejects(backend.compareExchange(filePath(0), '1', 'new'), StateUnavailable);
  await assert.rejects(backend.read(filePath(0)), StateUnavailable);
  assert.equal(writes, 2);
  assert.equal(reads, 1);
});

test('Blob refuses state paths before any network or mutation', async () => {
  let calls = 0;
  const backend = new BlobFilesBackend({ now: Date.now, get: async () => { calls++; }, put: async () => { calls++; } });
  for (const path of ['generations/test/state/v1/oauth.json', 'state/v1/uploads.json', '../file', '']) {
    await assert.rejects(backend.read(path));
    await assert.rejects(backend.compareExchange(path, null, '{}'));
    await assert.rejects(backend.remove([path]));
    await assert.rejects(backend.list(path));
  }
  assert.equal(calls, 0);
});
