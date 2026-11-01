import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { makeApp } from '../dist/src/server.js';
import { FeishuAccounts } from '../dist/src/feishu.js';
import { syntheticAccounts } from './support/accounts.mjs';
import { allowedRedirect, makeOAuth, passwordHash, validRegistration } from '../dist/src/oauth.js';
import { StateDocument } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

test('registration rejects external callbacks and metadata fetch targets', () => {
  assert.ok(allowedRedirect('http://127.0.0.1:1455/auth/callback'));
  assert.ok(allowedRedirect('https://chatgpt.com/connector_platform_oauth_redirect'));
  assert.equal(allowedRedirect('https://chatgpt.com.evil.example/connector_platform_oauth_redirect'), false);
  assert.equal(allowedRedirect('http://192.168.1.1/callback'), false);
  assert.equal(validRegistration({ redirect_uris: ['http://localhost:1455/callback'], jwks_uri: 'http://169.254.169.254/' }), false);
  assert.equal(validRegistration({ redirect_uris: ['https://evil.example/callback'] }), false);
});

for (const [clientId, extra] of [
  ['https://chatgpt.com/oauth/codex/client.json', { application_type: 'native' }],
  // Claude's actual published metadata omits application_type.
  ['https://claude.ai/oauth/claude-code-client-metadata', {}],
]) test(`${clientId}: loopback ports work and unlisted metadata/callbacks fail`, async t => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(String(url));
    assert.equal(url, clientId);
    return Response.json({ client_id: clientId, client_name: 'Native test client', ...extra,
      redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'ES256' };
  const master = randomBytes(32).toString('base64url');
  const { provider } = makeOAuth({ issuer: 'http://127.0.0.1:1455', master, jwks: { keys: [jwk] },
    ownerHash: passwordHash('synthetic', 'test-salt'),
    state: new StateDocument({ master, name: 'oauth', backend: new MemoryBackend(), delay: false }) });
  const client = await provider.Client.find(clientId);
  assert.equal(client.tokenEndpointAuthMethod, 'none');
  assert.ok(client.redirectUriAllowed('http://127.0.0.1:63123/callback'));
  assert.equal(client.redirectUriAllowed('http://127.0.0.1:63123/another-path'), false);
  assert.equal(client.redirectUriAllowed('https://evil.example/callback'), false);
  for (const url of ['https://chatgpt.com.evil.example/oauth/codex/client.json', 'https://claude.ai.evil.example/oauth/claude-code-client-metadata', `${clientId}?extra=1`, 'https://169.254.169.254/client.json']) {
    await assert.rejects(provider.Client.find(url), error => error.error === 'invalid_client');
  }
  assert.deepEqual(requested, [clientId]);
});

