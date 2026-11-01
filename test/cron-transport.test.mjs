import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { makeApp } from '../dist/src/server.js';
import { passwordHash } from '../dist/src/oauth.js';
import { MemoryBackend } from './support/memory-backend.mjs';

async function fixture(t, deploymentHost = 'bridge-deployment.example') {
  let app, runs = 0, cleanups = 0;
  const backend = new MemoryBackend();
  const server = createServer((req, res) => app.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const config = { issuer, master: randomBytes(32).toString('base64url'), backend,
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'ES256' }] },
    ownerHash: passwordHash('synthetic', 'test-salt'), cronSecret: 'synthetic-cron-secret',
    productionDeploymentHost: deploymentHost,
    accounts: { config: { primary: {} }, async maintainAll() { runs++; return { ok: true, accounts: [] }; } },
    uploads: { async cleanup() { cleanups++; return { ok: true }; } },
    mutations: { async cleanup() { cleanups++; return { ok: true }; } },
  };
  app = makeApp(config);
  const request = ({ host = deploymentHost, path = '/internal/maintenance', method = 'GET', secret = 'synthetic-cron-secret', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${issuer}${path}`, { method, headers: { host, 'user-agent': 'vercel-cron/1.0', ...headers,
      ...(secret == null ? {} : { authorization: `Bearer ${secret}` }) } }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  return { request, config, canonicalHost: new URL(issuer).host, get runs() { return runs; }, get cleanups() { return cleanups; } };
}

test('Cron reaches maintenance on the exact deployment host and canonical issuer', async t => {
  const f = await fixture(t);
  for (const host of [f.config.productionDeploymentHost, f.canonicalHost]) {
    const response = await f.request({ host });
    assert.equal(response.status, 200, response.body);
    assert.equal(JSON.parse(response.body).ok, true);
  }
  assert.equal(f.runs, 2);
  assert.equal(f.cleanups, 4);
});

test('deployment-host exception still requires the Cron secret, GET, and exact path', async t => {
  const f = await fixture(t);
  for (const secret of [null, '', 'wrong-secret', 'synthetic-cron-secrex']) {
    assert.equal((await f.request({ secret })).status, 401);
  }
  assert.equal((await f.request({ method: 'POST' })).status, 405);
  for (const path of ['/mcp', '/token', '/authorize', '/health', '/internal/maintenance/']) {
    assert.equal((await f.request({ path })).status, 400, path);
  }
  assert.equal(f.runs, 0);
  assert.equal(f.cleanups, 0);
});

test('unlisted hosts and forwarded-host spoofing cannot invoke maintenance', async t => {
  const f = await fixture(t);
  for (const host of ['evil.example', 'bridge-deployment.example.evil.example']) {
    const response = await f.request({ host, headers: { 'x-forwarded-host': f.canonicalHost, 'x-vercel-cron-schedule': '0 1 * * *' } });
    assert.equal(response.status, 400);
    assert.equal(response.body, 'INVALID_HOST');
  }
  f.config.productionDeploymentHost = undefined;
  assert.equal((await f.request()).status, 400, 'no deployment hostname is trusted when not configured');
  assert.equal(f.runs, 0);
});

test('maintenance mode freezes the generated Cron hostname before any work', async t => {
  const f = await fixture(t); f.config.maintenance = true;
  const response = await f.request();
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'maintenance_in_progress' });
  assert.equal(f.runs, 0);
  assert.equal(f.cleanups, 0);
});
