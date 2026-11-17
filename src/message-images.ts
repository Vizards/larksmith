import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { invoke, readApi, type UserToken } from './cli.ts';

const fail = (code: string, availableImages?: number): never => {
  throw Object.assign(new Error(code), { code, ...(availableImages === undefined ? {} : { availableImages }) });
};
export interface MessageImageInput { messageId: string; imageIndex?: number }

export function validateMessageImage({ messageId, imageIndex = 0 }: MessageImageInput) {
  if (!/^om_[A-Za-z0-9]{1,80}$/.test(messageId || '')) return fail('invalid_message_id');
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 99) return fail('invalid_image_index');
}

// Read only real image elements in the authoritative message body. Never
// interpret an image-looking string in user-written text as a resource.
export function messageImageKeys(message: any): string[] {
  if (message.deleted === true) return fail('message_recalled');
  if (!['image', 'post'].includes(message.msg_type)) return fail('message_type_has_no_supported_images');
  const raw = message.body?.content;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1_048_576) return fail('invalid_message_image_content');
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail('invalid_message_image_content'); }
  const keys = new Set<string>();
  const add = (key: unknown) => {
    if (typeof key !== 'string' || !/^img_[A-Za-z0-9_-]{1,252}$/.test(key)) return fail('invalid_message_image_key');
    keys.add(key);
    if (keys.size > 100) return fail('message_image_inventory_too_large');
  };
  if (message.msg_type === 'image') add(body?.image_key);
  else {
    let nodes = 0;
    const walk = (node: any, depth: number) => {
      if (++nodes > 10000 || depth > 32) return fail('message_image_inventory_too_large');
      if (!node || typeof node !== 'object') return;
      if (!Array.isArray(node) && node.tag === 'img') { add(node.image_key); return; }
      for (const child of Object.values(node)) walk(child, depth + 1);
    };
    walk(body, 0);
  }
  return [...keys];
}

export async function readMessageImage(account: string, token: UserToken, input: MessageImageInput): Promise<CallToolResult> {
  validateMessageImage(input);
  const { messageId, imageIndex = 0 } = input;
  const lookup = await readApi(account, token, `/open-apis/im/v1/messages/${messageId}`);
  if (!lookup.ok || lookup.result?.ok !== true) return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    account, messageId, error: 'message_image_lookup_failed', upstream: lookup.result?.error }) }] };
  const items = lookup.result.data?.items;
  if (!Array.isArray(items) || items.length !== 1 || items[0].message_id !== messageId) return fail('message_image_lookup_mismatch');
  const keys = messageImageKeys(items[0]);
  if (!keys.length) return fail('message_has_no_images', 0);
  if (imageIndex >= keys.length) return fail('image_index_out_of_range', keys.length);
  const imageKey = keys[imageIndex];
  // Upstream labels this command 'write' because it writes a local file. It
  // performs a remote resource GET only. The path/type/identity are fixed here.
  const result = await invoke(['im', '+messages-resources-download', `--message-id=${messageId}`, `--file-key=${imageKey}`,
    '--type=image', '--output=./media', '--as=user', '--json'], token, { captureImage: true, timeout: 60000 });
  let output: any;
  try { output = JSON.parse(result.output); } catch { return fail('message_image_invalid_cli_output'); }
  if (!result.ok || output.ok === false) return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    account, messageId, imageIndex, availableImages: keys.length, error: 'message_image_download_failed', upstream: output.error }) }] };
  if (!result.image) return fail('image_output_missing');
  const bytes = Buffer.from(result.image.data, 'base64');
  return { content: [{ type: 'text', text: JSON.stringify({ account, identity: 'user', messageId, messageType: items[0].msg_type,
    imageIndex, availableImages: keys.length, imageKey, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: result.image.mimeType, source: 'official-cli-message-resource', animatedFramesVerified: false }) }, result.image] };
}
