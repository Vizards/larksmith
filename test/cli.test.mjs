import assert from 'node:assert/strict';
import test from 'node:test';
import { cliOutput, docReadArgs, docImageArgs, imageMimeType, sheetReadArgs, sheetCreateArgs, sheetWriteArgs, userEnvironment, validateReadPath } from '../dist/src/cli.js';

test('read path cannot target another host, auth endpoints or local files', () => {
  assert.equal(validateReadPath('/open-apis/sheets/v3/spreadsheets/synthetic'), '/open-apis/sheets/v3/spreadsheets/synthetic');
  for (const path of ['https://evil.example/', '/open-apis/auth/v3/app_access_token/internal', '/open-apis/sheets/../../auth/v3/token', '/etc/passwd', '/open-apis/sheets/v3/spreadsheets/x?method=DELETE']) assert.throws(() => validateReadPath(path));
});

test('structured CLI permission failures on stderr survive without exposing plain diagnostics', () => {
  const error = { ok: false, error: { type: 'permission_denied', message: 'Access denied' } };
  assert.deepEqual(JSON.parse(cliOutput({ stdout: '', stderr: JSON.stringify(error) }, false)), error);
  assert.throws(() => cliOutput({ stdout: '', stderr: 'unstructured sensitive diagnostic' }, false));
});

test('document reads reject external targets and keep values out of CLI flags', () => {
  const url = 'https://beta.feishu.cn/wiki/Synthetic';
  assert.ok(docReadArgs({ url }).includes('--as=user'));
  assert.ok(docReadArgs({ url, scope: 'keyword', keyword: '--as=bot' }).includes('--keyword=--as=bot'));
  for (const changes of [{ url: 'https://beta.feishu.cn.evil.example/wiki/X' }, { scope: 'section' }, { startBlockId: '../../x' }, { detail: 'raw' }]) assert.throws(() => docReadArgs({ url, ...changes }));
  assert.deepEqual(docImageArgs({ mediaToken: 'synthetic-image' }), ['docs', '+media-preview', '--token=synthetic-image', '--output=./media', '--as=user', '--json']);
  assert.throws(() => docImageArgs({ mediaToken: 'https://evil.example' }));
});

test('image returns are classified from bytes and reject active or non-image content', () => {
  assert.equal(imageMimeType(Buffer.from('89504e470d0a1a0a', 'hex')), 'image/png');
  assert.equal(imageMimeType(Buffer.from('ffd8ff00', 'hex')), 'image/jpeg');
  assert.equal(imageMimeType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageMimeType(Buffer.from('RIFF0000WEBP')), 'image/webp');
  for (const source of ['<svg onload="x">', '<html>hello</html>', '%PDF-1.7']) assert.throws(() => imageMimeType(Buffer.from(source)));
});

test('native sheet reads use fixed read shortcuts with exact user identity', () => {
  const url = 'https://my.feishu.cn/sheets/SyntheticToken';
  assert.deepEqual(sheetReadArgs({ url }), ['sheets', '+workbook-info', '--spreadsheet-token=SyntheticToken', '--as=user', '--json']);
  const args = sheetReadArgs({ url, operation: 'cells', sheetName: '--as=bot', range: 'A1:B3', include: ['value', 'formula'] });
  assert.ok(args.includes('--sheet-name=--as=bot'));
  assert.ok(args.includes('--include=value,formula'));
  assert.ok(args.includes('--max-chars=25000'));
  assert.equal(args.includes('--as=bot'), false);
});

test('sheet reads reject arbitrary hosts, writes and unbounded cell reads', () => {
  const input = { url: 'https://my.feishu.cn/sheets/SyntheticToken', operation: 'csv', sheetId: 'sheet1', range: 'A1:C5' };
  for (const changes of [{ url: 'https://my.feishu.cn.evil.example/sheets/X' }, { url: 'https://user:pass@my.feishu.cn/sheets/X' }, { operation: 'delete' }, { range: undefined }, { range: '@../../etc/passwd' }, { sheetName: 'also-selected' }, { maxChars: 0 }]) assert.throws(() => sheetReadArgs({ ...input, ...changes }));
});

test('CLI receives only the selected user token, with no application secret or ambient credentials', () => {
  const env = userEnvironment('/tmp/synthetic', { appId: 'alpha-app', accessToken: 'synthetic-user', appSecret: 'never-pass' });
  assert.equal(env.LARKSUITE_CLI_STRICT_MODE, 'user');
  assert.equal(env.LARKSUITE_CLI_DEFAULT_AS, 'user');
  assert.equal(env.LARKSUITE_CLI_USER_ACCESS_TOKEN, 'synthetic-user');
  assert.equal(env.LARKSUITE_CLI_APP_SECRET, undefined);
  assert.equal(env.BRIDGE_STATE_KEY, undefined);
  assert.equal(env.VERCEL_OIDC_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(JSON.stringify(env).includes('never-pass'), false);
});

test('sheet writes preserve exact dimensions and reject implicit overwrite or extra capabilities', () => {
  const input = { url: 'https://my.feishu.cn/sheets/SyntheticToken', sheetId: 'sheet1', range: 'Z8:AA9', cells: [[{ value: '测试' }, { value: 2 }], [{ value: null }, { formula: '=1+1' }]] };
  const args = sheetWriteArgs(input);
  assert.ok(args.includes('--allow-overwrite=false'));
  assert.ok(args.includes('--as=user'));
  assert.equal(JSON.parse(args.find(x => x.startsWith('--cells=')).slice(8))[0][1].value, 2);
  for (const changes of [{ range: 'AA9:Z8' }, { range: 'A1:C2' }, { cells: [[{ value: 'only one' }]] }, { cells: [[{ value: 'a', formula: '=1' }, { value: 2 }], input.cells[1]] }, { allowOverwrite: 'true' }, { url: 'https://evil.example/sheets/X' }, { cells: [[{ value: 'x'.repeat(65536) }, { value: 2 }], input.cells[1]] }]) assert.throws(() => sheetWriteArgs({ ...input, ...changes }));
  assert.ok(sheetCreateArgs({ title: '--as=bot' }).includes('--title=--as=bot'));
  assert.throws(() => sheetCreateArgs({ title: 'Synthetic', folderToken: '../../outside' }));
});
