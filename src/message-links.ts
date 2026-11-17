// Experimental Feishu web RPCs. These are not OpenAPI/CLI endpoints.
// Keep the projection explicit: never return raw packets, cookies, media keys,
// or unrelated conversation history with a copied-message snapshot.
const GATEWAY = 'https://internal-api-lark-api.feishu.cn/im/gateway/';
const MAX_BYTES = 1_048_576;
const MAX_MESSAGES = 100;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
type Field = bigint | Uint8Array;
type Fields = Map<number, Field[]>;

export class MessageLinkError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const fail = (code = 'message_link_protocol_changed'): never => { throw new MessageLinkError(code); };

export function parseMessageLink(input: string) {
  if (input.length > 2048) return fail('invalid_message_link');
  let url: URL;
  try { url = new URL(input); } catch { return fail('invalid_message_link'); }
  if (url.protocol !== 'https:' || url.hostname !== 'applink.feishu.cn' || url.port || url.username || url.password ||
    url.pathname !== '/client/message/link/open' || url.hash || url.searchParams.getAll('token').length !== 1 ||
    [...url.searchParams.keys()].some(key => key !== 'token')) return fail('invalid_message_link');
  // URLSearchParams already decodes once. Never interpret token bytes as IDs.
  const token = url.searchParams.get('token')!;
  if (!/^[A-Za-z0-9+/=_-]{1,1024}$/.test(token)) return fail('invalid_message_link');
  const canonical = new URL('https://applink.feishu.cn/client/message/link/open');
  canonical.searchParams.set('token', token);
  return { token, url: canonical.href };
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  do { const part = value & 127; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return bytes;
}
function stringField(field: number, value: string) {
  const bytes = encoder.encode(value);
  return [field * 8 + 2, ...varint(bytes.length), ...bytes];
}
function packet(command: 1151 | 1152, link: ReturnType<typeof parseMessageLink>) {
  const payload = command === 1151 ? stringField(1, link.token) : [...stringField(1, link.url), ...stringField(2, link.token)];
  return new Uint8Array([16, 1, 24, ...varint(command), 42, ...varint(payload.length), ...payload]);
}

// A bounded wire reader for the small, observed field subset. Unknown fields
// are skipped/projected out; 64-bit IDs remain strings, never JS numbers.
function fields(bytes: Uint8Array): Fields {
  if (bytes.length > MAX_BYTES) return fail('message_link_response_too_large');
  let offset = 0;
  const output: Fields = new Map();
  const readVarint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) return fail();
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) return fail();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    return fail();
  };
  let count = 0;
  while (offset < bytes.length) {
    if (++count > 20_000) return fail('message_link_response_too_large');
    const tag = readVarint();
    if (tag > 0xffff_ffffn || tag < 8n) return fail();
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    let value: Field;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(bytes.length - offset)) return fail();
      value = bytes.subarray(offset, offset + Number(length)); offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) return fail();
      continue;
    } else return fail();
    const entries = output.get(field) ?? [];
    entries.push(value); output.set(field, entries);
  }
  return output;
}
function one(value: Fields, field: number) {
  const entries = value.get(field);
  if (entries && entries.length !== 1) return fail();
  return entries?.[0];
}
function bytes(value: Fields, field: number): Uint8Array | undefined {
  const entry = one(value, field);
  if (entry === undefined) return undefined;
  if (!(entry instanceof Uint8Array)) return fail();
  return entry;
}
function number(value: Fields, field: number): bigint | undefined {
  const entry = one(value, field);
  if (entry === undefined) return undefined;
  if (typeof entry !== 'bigint') return fail();
  return entry;
}
function text(value: Fields, field: number, limit = 25_000): string | undefined {
  const entry = bytes(value, field);
  if (!entry) return undefined;
  if (entry.length > limit * 4) return fail('message_link_response_too_large');
  try { const result = decoder.decode(entry); return result.length <= limit ? result : fail('message_link_response_too_large'); }
  catch { return fail(); }
}
const nested = (value: Fields, field: number) => fields(bytes(value, field) ?? new Uint8Array());
function repeatedBytes(value: Fields, field: number) {
  return (value.get(field) ?? []).map(entry => entry instanceof Uint8Array ? entry : fail());
}
function internalId(value: string | undefined) {
  if (value !== undefined && !/^\d{1,20}$/.test(value)) return fail();
  return value;
}
function richTextContent(rich: Fields) {
  const inner = text(rich, 2);
  if (inner) return { text: inner, omittedElementTypes: [] as number[] };
  const elements = new Map<string, Fields>();
  for (const raw of repeatedBytes(nested(rich, 3), 1)) {
    const entry = fields(raw), id = text(entry, 1, 256);
    if (!id || elements.has(id)) return fail();
    elements.set(id, nested(entry, 2));
  }
  const omitted = new Set<number>();
  let visited = 0, chars = 0;
  const walk = (raw: Uint8Array, path: Set<string>): string => {
    const id = decoder.decode(raw), element = elements.get(id);
    if (!element || path.has(id) || path.size >= 64 || ++visited > 10_000) return fail();
    const tag = Number(number(element, 1) ?? 0n);
    let output = '';
    // Never parse image/media properties: they contain resource credentials.
    if ([1, 7, 8, 9].includes(tag)) output = text(nested(element, 3), 1) ?? '';
    else if ([5, 6, 36].includes(tag)) output = text(nested(element, 3), 2) ?? '';
    else if (![2, 3, 4, 14, 18, 23, 24, 25, 26, 27, 28, 29, 32, 39, 40, 41, 42, 43, 44, 45, 46].includes(tag)) omitted.add(tag);
    chars += output.length;
    if (chars > 25_000) return fail('message_link_response_too_large');
    const next = new Set(path); next.add(id);
    output += repeatedBytes(element, 4).map(child => walk(child, next)).join('');
    if ([3, 14, 23, 24, 25, 28, 29, 31, 32, 40, 44, 45, 46].includes(tag)) output += '\n';
    return output;
  };
  const result = repeatedBytes(rich, 1).map(raw => walk(raw, new Set())).join('').trim();
  if (result.length > 25_000) return fail('message_link_response_too_large');
  return { text: result || undefined, omittedElementTypes: [...omitted] };
}
function permission(payload: Uint8Array) {
  const response = fields(payload);
  if (number(response, 1) !== 1n) return fail('message_link_access_denied');
  const target = text(response, 2, 2048);
  let url: URL;
  try { url = new URL(target!); } catch { return fail(); }
  if (url.origin !== 'https://applink.feishu.cn' || url.pathname !== '/client/chat/open' || url.username || url.password || url.hash ||
    url.searchParams.getAll('chatId').length !== 1 || url.searchParams.getAll('position').length !== 1) return fail();
  const chatId = internalId(url.searchParams.get('chatId') ?? undefined);
  const position = url.searchParams.get('position');
  // Reply links use negative sentinel positions (observed: -3).
  if (!chatId || !position || !/^-?\d{1,10}$/.test(position) ||
    Number(position) < -2147483648 || Number(position) > 2147483647) return fail();
  const safe = new URL('https://applink.feishu.cn/client/chat/open');
  safe.searchParams.set('chatId', chatId); safe.searchParams.set('position', position);
  return { chatId, position: Number(position), appLink: safe.href, idFormat: 'internal' as const };
}
function snapshot(payload: Uint8Array, expectedChatId: string) {
  const response = fields(payload), link = nested(response, 1);
  if (!bytes(response, 1) || !bytes(link, 16)) return fail();
  const chat = nested(link, 16), meta = nested(link, 15);
  if (number(chat, 2) !== 1n) return fail('message_link_access_denied');
  if (number(meta, 2)?.toString() !== expectedChatId) return fail('message_link_chat_mismatch');
  const ids = (link.get(2) ?? []).map(id => typeof id === 'bigint' ? internalId(id.toString())! : fail());
  if (!ids.length || ids.length > MAX_MESSAGES || new Set(ids).size !== ids.length) return fail('message_link_response_too_large');
  const names = new Map<string, string>();
  for (const raw of repeatedBytes(link, 4)) {
    const entry = fields(raw), person = nested(entry, 2);
    const id = number(entry, 1)?.toString(), name = text(person, 2, 256);
    if (id && name && number(person, 5) !== 1n) names.set(id, name);
  }
  const entities = new Map<string, Fields>();
  for (const raw of repeatedBytes(link, 3)) {
    const entry = fields(raw), id = number(entry, 1)?.toString();
    if (id) { if (entities.has(id) || entities.size >= MAX_MESSAGES) return fail('message_link_response_too_large'); entities.set(id, nested(entry, 2)); }
  }
  // Only expand replies explicitly linked by a selected snapshot entity.
  // Some copy modes omit them even when replyCount is nonzero. Never infer
  // completeness from the number of arbitrary entities in the response.
  const threads: { rootId: string; expectedReplies: number; includedReplyIds: string[]; completeInSnapshot: boolean }[] = [];
  const selected = new Set(ids);
  for (const id of ids) {
    const entity = entities.get(id);
    if (!entity || !bytes(entity, 4)) continue;
    const thread = nested(entity, 4);
    if (number(thread, 1)?.toString() !== id) return fail();
    const count = number(thread, 2) ?? 0n;
    if (count < 0n || count > 2147483647n) return fail();
    const replies = (thread.get(5) ?? []).map(value => typeof value === 'bigint' ? internalId(value.toString())! : fail());
    if (replies.length > MAX_MESSAGES || new Set(replies).size !== replies.length || replies.includes(id)) return fail();
    for (const reply of replies) selected.add(reply);
    if (selected.size > MAX_MESSAGES) return fail('message_link_response_too_large');
    threads.push({ rootId: id, expectedReplies: Number(count), includedReplyIds: replies,
      completeInSnapshot: replies.length === Number(count) && replies.every(reply => bytes(entities.get(reply) ?? new Map(), 1)) });
  }
  let totalChars = 0;
  const messages = [...selected].map(id => {
    const entity = entities.get(id);
    if (!entity || !bytes(entity, 1)) return { messageId: id, contentStatus: 'unavailable' };
    const message = nested(entity, 1), type = Number(number(message, 2) ?? 0n);
    if (text(message, 1, 20) !== id) return fail();
    const state = nested(message, 57);
    const withheld = number(message, 23) === 1n || number(message, 41) === 1n || number(message, 6) === 2n ||
      number(message, 44) === 0n || number(message, 63) === 1n || (number(state, 1) ?? 0n) !== 0n ||
      [2, 4, 6, 7].some(field => number(state, field) === 1n) || number(state, 3) === 3n ||
      number(nested(message, 73), 2) === 1n;
    const senderId = internalId(text(message, 3, 20));
    const result = { messageId: id, selection: ids.includes(id) ? 'selected' : 'thread_reply', type, senderId, senderName: senderId ? names.get(senderId) : undefined,
      createTimeSeconds: number(message, 4)?.toString(), position: number(message, 13)?.toString(),
      threadId: internalId(text(message, 20, 20)), contentStatus: withheld ? 'withheld' : 'unsupported_type' };
    if (withheld || ![2, 4].includes(type)) return result;
    const content = nested(message, 5), rich = nested(content, type === 2 ? 6 : 3);
    // POST.text is HTML. RichText.innerText avoids copying HTML/resource URLs.
    const projected = richTextContent(rich);
    const plain = projected.text ?? (type === 4 ? text(content, 1) : undefined);
    const title = type === 2 ? text(content, 1, 4096) : undefined;
    totalChars += (plain?.length ?? 0) + (title?.length ?? 0);
    if (totalChars > 100_000) return fail('message_link_response_too_large');
    return { ...result, contentStatus: plain === undefined ? 'unavailable' : 'text_projection', title, text: plain,
      omittedElementTypes: projected.omittedElementTypes,
      imageCount: (rich.get(5) ?? []).length, mediaCount: (rich.get(9) ?? []).length,
      truncatedUpstream: number(message, 22) === 1n };
  });
  return { chatName: text(chat, 1, 512), selectedMessageIds: ids, threads, messages, returnedMessages: messages.length,
    snapshotOnly: true, fullConversation: false, attachmentsDownloaded: false, projection: 'text-and-metadata' };
}

