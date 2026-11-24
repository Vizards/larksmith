import type { CallToolResult } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { invoke, readApi } from './cli.ts';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export interface FileReadInput {
  source?: 'drive' | 'media' | 'message'; fileToken: string; messageId?: string;
  operation?: 'info' | 'text' | 'chunk' | 'resource'; offset?: number; limit?: number;
}
export function fileReadArgs({ source = 'drive', fileToken, messageId, operation = 'info', offset = 0, limit = 65536 }: FileReadInput) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(fileToken || '') || !['drive', 'media', 'message'].includes(source)) fail('invalid_file_reference');
  if (source === 'message') {
    if (!/^om_[A-Za-z0-9]{1,80}$/.test(messageId || '') || !/^file_[A-Za-z0-9_-]{1,251}$/.test(fileToken)) fail('message_file_requires_message_id_and_file_key');
  } else if (messageId !== undefined) fail('message_id_requires_message_source');
  if (!['info', 'text', 'chunk', 'resource'].includes(operation)) fail('invalid_file_operation');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_BYTES || !Number.isInteger(limit) || limit < 1 || limit > 262144) fail('invalid_file_window');
  if (source === 'message') return ['im', '+messages-resources-download', `--message-id=${messageId}`, `--file-key=${fileToken}`,
    '--type=file', '--output=./attachment.bin', '--as=user', '--json'];
  return source === 'drive'
    ? ['drive', '+download', `--file-token=${fileToken}`, '--output=./attachment.bin', '--as=user', '--json']
    : ['docs', '+media-download', `--token=${fileToken}`, '--output=./attachment.bin', '--as=user', '--json'];
}
// Only accept resource fields in the authoritative body, never a key-looking
// string in message text. Forwarded containers and folders need other workflows.
export function messageFileDetails(message: any, fileKey: string) {
  if (message.deleted === true) fail('message_recalled');
  if (!['file', 'audio', 'media', 'post'].includes(message.msg_type)) fail('message_type_has_no_supported_files');
  const raw = message.body?.content;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1_048_576) fail('invalid_message_file_content');
  let body: any;
  try { body = JSON.parse(raw); } catch { fail('invalid_message_file_content'); }
  const matches: any[] = [];
  if (message.msg_type !== 'post') { if (body?.file_key === fileKey) matches.push(body); }
  else {
    let nodes = 0;
    const walk = (node: any, depth: number) => {
      if (++nodes > 10000 || depth > 32) fail('message_file_inventory_too_large');
      if (!node || typeof node !== 'object') return;
      if (!Array.isArray(node) && node.tag === 'file') { if (node.file_key === fileKey) matches.push(node); return; }
      for (const child of Object.values(node)) walk(child, depth + 1);
    };
    walk(body, 0);
  }
  if (!matches.length) fail('file_key_not_in_message');
  const name = matches[0].file_name;
  return { messageType: message.msg_type, ...(typeof name === 'string' && name.length <= 1024 && !/[\x00-\x1f]/.test(name) ? { fileName: name } : {}) };
}

export function fileContent(account, input: FileReadInput, bytes, details: { fileName?: string; messageType?: string } = {}) {
  const { source = 'drive', fileToken, messageId, operation = 'info', offset = 0, limit = 65536 } = input;
  fileReadArgs(input);
  if (bytes.length > MAX_FILE_BYTES) fail('file_exceeds_32_mib_limit');
  if (offset > bytes.length) fail('offset_past_end');
  const utf8 = isUtf8(bytes) && !bytes.includes(0);
  const mimeType = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
    : bytes[0] === 0x1f && bytes[1] === 0x8b ? 'application/gzip'
    : bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) ? 'application/zip'
    : utf8 ? 'text/plain' : 'application/octet-stream';
  const metadata = { account, identity: 'user', source, fileToken, ...(source === 'message' ? { messageId, ...details } : {}), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType };
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
    content.push({ type: 'resource', resource: { uri: `lark-file://${account}/${source}/${source === 'message' ? `${messageId}/` : ''}${fileToken}`, mimeType, blob: bytes.toString('base64') } });
  }
  return { content };
}
export async function readFileContent(account, token, input: FileReadInput): Promise<CallToolResult> {
  const args = fileReadArgs(input);
  let details = {};
  if (input.source === 'message') {
    const lookup = await readApi(account, token, `/open-apis/im/v1/messages/${input.messageId}`);
    if (!lookup.ok || lookup.result?.ok !== true) return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      account, messageId: input.messageId, error: 'message_file_lookup_failed', upstream: lookup.result?.error }) }] };
    const items = lookup.result.data?.items;
    if (!Array.isArray(items) || items.length !== 1 || items[0].message_id !== input.messageId) fail('message_file_lookup_mismatch');
    details = messageFileDetails(items[0], input.fileToken);
  }
  const result = await invoke(args, token, { captureFile: true, timeout: 120000 });
  if (!result.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ account, identity: 'user', result: JSON.parse(result.output) }) }] };
  return fileContent(account, input, result.file, details);
}
