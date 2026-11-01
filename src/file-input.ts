import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { failure } from './mutations.ts';

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only native global-unicast IPv6. Exclude mapped/transition/documentation
  // ranges so private IPv4 cannot be smuggled through an IPv6 address.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address) && !/^3fff:/i.test(address);
}

export function fileUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid_file_download_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname.endsWith('.') ||
    url.hostname === 'localhost' || !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || value.length > 16384) throw failure('invalid_file_download_url');
  return url;
}

function safeLookup(host, options, callback) {
  lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(item => !publicAddress(item.address))) return callback(failure('file_host_not_public'));
    // These exact validated IPs are handed to the connection. There is no
    // second DNS lookup (and no forwarding of bridge/Feishu credentials).
    callback(null, options.all ? addresses : addresses[0].address, addresses[0].family);
  });
}

export async function downloadInput(value, { maxBytes = MAX_UPLOAD_BYTES, redirects = 3, signal = AbortSignal.timeout(60_000) } = {}) {
  const url = fileUrl(value);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false, lookup: safeLookup, signal,
      headers: { 'accept-encoding': 'identity', 'user-agent': 'larksmith-file-input' } }, resolve);
    req.on('error', () => reject(failure('file_download_failed_or_host_not_public')));
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.destroy();
    if (!redirects || !response.headers.location) throw failure('file_redirect_limit');
    return downloadInput(new URL(response.headers.location, url).href, { maxBytes, redirects: redirects - 1, signal });
  }
  if (response.statusCode !== 200) { response.destroy(); throw failure('file_download_failed_refresh_attachment_url'); }
  if (Number(response.headers['content-length'] || 0) > maxBytes) { response.destroy(); throw failure('upload_exceeds_32_mib_limit'); }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) { response.destroy(); throw failure('upload_exceeds_32_mib_limit'); }
    chunks.push(chunk);
  }
  if (!size) throw failure('empty_file_not_supported');
  return Buffer.concat(chunks);
}

export function decodeChunk(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('invalid_base64_chunk');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== value) throw failure('invalid_base64_chunk');
  return bytes;
}
