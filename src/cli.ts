import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CallToolResult, ImageContent } from '@modelcontextprotocol/server';

export interface UserToken { appId: string; accessToken: string; openId?: string; [key: string]: unknown }
export interface InvokeOptions { captureImage?: boolean; captureFile?: boolean; prepare?: (scratch: string) => Promise<unknown>; timeout?: number }
export interface CliResult { ok: boolean; output: string; image?: ImageContent; file?: Buffer }

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/lark-cli', import.meta.url));
const roots = new Set(['sheets', 'drive', 'docx', 'wiki', 'bitable', 'base', 'contact', 'im', 'calendar', 'task', 'mail', 'vc', 'minutes', 'okr', 'attendance', 'approval', 'search', 'slides', 'board']);

export function validateReadPath(path) {
  if (!/^\/open-apis\/[A-Za-z0-9/_:.-]+$/.test(path) || path.split('/').includes('..') || !roots.has(path.split('/')[2])) throw new Error('unsupported_read_path');
  return path;
}

export function userEnvironment(scratch: string, token?: UserToken) {
  return {
    PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, XDG_CONFIG_HOME: join(scratch, 'config'), LARKSUITE_CLI_CONFIG_DIR: join(scratch, 'config'), LANG: 'C.UTF-8',
    LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_STRICT_MODE: 'user', LARKSUITE_CLI_DEFAULT_AS: 'user',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    ...(token ? { LARKSUITE_CLI_APP_ID: token.appId, LARKSUITE_CLI_USER_ACCESS_TOKEN: token.accessToken } : {}),
  };
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const cliError = code => Object.assign(new Error(code), { code });

export async function invoke(args: string[], token?: UserToken, { captureImage = false, captureFile = false, prepare, timeout = 25000 }: InvokeOptions = {}): Promise<CliResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'lark-bridge-call-'));
  const controller = new AbortController();
  let monitor;
  let tooLarge = false;
  try {
    await mkdir(join(scratch, 'config'));
    if (prepare) await prepare(scratch);
    const fileLimit = captureImage ? MAX_IMAGE_BYTES : 32 * 1024 * 1024;
    const outputName = name => captureImage ? /^media(?:\.[A-Za-z0-9]+)?$/.test(name) : name === 'attachment.bin';
    if (captureImage || captureFile) monitor = setInterval(async () => {
      try {
        for (const name of await readdir(scratch)) if (outputName(name) && (await lstat(join(scratch, name))).size > fileLimit) {
          tooLarge = true; controller.abort();
        }
      } catch { /* The invocation may have finished and removed its directory. */ }
    }, 100);
    const options = { cwd: scratch, env: userEnvironment(scratch, token), signal: controller.signal, timeout, maxBuffer: 1048576, killSignal: 'SIGKILL' as const };
    let result;
    let ok = true;
    try { result = await execute(binary, args, options); }
    catch (error) {
      if (tooLarge) throw cliError(captureImage ? 'image_exceeds_2_mib_limit' : 'file_exceeds_32_mib_limit');
      if (typeof error.code !== 'number') throw cliError(error.killed ? 'cli_timeout' : 'cli_execution_failed');
      result = error;
      ok = false;
    }
    let output = cliOutput(result, ok);
    if (token?.accessToken) output = output.replaceAll(token.accessToken, '[REDACTED]');
    let image: ImageContent | undefined;
    let file;
    if (ok && captureImage) {
      const names = (await readdir(scratch)).filter(name => /^media(?:\.[A-Za-z0-9]+)?$/.test(name));
      if (names.length !== 1) throw cliError('image_output_missing');
      const path = join(scratch, names[0]);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw cliError('invalid_image_output');
      if (info.size > MAX_IMAGE_BYTES) throw cliError('image_exceeds_2_mib_limit');
      const bytes = await readFile(path);
      image = { type: 'image', mimeType: imageMimeType(bytes), data: bytes.toString('base64') };
    }
    if (ok && captureFile) {
      const path = join(scratch, 'attachment.bin');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw cliError('invalid_file_output');
      if (info.size > fileLimit) throw cliError('file_exceeds_32_mib_limit');
      file = await readFile(path);
    }
    return { ok, output, image, file };
  } finally { clearInterval(monitor); await rm(scratch, { recursive: true, force: true }); }
}

export function cliOutput(result, ok) {
  if (ok) return result.stdout;
  // Official CLI failures are JSON on stderr; never discard the permission
  // error or mix human diagnostics into a successful data envelope.
  for (const candidate of [result.stderr, result.stdout]) {
    try { const value = JSON.parse(candidate); if (value.ok === false && value.error) return JSON.stringify(value); } catch { /* Do not forward unstructured stderr. */ }
  }
  throw cliError('cli_execution_failed');
}

