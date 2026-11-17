import { constants, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { MessageLinkError } from './message-links.ts';

// Public protocol key shipped by Feishu's web-framework, not a service secret.
const APP_LINK_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDTb2DxxIj17sf2H/hr6ZSNxsaaFjgCMHZOSZsvAaZpl+9hHd76ex1nVCpZXbjIsYHfJzYLVDlRZYXcHA3yOhneyJbCkO4e05t+5j/lXWQY09gkp9w3pGIWOCzfr8zY/5CA3ThIbNBKFQZTnX8nQIhaTf+unJDe6Nkq3Tau6cz75QIDAQAB
-----END PUBLIC KEY-----`;
const REVERSE_URL = 'https://open.feishu.cn/open-apis/mina/applink/getchatid-byopenchatid';
const fail = (code: string): never => { throw new MessageLinkError(code); };
const openChat = (value: unknown): value is string => typeof value === 'string' && /^oc_[a-zA-Z0-9]{1,80}$/.test(value);
const messageId = (value: unknown): value is string => typeof value === 'string' && /^om_[a-zA-Z0-9]{1,80}$/.test(value);
const threadId = (value: unknown): value is string => typeof value === 'string' && /^omt_[a-zA-Z0-9]{1,80}$/.test(value);

export type OfficialReader = (command: string[], parameters: Record<string, string | number | boolean>, timeout: number) => Promise<any>;
export interface ConversationOptions {
  official: OfficialReader;
  reverse?: (openChatId: string) => Promise<string>;
  deadline: number;
}
export interface ConversationTarget { openChatId?: string; chatId?: string; chatName?: string; position: number; createTimeSeconds?: string }

export function parseChatPositionLink(input: string) {
  if (input.length > 2048) return fail('invalid_message_link');
  let url: URL;
  try { url = new URL(input); } catch { return fail('invalid_message_link'); }
  const allowed = new Set(['openChatId', 'position', 'messageid', 'threadid']);
  if (url.origin !== 'https://applink.feishu.cn' || url.username || url.password || url.hash || url.pathname !== '/client/chat/open' ||
    [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) return fail('invalid_message_link');
  const openChatId = url.searchParams.get('openChatId'), position = url.searchParams.get('position');
  if (!openChat(openChatId) || !position || !/^\d{1,10}$/.test(position) || Number(position) > 2147483647) return fail('message_link_requires_nonnegative_position');
  // Numeric IDs are accepted as hints only; they are never cast to om_/omt_.
  for (const key of ['messageid', 'threadid']) if (url.searchParams.has(key) && !/^\d{1,20}$/.test(url.searchParams.get(key)!)) return fail('invalid_message_link');
  return { openChatId, position: Number(position) };
}

export async function reverseChatId(openChatId: string, cookie: string, signal: AbortSignal, fetcher = fetch): Promise<string> {
  if (!openChat(openChatId)) return fail('message_link_invalid_candidate');
  const session = /^session=([^;\s]+)$/.exec(cookie)?.[1];
  if (!session) return fail('invalid_web_session_configuration');
  const key = randomBytes(8).toString('hex'), iv = randomBytes(8).toString('hex');
  const ttcode = publicEncrypt({ key: APP_LINK_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${key}#${iv}`)).toString('base64');
  let response: Response;
  try {
    response = await fetcher(REVERSE_URL, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Session: session, Locale: 'zh_cn' },
      body: JSON.stringify({ open_chat_id: openChatId, ttcode }) });
  } catch { return fail(signal.aborted ? 'message_link_timeout' : 'message_link_reverse_unavailable'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return fail(response.status === 401 ? 'web_session_expired' : response.status === 429 ? 'message_link_rate_limited' : 'message_link_reverse_rejected');
  }
  const reader = response.body?.getReader();
  if (!reader) return fail('message_link_protocol_changed');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) return fail('message_link_response_too_large'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.code !== 0 || typeof data.data?.encrypted_data !== 'string') return fail('message_link_reverse_rejected');
    const cipher = data.data.encrypted_data;
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(cipher)) return fail('message_link_protocol_changed');
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
    const plain = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()]).toString('utf8');
    // Extract only this exact key, before JSON.parse can round a 64-bit ID.
    const pattern = new RegExp(`^\\s*\\{\\s*"${openChatId}"\\s*:\\s*(?:"(\\d{1,20})"|(\\d{1,20}))\\s*\\}\\s*$`);
    const match = pattern.exec(plain);
    return match?.[1] ?? match?.[2] ?? fail('message_link_protocol_changed');
  } catch (error) { if (error instanceof MessageLinkError) throw error; return fail('message_link_protocol_changed'); }
}

function nextPage(data: any, seen: Set<string>): string | undefined {
  if (typeof data.has_more !== 'boolean') return fail('message_link_invalid_pagination');
  if (!data.has_more) return undefined;
  const cursor = data.page_token;
  if (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || seen.has(cursor)) return fail('message_link_invalid_pagination');
  seen.add(cursor); return cursor;
}

