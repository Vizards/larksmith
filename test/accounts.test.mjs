import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAccountsConfig, parseAccountsConfig, deploymentIssuer } from '../dist/src/accounts.js';
import { FeishuAccounts } from '../dist/src/feishu.js';
import { MemoryBackend } from './support/memory-backend.mjs';
import { syntheticAccounts } from './support/accounts.mjs';
import { randomBytes } from 'node:crypto';

test('configured aliases preserve app, identity, scopes and encrypted state across restart', async () => {
  const master = randomBytes(32).toString('base64url'), backend = new MemoryBackend();
  const bindings = { research: syntheticAccounts.alpha, 'team-a': syntheticAccounts.beta, archive: syntheticAccounts.alpha };
  const first = new FeishuAccounts({ master, backend, config: bindings });
  await first.states.research.update(doc => { doc.marker = 'retained'; });
  const env = { FEISHU_ACCOUNTS_JSON: JSON.stringify(bindings), FEISHU_TEAM_A_APP_SECRET: 'synthetic-secret' };
  assert.deepEqual(loadAccountsConfig(env), bindings);
  const current = new FeishuAccounts({ master, backend, secrets: env });
  assert.equal((await current.states.research.read()).marker, 'retained');
  assert.equal(current.account('team-a').secret, 'synthetic-secret');
  assert.throws(() => current.account('unconfigured'), /unknown_account/);
  assert.deepEqual(Object.keys(loadAccountsConfig({ FEISHU_ACCOUNTS_JSON: JSON.stringify({ primary: syntheticAccounts.alpha }) })), ['primary']);
});

test('configuration fails closed, rejects secrets/invalid aliases and never echoes values', () => {
  const bad = [undefined, '', '{}', '[]', '{bad', JSON.stringify({ '../bad': syntheticAccounts.alpha }), JSON.stringify({ 'Upper': syntheticAccounts.alpha }), JSON.stringify({ ['__proto__']: syntheticAccounts.alpha }), JSON.stringify({ constructor: syntheticAccounts.alpha }), JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`account${i}`, syntheticAccounts.alpha]))),
    JSON.stringify({ alpha: { ...syntheticAccounts.alpha, appSecret: 'never-echo-this' } }),
    JSON.stringify({ alpha: { ...syntheticAccounts.alpha, expectedOpenId: '' } }),
    JSON.stringify({ alpha: { ...syntheticAccounts.alpha, scopes: ['docx:document:readonly'] } }),
    JSON.stringify({ alpha: { ...syntheticAccounts.alpha, brand: 'lark' } }),
    JSON.stringify({ alpha: { ...syntheticAccounts.alpha, appId: 'cli_REPLACE_APP_ID' } })];
  for (const value of bad) assert.throws(() => parseAccountsConfig(value), error =>
    error.message === 'Invalid FEISHU_ACCOUNTS_JSON; see docs/deployment.md');
});

test('build requires explicit canonical HTTPS issuer; no implicit production fallback', () => {
  assert.equal(deploymentIssuer({ BRIDGE_ISSUER: 'https://mcp.example.com' }), 'https://mcp.example.com');
  for (const value of [undefined, '', 'http://mcp.example.com', 'https://mcp.example.com/', 'https://mcp.example.com/mcp', 'https://user:password@mcp.example.com']) {
    assert.throws(() => deploymentIssuer({ BRIDGE_ISSUER: value }));
  }
});
