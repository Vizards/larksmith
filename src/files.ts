import type { CallToolResult } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { invoke } from './cli.ts';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export function fileReadArgs({ source = 'drive', fileToken, operation = 'info', offset = 0, limit = 65536 }) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(fileToken || '') || !['drive', 'media'].includes(source)) fail('invalid_file_reference');
  if (!['info', 'text', 'chunk', 'resource'].includes(operation)) fail('invalid_file_operation');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_BYTES || !Number.isInteger(limit) || limit < 1 || limit > 262144) fail('invalid_file_window');
  return source === 'drive'
    ? ['drive', '+download', `--file-token=${fileToken}`, '--output=./attachment.bin', '--as=user', '--json']
    : ['docs', '+media-download', `--token=${fileToken}`, '--output=./attachment.bin', '--as=user', '--json'];
}
export function fileContent(account, input, bytes) {
  const { source = 'drive', fileToken, operation = 'info', offset = 0, limit = 65536 } = input;
  fileReadArgs(input);
  if (bytes.length > MAX_FILE_BYTES) fail('file_exceeds_32_mib_limit');
  if (offset > bytes.length) fail('offset_past_end');
  const utf8 = isUtf8(bytes) && !bytes.includes(0);
  const mimeType = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
    : bytes[0] === 0x1f && bytes[1] === 0x8b ? 'application/gzip'
    : bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) ? 'application/zip'
    : utf8 ? 'text/plain' : 'application/octet-stream';
  const metadata = { account, identity: 'user', source, fileToken, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType };
  let end = Math.min(offset + limit, bytes.length);
  if (operation === 'text') {
    if (!utf8) fail('file_is_not_utf8_text');
    // End on a codepoint boundary; nextOffset can be passed unchanged.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end <= offset && offset < bytes.length) fail('window_smaller_than_codepoint');
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end)); } catch { fail('offset_not_utf8_boundary'); }
    Object.assign(metadata, { offset, nextOffset: end, truncated: end < bytes.length, text: value });
  }
  if (operation === 'chunk') Object.assign(metadata, { offset, nextOffset: end, truncated: end < bytes.length, encoding: 'base64', data: bytes.subarray(offset, end).toString('base64') });
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(metadata) }];
  if (operation === 'resource') {
    if (bytes.length > 2 * 1024 * 1024) fail('resource_exceeds_2_mib_use_chunks');
    content.push({ type: 'resource', resource: { uri: `lark-file://${account}/${source}/${fileToken}`, mimeType, blob: bytes.toString('base64') } });
  }
  return { content };
}
export async function readFileContent(account, token, input): Promise<CallToolResult> {
  const args = fileReadArgs(input);
  const result = await invoke(args, token, { captureFile: true, timeout: 120000 });
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ account, identity: 'user', result: JSON.parse(result.output) }) }] };
  return fileContent(account, input, result.file);
}