export async function readConversation(target: ConversationTarget, options: ConversationOptions, replyPageToken?: string) {
  if (!Number.isInteger(target.position) || target.position < 0) return fail('message_link_requires_nonnegative_position');
  if (replyPageToken !== undefined && (!replyPageToken || replyPageToken.length > 8192)) return fail('message_link_invalid_pagination');
  const remaining = () => { const ms = options.deadline - Date.now(); return ms > 0 ? Math.min(ms, 20000) : fail('message_link_timeout'); };
  const read = async (command: string[], parameters: Record<string, string | number | boolean>) => {
    const result = await options.official(command, parameters, remaining());
    if (result?.ok !== true || !result.data || typeof result.data !== 'object') return fail('message_link_official_read_failed');
    return result.data;
  };
  let openChatId = target.openChatId, candidatesChecked = 0;
  if (!openChatId) {
    if (!target.chatId || !target.chatName || !options.reverse) return fail('message_link_mapping_unavailable');
    const candidates = new Set<string>(), seen = new Set<string>(); let cursor: string | undefined;
    // Names discover candidates only. Never use first/similar name as proof.
    search: for (let page = 0; page < 3; page++) {
      const data = await read(['im', '+chat-search'], { query: target.chatName, 'disable-search-by-user': true, 'page-size': 20, ...(cursor ? { 'page-token': cursor } : {}) });
      if (!Array.isArray(data.chats)) return fail('message_link_protocol_changed');
      for (const chat of data.chats) {
        const id = chat.chat_id;
        if (!openChat(id) || candidates.has(id)) continue;
        if (candidatesChecked >= 10) return fail('message_link_candidate_limit');
        candidates.add(id); candidatesChecked++; remaining();
        if (await options.reverse(id) === target.chatId) { openChatId = id; break search; }
      }
      cursor = nextPage(data, seen); if (!cursor) break;
    }
    if (!openChatId) return fail('message_link_exact_chat_not_found');
  }
  if (!openChat(openChatId)) return fail('message_link_invalid_candidate');
  const seenRootPages = new Set<string>(); let root: any, rootCursor: string | undefined;
  const time = target.createTimeSeconds && /^\d{1,12}$/.test(target.createTimeSeconds) ? Number(target.createTimeSeconds) * 1000 : undefined;
  const timeRange: Record<string, string> = time ? { start: new Date(time - 300000).toISOString(), end: new Date(time + 300000).toISOString() } : {};
  for (let page = 0; page < 4; page++) {
    const data = await read(['im', '+chat-messages-list'], { 'chat-id': openChatId, 'page-size': '50', order: 'desc', 'no-reactions': true,
      ...timeRange, ...(rootCursor ? { 'page-token': rootCursor } : {}) });
    if (!Array.isArray(data.messages)) return fail('message_link_protocol_changed');
    const matches = data.messages.filter(m => m.chat_id === openChatId && String(m.message_position) === String(target.position));
    if (matches.length > 1) return fail('message_link_ambiguous_position');
    if (matches.length === 1) { root = matches[0]; break; }
    rootCursor = nextPage(data, seenRootPages); if (!rootCursor) break;
  }
  if (!root || !messageId(root.message_id)) return fail('message_link_position_not_found_in_window');
  // Return only the located root and requested thread. Auto-enriched replies
  // from chat history are deliberately discarded; fetch explicit thread pages.
  const project = async (m: any) => {
    if (!messageId(m.message_id) || m.chat_id !== openChatId) return fail('message_link_message_mismatch');
    let deleted = m.deleted === true, content = m.content, contentStatus = 'cli_projection';
    if (content === '[Invalid rich text JSON]') {
      const data = await read(['api', 'GET', `/open-apis/im/v1/messages/${m.message_id}`], {});
      const raw = data.items?.find(item => item.message_id === m.message_id && item.chat_id === openChatId);
      if (!raw) return fail('message_link_message_mismatch');
      deleted = raw.deleted === true; contentStatus = deleted ? 'recalled' : 'unavailable'; content = undefined;
    }
    if (deleted) { content = undefined; contentStatus = 'recalled'; }
    return { messageId: m.message_id, chatId: openChatId, threadId: m.thread_id, position: m.message_position,
      threadPosition: m.thread_message_position, type: m.msg_type, createTime: m.create_time, createTimeZone: 'UTC',
      sender: m.sender ? { id: m.sender.id, name: m.sender.name } : undefined, deleted, contentStatus, content,
      resources: deleted ? undefined : m.resources, messageAppLink: m.message_app_link };
  };
  const rootResult = await project(root), replies: any[] = [], replyIds = new Set<string>();
  const seenReplies = new Set<string>(replyPageToken ? [replyPageToken] : []); let cursor = replyPageToken, pages = 0;
  if (root.thread_id) {
    if (!threadId(root.thread_id)) return fail('message_link_protocol_changed');
    for (; pages < 2;) {
      const data = await read(['im', '+threads-messages-list'], { thread: root.thread_id, 'page-size': '50', order: 'asc', 'no-reactions': true,
        ...(cursor ? { 'page-token': cursor } : {}) });
      pages++;
      if (data.thread_id !== root.thread_id || !Array.isArray(data.messages) || data.messages.length > 50) return fail('message_link_protocol_changed');
      for (const m of data.messages) {
        if (m.thread_id !== root.thread_id) return fail('message_link_message_mismatch');
        if (replyIds.has(m.message_id)) return fail('message_link_invalid_pagination');
        replyIds.add(m.message_id); replies.push(await project(m));
      }
      cursor = nextPage(data, seenReplies); if (!cursor) break;
    }
  } else if (replyPageToken) return fail('message_link_invalid_pagination');
  const result = { location: { openChatId, position: target.position, messageId: root.message_id, threadId: root.thread_id,
    appLink: `https://applink.feishu.cn/client/chat/open?openChatId=${openChatId}&position=${target.position}` },
    mapping: { method: target.openChatId ? 'explicit_open_chat_id' : 'exact_reverse_id', candidatesChecked }, root: rootResult, replies,
    pagination: { pages, returnedReplies: replies.length, hasMore: Boolean(cursor), nextReplyPageToken: cursor,
      complete: !cursor && !replyPageToken, startedFromCursor: Boolean(replyPageToken) },
    snapshotOnly: false, fullConversation: false, attachmentsDownloaded: false, projection: 'official-cli-text-and-resource-references' };
  if (JSON.stringify(result).length > 100000) return fail('message_link_response_too_large');
  return result;
}
