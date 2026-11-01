import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePublicRoutes } from '../dist/scripts/public-routes.js';

test('CDN metadata uses the real SDK config; authenticated and Origin requests remain dynamic', async t => {
  const output = await mkdtemp(join(tmpdir(), 'lark-public-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const issuer = 'https://synthetic.example';
  const routes = await writePublicRoutes(output, issuer);
  const authorization = JSON.parse(await readFile(join(output, 'static/bridge-public/authorization.json'), 'utf8'));
  const resource = JSON.parse(await readFile(join(output, 'static/bridge-public/resource.json'), 'utf8'));
  assert.deepEqual(authorization.scopes_supported, resource.scopes_supported);
  assert.equal(authorization.client_id_metadata_document_supported, true);
  assert.equal(authorization.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(authorization.code_challenge_methods_supported, ['S256']);
  assert.equal(authorization.jwks_uri, `${issuer}/jwks`, 'JWKS stays dynamic; build keys are never published');
  const matches = (path, method, origin) => routes.find(route => new RegExp(route.src).test(path) && route.methods.includes(method) && (!route.missing || !origin));
  for (const path of ['/token', '/authorize', '/register', '/jwks', '/internal/maintenance', '/interaction/test']) {
    assert.equal(matches(path, 'GET'), undefined);
    assert.equal(matches(path, 'POST'), undefined);
  }
  assert.equal(matches('/mcp', 'POST'), undefined);
  assert.equal(matches('/mcp', 'OPTIONS'), undefined);
  assert.equal(matches('/mcp', 'GET', 'https://evil.example'), undefined);
  assert.equal(matches('/mcp', 'GET').status, 405);
  assert.equal(matches('/mcp', 'GET').headers.Allow, 'POST, OPTIONS');
  assert.ok(matches('/.well-known/oauth-protected-resource/mcp', 'GET'));
  assert.ok(routes.every(route => route.has[0].value === 'synthetic.example'));
});
