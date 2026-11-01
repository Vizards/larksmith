import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { SignJWT } from 'jose';
import { makeApp } from '../dist/src/server.js';
import { FeishuAccounts } from '../dist/src/feishu.js';
import { syntheticAccounts } from './support/accounts.mjs';
import { passwordHash } from '../dist/src/oauth.js';
import { StateDocument, StateUnavailable } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';
import { catalog } from '../dist/src/commands.js';

async function fixture(t, bindings = syntheticAccounts) {
  let app, reads = 0, unavailable = false;
  const backend = new MemoryBackend();
  const read = backend.read.bind(backend);
  backend.read = async path => { reads++; if (unavailable) throw new StateUnavailable('synthetic outage'); return read(path); };
  const server = createServer((req, res) => app.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'ES256' };
  const master = randomBytes(32).toString('base64url');
  const config = { issuer, master, ownerId: 'owner', storage: { kind: 'upstash', namespace: 'test' }, accounts: new FeishuAccounts({ master, backend, config: bindings, secrets: {} }), jwks: { keys: [jwk] }, ownerHash: passwordHash('synthetic', 'test-salt'),
    state: new StateDocument({ master, name: 'oauth', backend, delay: false }) };
  app = makeApp(config);
  const grant = new app.oauth.Adapter('Grant');
  await grant.upsert('synthetic-grant', { accountId: 'owner', clientId: 'synthetic-client' }, 3600);
  const token = await new SignJWT({ grant_id: 'synthetic-grant', client_id: 'synthetic-client', scope: 'lark:read' })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'test-key' }).setSubject('owner')
    .setIssuer(issuer).setAudience(`${issuer}/mcp`).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  reads = 0;
  const request = (method, body, bearer = token) => fetch(`${issuer}/mcp`, { method,
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { request, grant, issuer, get reads() { return reads; }, set unavailable(value) { unavailable = value; }, set maintenance(value) { config.maintenance = value; } };
}

test('MCP bounds HTTP bytes and nested argument elements before business validation', async t => {
  const f = await fixture(t);
  const excessive = await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'lark_cli_read', arguments: { account: 'alpha', command: ['drive', '+search'], parameters: { entries: Array(10_001).fill(null) } },
  } });
  const rejected = await excessive.json();
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /maximum of 10000 elements/);
  const oversized = await f.request('POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'lark_cli_read', arguments: { account: 'alpha', command: ['drive', '+search'], parameters: { query: 'x'.repeat(512 * 1024) } },
  } });
  assert.equal(oversized.status, 413);
  assert.equal((await f.request('POST', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 200, 'a rejected payload does not break later calls');
});

test('single-account deployments expose only the configured identity and reject unconfigured accounts', async t => {
  const f = await fixture(t, { alpha: syntheticAccounts.alpha });
  const response = await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const { result } = await response.json();
  const read = result.tools.find(tool => tool.name === 'lark_cli_read');
  const schema = read.inputSchema.properties.account;
  assert.deepEqual(schema.enum ?? [schema.const], ['alpha']);
  const status = await (await f.request('POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lark_bridge_status', arguments: {} } })).json();
  assert.equal(JSON.parse(status.result.content[0].text).cliVersion, catalog().cliVersion);
  assert.deepEqual(JSON.parse(status.result.content[0].text).accounts.map(account => account.account), ['alpha']);
  const rejected = await (await f.request('POST', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'lark_api_read', arguments: { account: 'beta', path: '/open-apis/sheets/v3/spreadsheets/synthetic' },
  } })).json();
  assert.ok(rejected.error || rejected.result?.isError);
});

test('stateless MCP refuses idle streams without storage reads and preserves POST discovery', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await f.request(method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(response.headers.get('www-authenticate'), null);
  }
  const preflight = await f.request('OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(f.reads, 0);
  const initialize = await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' },
  } });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.serverInfo.name, 'larksmith');
  assert.equal((await f.request('POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const listing = await f.request('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listing.status, 200);
  assert.ok((await listing.json()).result.tools.some(tool => tool.name === 'lark_cli_read'));
  assert.equal(f.reads, 3, 'POST requests each check the current grant');
});

test('maintenance mode freezes OAuth, MCP, account actions and Cron before reading state', async t => {
  const f = await fixture(t);
  f.maintenance = true;
  for (const [path, method] of [['/mcp', 'POST'], ['/token', 'POST'], ['/register', 'POST'], ['/authorize', 'GET'], ['/internal/maintenance', 'GET']]) {
    const response = await fetch(`${f.issuer}${path}`, { method });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'maintenance_in_progress' });
  }
  const health = await (await fetch(`${f.issuer}/health`)).json();
  assert.equal(health.maintenance, true);
  assert.equal(f.reads, 0);
  f.maintenance = false;
  assert.equal((await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
});

test('storage outage is retryable 503; bad credentials and revoked grants still get 401', async t => {
  const f = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await f.request('POST', body, 'invalid')).status, 401);
  assert.equal(f.reads, 0);
  f.unavailable = true;
  const outage = await f.request('POST', body);
  assert.equal(outage.status, 503);
  assert.equal(outage.headers.get('retry-after'), '60');
  assert.equal(outage.headers.get('www-authenticate'), null, 'outage must not trigger OAuth refresh');
  assert.deepEqual(await outage.json(), { error: 'temporarily_unavailable' });
  f.unavailable = false;
  assert.equal((await f.request('POST', body)).status, 200);
  await f.grant.destroy('synthetic-grant');
  assert.equal((await f.request('POST', body)).status, 401);
});

test('OAuth endpoint reports storage outages as temporary without exposing upstream details', async t => {
  const f = await fixture(t);
  f.unavailable = true;
  for (const accept of ['application/json', 'application/json', 'text/html']) {
    const before = f.reads;
    const response = await fetch(`${f.issuer}/token`, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded', accept,
    }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'synthetic-client', refresh_token: 'synthetic' }) });
    assert.equal(response.status, 503);
    assert.ok(f.reads > before, 'transient storage errors are never negatively cached');
    assert.equal(response.headers.get('retry-after'), '60');
    const text = await response.text();
    assert.ok(!text.includes('synthetic outage'));
    if (accept === 'application/json') assert.deepEqual(JSON.parse(text), { error: 'temporarily_unavailable' });
    else assert.match(text, /无需重新登录或重新授权/);
  }
});


test('MCP tool schemas expose arbitrary configured aliases and keep account boundaries', async t => {
  const f = await fixture(t, { research: syntheticAccounts.alpha, 'team-a': syntheticAccounts.beta, archive: syntheticAccounts.alpha });
  const listing = await (await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  for (const tool of listing.result.tools) {
    const field = tool.inputSchema.properties?.account;
    if (field) assert.deepEqual(field.enum, ['research', 'team-a', 'archive']);
  }
  const invalid = await (await f.request('POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'lark_api_read', arguments: { account: 'unconfigured', path: '/open-apis/sheets/v3/spreadsheets/synthetic' },
  } })).json();
  assert.equal(invalid.result.isError, true);
});