export interface MessageLinkSession { cookie: string }
export interface MessageLinkOptions {
  session: (account: string) => Promise<MessageLinkSession | undefined>;
  rejected?: (account: string, session: MessageLinkSession) => Promise<void>;
  fetcher?: typeof fetch;
}

export class MessageLinks {
  private options: MessageLinkOptions;
  constructor(options: MessageLinkOptions) { this.options = options; }
  async read(account: string, input: string, operation: 'resolve' | 'snapshot' = 'snapshot') {
    if (!['resolve', 'snapshot'].includes(operation)) return fail('invalid_message_link_operation');
    const link = parseMessageLink(input);
    const session = await this.options.session(account);
    if (!session?.cookie) return fail('web_session_required');
    if (!/^[\x20-\x7e]{1,16384}$/.test(session.cookie)) return fail('invalid_web_session_configuration');
    // One deadline covers both requests; no automatic retry or OAuth fallback.
    const signal = AbortSignal.timeout(15_000);
    const request = async (command: 1151 | 1152) => {
      try {
        const response = await (this.options.fetcher ?? fetch)(GATEWAY, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/x-protobuf', 'x-command': String(command), 'x-Source': 'web', 'X-AppID': '0', Cookie: session.cookie },
          body: packet(command, link) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 401) {
            await this.options.rejected?.(account, session);
            return fail('web_session_expired');
          }
          if (response.status === 403) return fail('web_session_or_permission_rejected');
          if (response.status === 429) return fail('message_link_rate_limited');
          return fail('message_link_upstream_unavailable');
        }
        if (!response.body) return fail();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) { const { value, done } = await reader.read(); if (done) break;
            length += value.length; if (length > MAX_BYTES) return fail('message_link_response_too_large'); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); }
        const data = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        const envelope = fields(data), status = number(envelope, 4) ?? 0n;
        if (status !== 0n) return fail('message_link_upstream_rejected');
        // The gateway uses command 1 for synchronous responses, rather than
        // echoing the request command. The response schema is request-bound.
        if (number(envelope, 3) !== 1n || number(envelope, 2) !== 1n) return fail();
        return bytes(envelope, 5) ?? fail();
      } catch (error) {
        if (error instanceof MessageLinkError) throw error;
        return fail(signal.aborted ? 'message_link_timeout' : 'message_link_request_failed');
      }
    };
    const location = permission(await request(1151));
    return { account, experimental: true, source: 'feishu-web-private', identity: 'separately-configured-web-session',
      operation, location, ...(operation === 'snapshot' ? snapshot(await request(1152), location.chatId) : {}) };
  }
}
