import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { FeishuAccounts } from '../dist/src/feishu.js';
import { MemoryBackend } from './support/memory-backend.mjs';

function setup({ mismatch = false, failRefresh = false } = {}) {
  let now = 1_000_000;
  let refreshCalls = 0;
  const config = { alpha: { appId: 'app-alpha', expectedOpenId: 'user-alpha', label: 'Alpha', scopes: ['offline_access', 'sheets:spreadsheet:read'] }, beta: { appId: 'app-beta', expectedOpenId: 'user-beta', label: 'Beta', scopes: ['offline_access'] } };
  const secrets = { FEISHU_ALPHA_APP_SECRET: 'synthetic-alpha', FEISHU_BETA_APP_SECRET: 'synthetic-beta' };
  const accounts = new FeishuAccounts({ master: randomBytes(32).toString('base64url'), backend: new MemoryBackend(), config, secrets, clock: () => now,
    fetcher: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url.endsWith('device_authorization')) return Response.json({ device_code: 'device-private', user_code: 'USER-CODE', verification_uri_complete: 'https://accounts.feishu.cn/device?code=synthetic', expires_in: 240, interval: 5 });
      if (url.endsWith('user_info')) return Response.json({ code: 0, data: { open_id: mismatch ? 'wrong-user' : 'user-alpha' } });
      const refresh = new URLSearchParams(options.body).get('grant_type') === 'refresh_token';
      if (refresh) {
        refreshCalls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        if (failRefresh) throw new TypeError('synthetic network failure');
      }
      return Response.json({ access_token: refresh ? 'new-access' : 'first-access', refresh_token: refresh ? 'new-refresh' : 'first-refresh', expires_in: 7200, refresh_token_expires_in: 604800, scope: 'offline_access sheets:spreadsheet:read' });
    } });
  return { accounts, advance: seconds => { now += seconds * 1000; }, get refreshCalls() { return refreshCalls; } };
}

async function connect(s) { await s.accounts.begin('alpha'); s.advance(6); return s.accounts.complete('alpha'); }

test('device authorization binds the configured user and never connects another account', async () => {
  const s = setup();
  const pending = await s.accounts.begin('alpha');
  assert.equal(pending.deviceCode, undefined);
  await assert.rejects(s.accounts.complete('alpha'), /wait_before_polling/);
  s.advance(6);
  const status = await s.accounts.complete('alpha');
  assert.equal(status.connected, true);
  assert.equal(status.openId, 'user-alpha');
  assert.equal(status.accessToken, undefined);
  await assert.rejects(s.accounts.userToken('beta'), /user_authorization_required/);
  await assert.rejects(s.accounts.userToken('__proto__'), /unknown_account/);
});

test('a wrong Feishu identity is never persisted', async () => {
  const s = setup({ mismatch: true });
  await assert.rejects(connect(s), /user_identity_mismatch/);
  assert.equal((await s.accounts.status('alpha')).connected, false);
});

test('concurrent requests refresh a user token only once', async () => {
  const s = setup(); await connect(s); s.advance(7190);
  const results = await Promise.allSettled([s.accounts.userToken('alpha'), s.accounts.userToken('alpha')]);
  assert.equal(s.refreshCalls, 1);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.ok(results.every(r => r.status === 'fulfilled' ? r.value.accessToken === 'new-access' : r.reason.code === 'user_refresh_in_progress'));
  assert.equal((await s.accounts.userToken('alpha')).accessToken, 'new-access');
  assert.equal(s.refreshCalls, 1);
});

test('an uncertain refresh is fenced and does not reuse the old rotating token', async () => {
  const s = setup({ failRefresh: true }); await connect(s); s.advance(7190);
  await assert.rejects(s.accounts.userToken('alpha'), /refresh_outcome_uncertain/);
  await assert.rejects(s.accounts.userToken('alpha'), /user_authorization_required/);
  assert.equal(s.refreshCalls, 1);
});

test('explicit refresh is bound to the observed expiry and retries cannot rotate a newer grant', async () => {
  const s = setup(); const connected = await connect(s); s.advance(60);
  await assert.rejects(s.accounts.refresh('alpha'), /expected_access_expiry_required/);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => s.accounts.refresh('alpha', connected.accessExpiresAt)));
  assert.equal(s.refreshCalls, 1);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.ok(results.every(r => r.status === 'fulfilled' || r.reason.code === 'user_refresh_in_progress'));
  const status = await s.accounts.refresh('alpha', connected.accessExpiresAt);
  assert.equal(status.refreshCount, 1);
  assert.notEqual(status.accessExpiresAt, connected.accessExpiresAt);
  assert.equal(s.refreshCalls, 1);
});
