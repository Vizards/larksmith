import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileContent, fileReadArgs, MAX_FILE_BYTES } from '../dist/src/files.js';
const input = { fileToken: 'syntheticFile' };
const textOf = result => JSON.parse(result.content[0].text);

test('file inputs cannot become shell flags, remote URLs or filesystem paths', () => {
  for (const fileToken of ['../secret', '--as=bot', 'https://evil.example', 'a\u0000b']) assert.throws(() => fileReadArgs({ fileToken }));
  assert.throws(() => fileReadArgs({ ...input, source: 'url' }));
  assert.throws(() => fileReadArgs({ ...input, limit: 1048576 }));
  assert.throws(() => fileReadArgs({ ...input, offset: -1 }));
  assert.deepEqual(fileReadArgs({ ...input, source: 'media' }).slice(-2), ['--as=user', '--json']);
});

test('UTF-8 paging preserves Unicode and reports exact continuation offsets', () => {
  const bytes = Buffer.from('A中文😀caféZ');
  let output = ''; let offset = 0;
  while (offset < bytes.length) {
    const page = textOf(fileContent('alpha', { ...input, operation: 'text', offset, limit: 5 }, bytes));
    output += page.text; offset = page.nextOffset;
    assert.equal(page.truncated, offset < bytes.length);
  }
  assert.equal(output, bytes.toString());
  assert.throws(() => fileContent('alpha', { ...input, operation: 'text', offset: 2 }, bytes), /offset_not_utf8_boundary/);
});

test('binary chunks reconstruct the complete file with the same digest and resource size stays bounded', () => {
  const bytes = Buffer.alloc(700000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const chunks = [];
  for (let offset = 0; offset < bytes.length;) {
    const page = textOf(fileContent('alpha', { ...input, operation: 'chunk', offset, limit: 262144 }, bytes));
    chunks.push(Buffer.from(page.data, 'base64')); offset = page.nextOffset;
    assert.equal(page.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const resource = fileContent('alpha', { ...input, operation: 'resource' }, bytes).content[1];
  assert.equal(resource.type, 'resource');
  assert.deepEqual(Buffer.from(resource.resource.blob, 'base64'), bytes);
  assert.throws(() => fileContent('alpha', { ...input, operation: 'resource' }, Buffer.alloc(3 * 1024 * 1024)), /resource_exceeds/);
  assert.throws(() => fileContent('alpha', input, Buffer.alloc(MAX_FILE_BYTES + 1)), /file_exceeds/);
});

test('binary data is not silently decoded as replacement text, and offsets past EOF fail', () => {
  assert.throws(() => fileContent('alpha', { ...input, operation: 'text' }, Buffer.from([0xff, 0x00])), /file_is_not_utf8/);
  assert.throws(() => fileContent('alpha', { ...input, offset: 5 }, Buffer.from('abc')), /offset_past_end/);
});