test('full OAuth PKCE flow, authenticated MCP, refresh rotation and revocation', async t => {
  // This regression suite never targets a live deployment.
  let app;
  const server = createServer((req, res) => app.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'test-key', use: 'sig', alg: 'ES256' });
  const master = randomBytes(32).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  assert.ok(password);
  const backend = new MemoryBackend();
  let reads = 0;
  const read = backend.read.bind(backend);
  backend.read = async path => { reads++; return read(path); };
  const config = { issuer, master, ownerId: 'owner', accounts: new FeishuAccounts({ master, backend, config: syntheticAccounts, secrets: {} }), jwks: { keys: [jwk] }, ownerHash: passwordHash(password, 'test-salt'), state: new StateDocument({ master, name: 'oauth', backend, delay: false }) };
  {
    app = makeApp({ ...config, cronSecret: 'synthetic-cron-secret' });
    const route = `${issuer}/internal/maintenance`;
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(route, { headers: { authorization: 'Bearer wrong-secret' } })).status, 401);
    assert.equal((await fetch(route, { method: 'POST', headers: { authorization: 'Bearer synthetic-cron-secret' } })).status, 405);
  }
  const jar = new Map();
  async function request(path, options = {}) {
    const url = new URL(path, issuer);
    const response = await fetch(url, { redirect: 'manual', ...options, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const equals = pair.indexOf('=');
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  }
  const as = await (await request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.scopes_supported, ['lark:read', 'lark:write']);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
  const challenge = await request('/mcp', { method: 'POST' });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate'), /resource_metadata=/);
  const registration = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic test client', redirect_uris: ['http://127.0.0.1:1455/callback'], application_type: 'native', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const client = await registration.json();
  assert.equal(registration.status, 201, JSON.stringify(client));
  assert.equal(client.client_secret, undefined);
  const verifier = randomBytes(32).toString('base64url');
  // Native MCP clients discover scopes, then repeat them during refresh.
  // Testing only a hard-coded login and a scopeless refresh hid the incident.
  const requestedScopes = as.scopes_supported.join(' ');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], scope: requestedScopes, resource: `${issuer}/mcp`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'synthetic-state' });
  const noPkce = new URLSearchParams(params);
  noPkce.delete('code_challenge');
  noPkce.delete('code_challenge_method');
  const missingPkce = await request(`/authorize?${noPkce}`);
  assert.equal(new URL(missingPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');
  let response = await request(`/authorize?${params}`);
  let final;
  let submitted = 0;
  for (let step = 0; step < 12; step++) {
    const location = response.headers.get('location');
    if (location) {
      const url = new URL(location, issuer);
      if (url.origin !== issuer) { final = url; break; }
      response = await request(url);
      continue;
    }
    const html = await response.text();
    assert.equal(response.status, 200, html);
    const action = /<form action="([^"]+)"/.exec(html)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(action && csrf, html);
    if (submitted === 0) {
      const crossOrigin = await request(action, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, password, decision: 'allow' }) });
      assert.equal(crossOrigin.status, 403);
      const badCsrf = await request(action, { method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: 'invalid', password, decision: 'allow' }) });
      assert.equal(badCsrf.status, 403);
    }
    response = await request(action, { method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, password, decision: 'allow' }) });
    submitted++;
  }
  assert.ok(final, 'authorization reached the client callback');
  assert.equal(final.searchParams.get('iss'), issuer);
  assert.equal(final.searchParams.get('state'), 'synthetic-state');
  assert.ok(!final.searchParams.has('error'), final.search);
  assert.equal(submitted, 2, 'login and consent are separate explicit decisions');
  const code = final.searchParams.get('code');
  const tokenBody = { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: client.redirect_uris[0], resource: `${issuer}/mcp` };
  const wrongVerifier = await request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...tokenBody, code_verifier: randomBytes(32).toString('base64url') }) });
  assert.equal(wrongVerifier.status, 400);
  assert.equal((await wrongVerifier.json()).error, 'invalid_grant');
  const tokenResponse = await request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(tokenBody) });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify({ error: tokens.error, description: tokens.error_description }));
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.expires_in, 43200);

  // A new application instance shares state, not memory or a filesystem session.
  {
    app = makeApp({ ...config, cronSecret: 'synthetic-cron-secret' });
    const route = `${issuer}/internal/maintenance`;
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(route, { headers: { authorization: 'Bearer wrong-secret' } })).status, 401);
    assert.equal((await fetch(route, { method: 'POST', headers: { authorization: 'Bearer synthetic-cron-secret' } })).status, 405);
  }
  const mcp = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lark_bridge_status', arguments: {} } }) });
  const mcpResult = await mcp.json();
  assert.equal(mcp.status, 200, JSON.stringify(mcpResult));
  assert.equal(JSON.parse(mcpResult.result.content[0].text).identityMode, 'user-only');
  const refreshParams = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: `${issuer}/mcp`, scope: requestedScopes };
  const refresh = params => request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  {
    const badScope = { ...refreshParams, scope: `${requestedScopes} offline_access` };
    const rejected = await refresh(badScope);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).scope, 'offline_access');
    assert.equal(rejected.headers.get('retry-after'), '60');
    const beforeRetry = reads;
    const retried = await refresh(badScope);
    assert.equal(retried.status, 400);
    assert.equal((await retried.json()).error, 'invalid_scope');
    assert.equal(retried.headers.get('cache-control'), 'no-store');
    assert.equal(reads, beforeRetry, 'identical deterministic failure does not read shared state again');
    const advanced = Date.now() + 61_000;
    const clock = t.mock.method(Date, 'now', () => advanced);
    try {
      assert.equal((await refresh(badScope)).status, 400);
      assert.ok(reads > beforeRetry, 'negative result expires and revalidates shared state');
    } finally { clock.mock.restore(); }
    const otherScope = await refresh({ ...refreshParams, scope: `${requestedScopes} openid` });
    assert.equal(otherScope.status, 400);
    assert.equal((await otherScope.json()).scope, 'openid', 'distinct scope requests are independently validated');
    const duplicate = new URLSearchParams(refreshParams);
    duplicate.append('scope', requestedScopes);
    const invalidForm = await refresh(duplicate);
    assert.equal(invalidForm.status, 400);
    assert.equal((await invalidForm.json()).error, 'invalid_request', 'duplicate params are not silently flattened');
  }
  const refreshResponse = await refresh(refreshParams);
  const refreshed = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200, JSON.stringify({ error: refreshed.error, description: refreshed.error_description, missingScope: refreshed.scope }));
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  assert.equal(refreshed.expires_in, 43200);
  const replay = await request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: `${issuer}/mcp` }) });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
  const revoked = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  assert.equal(revoked.status, 401, 'replay revoked the grant and all access tokens');
});