export function imageMimeType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw cliError('unsupported_image_type');
}

export async function readApi(account, token, path, params = {}) {
  validateReadPath(path);
  const { ok, output } = await invoke(['api', 'GET', path, '--params', JSON.stringify(params), '--as', 'user', '--json'], token);
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('invalid_cli_json'); }
  return { ok, account, identity: 'user', appId: token.appId, openId: token.openId, result };
}

function spreadsheetToken(url) {
  const source = new URL(url);
  const match = /^\/sheets\/([A-Za-z0-9]+)\/?$/.exec(source.pathname);
  if (source.protocol !== 'https:' || !(source.hostname === 'feishu.cn' || source.hostname.endsWith('.feishu.cn')) || source.port || source.username || source.password || !match) throw new Error('invalid_sheet_url');
  return match[1];
}

export function sheetReadArgs({ url, operation = 'workbook', sheetId, sheetName, range, include, maxChars = 25000 }: { url: string; operation?: string; sheetId?: string; sheetName?: string; range?: string; include?: string[]; maxChars?: number }) {
  const token = spreadsheetToken(url);
  if (!['workbook', 'csv', 'cells'].includes(operation)) throw new Error('unsupported_sheet_operation');
  const args = ['sheets', ({ workbook: '+workbook-info', csv: '+csv-get', cells: '+cells-get' } as Record<string, string>)[operation], `--spreadsheet-token=${token}`];
  if (operation !== 'workbook') {
    if (Boolean(sheetId) === Boolean(sheetName)) throw new Error('select_one_sheet');
    if (sheetId && !/^[A-Za-z0-9_-]{1,128}$/.test(sheetId)) throw new Error('invalid_sheet_id');
    if (sheetName && (sheetName.length > 256 || /[\x00-\x1f]/.test(sheetName))) throw new Error('invalid_sheet_name');
    if (!/^[A-Za-z]{1,4}[1-9][0-9]{0,6}(?::[A-Za-z]{1,4}[1-9][0-9]{0,6})?$/.test(range || '')) throw new Error('explicit_a1_range_required');
    if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100000) throw new Error('invalid_output_limit');
    args.push(sheetId ? `--sheet-id=${sheetId}` : `--sheet-name=${sheetName}`, `--range=${range}`, `--max-chars=${maxChars}`);
    if (include?.length) {
      if (operation !== 'cells' || include.some(value => !['value', 'formula', 'style', 'comment', 'data_validation', 'conditional_format', 'truncation'].includes(value))) throw new Error('invalid_cell_include');
      args.push(`--include=${include.join(',')}`);
    }
  }
  return [...args, '--as=user', '--json'];
}

export async function readSheet(account, token, input) {
  const { ok, output } = await invoke(sheetReadArgs(input), token);
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('invalid_cli_json'); }
  return { ok: ok && result.ok !== false, account, identity: 'user', appId: token.appId, openId: token.openId, result };
}

export function sheetCreateArgs({ title, folderToken }) {
  if (typeof title !== 'string' || !title.trim() || title.length > 256 || /[\x00-\x1f]/.test(title)) throw cliError('invalid_workbook_title');
  if (folderToken !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(folderToken)) throw cliError('invalid_folder_token');
  return ['sheets', '+workbook-create', `--title=${title}`, ...(folderToken ? [`--folder-token=${folderToken}`] : []), '--as=user', '--json'];
}

export function sheetWriteArgs({ url, sheetId, range, cells, allowOverwrite = false }) {
  const token = spreadsheetToken(url);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sheetId || '')) throw cliError('invalid_sheet_id');
  const match = /^([A-Za-z]{1,4})([1-9][0-9]{0,6})(?::([A-Za-z]{1,4})([1-9][0-9]{0,6}))?$/.exec(range || '');
  if (!match) throw cliError('explicit_a1_range_required');
  const column = label => [...label.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const rows = Number(match[4] || match[2]) - Number(match[2]) + 1;
  const columns = column(match[3] || match[1]) - column(match[1]) + 1;
  if (rows < 1 || columns < 1 || rows * columns > 1000 || !Array.isArray(cells) || cells.length !== rows || cells.some(row => !Array.isArray(row) || row.length !== columns)) throw cliError('cells_must_match_bounded_range');
  for (const cell of cells.flat()) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || Object.keys(cell).some(key => !['value', 'formula'].includes(key)) || !Object.keys(cell).length) throw cliError('unsupported_cell_fields');
    if ('value' in cell && cell.value !== null && !['string', 'number', 'boolean'].includes(typeof cell.value)) throw cliError('invalid_cell_value');
    if (typeof cell.value === 'number' && !Number.isFinite(cell.value)) throw cliError('invalid_cell_value');
    if ('formula' in cell && (typeof cell.formula !== 'string' || !cell.formula.startsWith('=') || 'value' in cell)) throw cliError('invalid_cell_formula');
  }
  const encoded = JSON.stringify(cells);
  if (Buffer.byteLength(encoded) > 65536 || typeof allowOverwrite !== 'boolean') throw cliError('invalid_write_size_or_options');
  return ['sheets', '+cells-set', `--spreadsheet-token=${token}`, `--sheet-id=${sheetId}`, `--range=${range}`, `--cells=${encoded}`, `--allow-overwrite=${allowOverwrite}`, '--as=user', '--json'];
}

