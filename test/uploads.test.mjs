import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { StateDocument } from '../dist/src/state.js';
import { Mutations, digest } from '../dist/src/mutations.js';
import { Uploads } from '../dist/src/uploads.js';
import { CHUNK_BYTES, decodeChunk, fileUrl, publicAddress } from '../dist/src/file-input.js';
import { MemoryBackend } from './support/memory-backend.mjs';

function fixture() {
  let now = Date.now();
  const backend = new MemoryBackend();
  const master = randomBytes(32).toString('base64url');
  const nowFn = () => now;
  const mutations = new Mutations({ state: new StateDocument({ master, name: 'mutations', backend, delay: false }), now: nowFn });
  const executions = [];
  const uploads = new Uploads({ master, backend, mutations, now: nowFn,
    state: new StateDocument({ master, name: 'uploads', backend, delay: false }),
    remove: async paths => { for (const path of paths) backend.data.delete(path); },
    run: async (args, token, options) => {
      const scratch = await mkdtemp(join(tmpdir(), 'lark-test-'));
      try {
        await options.prepare(scratch);
        executions.push({ args, token, bytes: await readFile(join(scratch, 'input.bin')) });
        return { ok: true, output: JSON.stringify({ ok: true, data: { file_token: 'SYNTHETIC', url: 'https://example.feishu.cn/file/SYNTHETIC' } }) };
      } finally { await rm(scratch, { recursive: true }); }
    } });
  return { backend, uploads, mutations, executions, advance: ms => { now += ms; } };
}
const getToken = async () => ({ accessToken: 'test-user-only' });

test('upload staging is encrypted, bound to client/account, ordered and checksum checked; replay creates one file', async () => {
  const f = fixture(); const bytes = randomBytes(CHUNK_BYTES + 37);
  const initial = { requestId: 'synthetic-upload-1', name: '测试.pdf', bytes: bytes.length, sha256: digest(bytes), folderToken: 'test-folder' };
  const { uploadId } = await f.uploads.begin('client', 'alpha', initial);
  await assert.rejects(f.uploads.status('other-client', 'alpha', uploadId));
  await assert.rejects(f.uploads.status('client', 'beta', uploadId));
  await assert.rejects(f.uploads.commit('client', 'alpha', uploadId, getToken), /missing_chunks/);
  await Promise.all([0, 1].map(index => f.uploads.chunk('client', 'alpha', { uploadId, index, data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') })));
  await f.uploads.chunk('client', 'alpha', { uploadId, index: 1, data: bytes.subarray(CHUNK_BYTES).toString('base64') });
  await assert.rejects(f.uploads.chunk('client', 'alpha', { uploadId, index: 1, data: randomBytes(37).toString('base64') }), /different_content/);
  assert.ok([...f.backend.data.values()].every(v => !v.body.includes(bytes.subarray(CHUNK_BYTES).toString('base64'))));
  const result = await f.uploads.commit('client', 'alpha', uploadId, getToken);
  assert.equal(result.sha256, digest(bytes)); assert.equal(result.ok, true);
  assert.deepEqual(f.executions[0].bytes, bytes);
  assert.ok(f.executions[0].args.includes('--as=user'));
  assert.equal((await f.uploads.commit('client', 'alpha', uploadId, getToken)).replayed, true);
  assert.equal(f.executions.length, 1);
  assert.equal([...f.backend.data.keys()].some(p => p.startsWith('temporary-uploads/')), false);
});

test('staging fails before write on altered whole-file hash and actually removes expired data', async () => {
  const f = fixture();
  const bytes = Buffer.from('synthetic');
  const { uploadId } = await f.uploads.begin('c', 'beta', { requestId: 'synthetic-bad-hash', name: 'test.bin', bytes: bytes.length, sha256: '0'.repeat(64) });
  await f.uploads.chunk('c', 'beta', { uploadId, index: 0, data: bytes.toString('base64') });
  await assert.rejects(f.uploads.commit('c', 'beta', uploadId, getToken), /sha256_mismatch/);
  assert.equal(f.executions.length, 0);
  f.advance(86400_001);
  await assert.rejects(f.uploads.status('c', 'beta', uploadId), /expired/);
  assert.equal((await f.uploads.cleanup()).removed, 1);
  assert.equal([...f.backend.data.keys()].some(p => p.startsWith('temporary-uploads/')), false);
});

test('write receipts fence simultaneous calls, changed inputs and lost upstream responses', async () => {
  const f = fixture(); let calls = 0; let release;
  const first = f.mutations.run('client', 'alpha', 'parallel-write', { x: 1 }, async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ok: true }; });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.mutations.run('client', 'alpha', 'parallel-write', { x: 1 }, async () => { calls++; }), /write_in_progress/);
  release(); await first;
  assert.equal(calls, 1);
  await assert.rejects(f.mutations.run('client', 'alpha', 'parallel-write', { x: 2 }, async () => {}), /different_input/);
  await assert.rejects(f.mutations.run('client', 'alpha', 'lost-response', {}, async () => { throw new Error('lost'); }));
  await assert.rejects(f.mutations.run('client', 'alpha', 'lost-response', {}, async () => { calls++; }), /unknown_reconcile/);
  assert.equal(calls, 1);
});

test('native file object routes downloaded bytes through exactly the same user upload and checks expected digest', async () => {
  const f = fixture(); const bytes = Buffer.from('native attachment');
  f.uploads.download = async url => { assert.equal(url, 'https://files.example/test'); return bytes; };
  const input = { requestId: 'native-file-upload', file: { download_url: 'https://files.example/test', file_id: 'file-synthetic', file_name: 'native.txt' } };
  await assert.rejects(f.uploads.single('client', 'alpha', { ...input, sha256: '0'.repeat(64) }, getToken), /sha256_mismatch/);
  const result = await f.uploads.single('client', 'alpha', input, getToken);
  assert.equal(result.sha256, digest(bytes)); assert.equal(f.executions.length, 1);
  assert.equal((await f.uploads.single('client', 'alpha', input, getToken)).replayed, true);
  assert.equal(f.executions.length, 1);
});

test('download targets reject credentials, alternate ports and all private/transition addresses', () => {
  for (const value of ['http://files.example/a', 'https://user:secret@files.example/a', 'https://files.example:8443/a', 'https://127.0.0.1/x', 'https://[::1]/x', 'file:///etc/passwd', 'https://localhost/a']) assert.throws(() => fileUrl(value));
  for (const value of ['127.0.0.1', '0.0.0.0', '10.0.0.5', '172.16.0.1', '192.168.0.1', '100.100.100.200', '169.254.169.254', '198.18.0.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(value), true, value);
  assert.equal(fileUrl('https://files.example/a?signature=test').hostname, 'files.example');
  for (const value of ['@@', 'YQ', 'YQ==\n', 'YQ===']) assert.throws(() => decodeChunk(value));
});
