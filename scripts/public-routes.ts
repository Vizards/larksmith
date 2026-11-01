import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeOAuth, protectedResourceMetadata } from '../src/oauth.ts';
import { StateDocument } from '../src/state.ts';

// Derive public metadata from the same provider configuration, with synthetic
// keys and a storage backend which fails on any access. Never use deployment
// secrets or publish a signing key. Regenerate on every build/SDK upgrade.
export async function publicDocuments(issuer: string) {
  const origin = new URL(issuer);
  assert.equal(origin.origin, issuer, 'BRIDGE_ISSUER must be a canonical origin');
  const master = randomBytes(32).toString('base64url');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'build-only', use: 'sig', alg: 'ES256' };
  const noStorage = async (): Promise<never> => { throw new Error('Public discovery must not access state'); };
  const { provider } = makeOAuth({ issuer, master, jwks: { keys: [jwk] }, ownerHash: '',
    state: new StateDocument({ master, name: 'oauth', backend: { read: noStorage, compareExchange: noStorage } }) });
  const server = createServer(provider.callback());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-authorization-server`, {
      headers: { 'x-forwarded-host': origin.host, 'x-forwarded-proto': origin.protocol.slice(0, -1) }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const authorization = await response.json();
    assert.equal(authorization.issuer, issuer);
    assert.equal(authorization.token_endpoint, `${issuer}/token`);
    assert.deepEqual(authorization.scopes_supported, ['lark:read', 'lark:write']);
    return { authorization, resource: protectedResourceMetadata(issuer) };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function writePublicRoutes(output: string, issuer: string) {
  const documents = await publicDocuments(issuer);
  const directory = join(output, 'static/bridge-public');
  await mkdir(directory, { recursive: true });
  for (const [name, document] of Object.entries(documents)) await writeFile(join(directory, `${name}.json`), JSON.stringify(document));
  await writeFile(join(directory, 'no-stream.json'), JSON.stringify({ error: 'method_not_allowed' }));
  const has = [{ type: 'host', value: new URL(issuer).host }];
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*', 'X-Lark-Bridge-Route': 'public-static-v1' };
  return [
    { src: '^/\\.well-known/(?:oauth-authorization-server|openid-configuration)$', methods: ['GET', 'HEAD'], has,
      dest: '/bridge-public/authorization.json', headers },
    { src: '^/\\.well-known/oauth-protected-resource(?:/mcp)?$', methods: ['GET', 'HEAD'], has,
      dest: '/bridge-public/resource.json', headers },
    // Requests with Origin retain the runtime Origin check. POST always reaches
    // the live JWT/grant validator; no successful auth decision is cached here.
    { src: '^/mcp$', methods: ['GET', 'HEAD'], has, missing: [{ type: 'header', key: 'origin' }], status: 405,
      dest: '/bridge-public/no-stream.json', headers: { ...headers, 'Cache-Control': 'no-store', Allow: 'POST, OPTIONS' } },
  ];
}