export async function writeSheet(account, token, args) {
  const { ok, output } = await invoke(args, token);
  let result;
  try { result = JSON.parse(output); } catch { throw cliError('invalid_cli_json'); }
  return { ok: ok && result.ok !== false, account, identity: 'user', appId: token.appId, openId: token.openId, result };
}

export function docReadArgs({ url, scope = 'outline', detail = 'with-ids', startBlockId, endBlockId, keyword }: { url: string; scope?: string; detail?: string; startBlockId?: string; endBlockId?: string; keyword?: string }) {
  const source = new URL(url);
  if (source.protocol !== 'https:' || !(source.hostname === 'feishu.cn' || source.hostname.endsWith('.feishu.cn')) || source.port || source.username || source.password || !/^\/(?:wiki|docx)\/[A-Za-z0-9]+\/?$/.test(source.pathname)) throw cliError('invalid_document_url');
  if (!['outline', 'full', 'section', 'range', 'keyword'].includes(scope) || !['simple', 'with-ids', 'full'].includes(detail)) throw cliError('invalid_document_scope');
  const args = ['docs', '+fetch', `--doc=${source.origin}${source.pathname}`, `--scope=${scope}`, `--detail=${detail}`, '--doc-format=xml', '--as=user'];
  if (startBlockId) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(startBlockId)) throw cliError('invalid_block_id'); args.push(`--start-block-id=${startBlockId}`); }
  if (endBlockId) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(endBlockId)) throw cliError('invalid_block_id'); args.push(`--end-block-id=${endBlockId}`); }
  if (keyword) { if (keyword.length > 256 || /[\x00-\x1f]/.test(keyword)) throw cliError('invalid_keyword'); args.push(`--keyword=${keyword}`); }
  if (scope === 'section' && !startBlockId || scope === 'keyword' && !keyword || scope === 'range' && !startBlockId && !endBlockId) throw cliError('document_selector_required');
  return args;
}

export async function readDocument(account, token, input) {
  const { ok, output } = await invoke(docReadArgs(input), token);
  let result;
  try { result = JSON.parse(output); } catch { throw cliError('invalid_cli_json'); }
  return { ok: ok && result.ok !== false, account, identity: 'user', appId: token.appId, openId: token.openId, result };
}

export function docImageArgs({ mediaToken, mode = 'preview' }) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(mediaToken) || !['preview', 'download'].includes(mode)) throw cliError('invalid_media_selection');
  return ['docs', mode === 'preview' ? '+media-preview' : '+media-download', `--token=${mediaToken}`, '--output=./media', '--as=user', '--json'];
}

export async function readDocumentImage(account, token, input): Promise<CallToolResult> {
  const { ok, output, image } = await invoke(docImageArgs(input), token, { captureImage: true });
  let result;
  try { result = JSON.parse(output); } catch { throw cliError('invalid_cli_json'); }
  // A scratch path is not a cross-client artifact. Return real MCP image content.
  if (!ok || result.ok === false) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ account, identity: 'user', error: result.error || 'media_read_failed' }) }] };
  if (!image) throw cliError('image_output_missing');
  return { content: [{ type: 'text', text: JSON.stringify({ account, identity: 'user', openId: token.openId, mediaToken: input.mediaToken, mimeType: image.mimeType, bytes: Buffer.byteLength(image.data, 'base64') }) }, image] };
}

export async function cliHelp(command: string[] = [], skill?: string) {
  if (skill !== undefined) {
    if (command.length || skill.length > 240 || !/^lark-[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_.-]+\.md)?$/.test(skill) || skill.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid_skill_reference');
    const { output } = await invoke(['skills', 'read', skill]);
    return output;
  }
  if (!Array.isArray(command) || command.length > 5 || command.some(word => !/^[a-z][a-z0-9_+-]{0,63}$/.test(word) && !/^\+[a-z][a-z0-9_-]{0,63}$/.test(word))) throw new Error('invalid_help_command');
  const { output } = await invoke([...command, '--help']);
  return output;
}
