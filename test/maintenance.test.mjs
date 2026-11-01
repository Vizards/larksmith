import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { FeishuAccounts } from '../dist/src/feishu.js';
import { unseal } from '../dist/src/state.js';
import { MemoryBackend } from './support/memory-backend.mjs';

async function fixture() {
  let now = Date.parse('2026-09-14T00:00:00Z');
  const backend = new MemoryBackend();
  const master = randomBytes(32).toString('base64url');
  const controls = { profileDown: false, wrongProfile: false, refreshErrors: [], calls: 0 };
  const config = Object.fromEntries(['alpha', 'beta'].map(account => [account, { appId: account, expectedOpenId: account, label: account, scopes: ['offline_access'] }]));
  const accounts = new FeishuAccounts({ master, backend, clock: () => now, pause: async () => {}, config,
    secrets: { FEISHU_ALPHA_APP_SECRET: 'synthetic', FEISHU_BETA_APP_SECRET: 'synthetic' },
    fetcher: async (url, init) => {
      if (url.endsWith('device_authorization')) return Response.json({ device_code: new URLSearchParams(init.body).get('client_id'), verification_uri: 'https://accounts.feishu.cn/device', expires_in: 240 });
      if (url.endsWith('user_info')) {
        if (controls.profileDown) throw new TypeError('synthetic outage');
        return Response.json({ code: 0, data: { open_id: controls.wrongProfile ? 'someone-else' : init.headers.Authorization.split(' ')[1].split(':')[0] } });
      }
      const params = new URLSearchParams(init.body);
      const account = params.get('client_id');
      if (params.get('grant_type') === 'refresh_token') {
        assert.equal(url, 'https://accounts.feishu.cn/oauth/v3/token');
        controls.calls++;
        const error = controls.refreshErrors.shift();
        if (error === 'lost-response') throw new TypeError('synthetic response lost');
        if (error) return Response.json({ code: error }, { status: 400 });
      }
      return Response.json({ access_token: `${account}:${controls.calls}`, refresh_token: `rotating:${account}:${controls.calls}`, expires_in: 7200, refresh_token_expires_in: 604800, scope: 'offline_access' });
    }
  });
  for (const account of Object.keys(config)) { await accounts.begin(account); now += 6000; await accounts.complete(account); }
  return { accounts, controls, backend, advance: seconds => { now += seconds * 1000; } };
}

test('daily maintenance preserves consent across months without any business call and tolerates missed days', async () => {
  const s = await fixture();
  for (let day = 0; day < 60; day++) {
    s.advance(86400);
    if ([3, 4, 5].includes(day)) continue;
    const report = await s.accounts.maintainAll();
    assert.equal(report.ok, true);
    assert.ok(report.accounts.every(a => a.connected && !a.needsAuthorization));
    const count = s.controls.calls;
    assert.equal((await s.accounts.maintainAll()).ok, true);
    assert.equal(s.controls.calls, count, 'duplicate delivery reuses recent refresh');
  }
  const status = await s.accounts.status('alpha');
  assert.equal(status.authorizedAt, '2026-09-14T00:00:06.000Z');
  assert.equal(status.maintenance.consecutiveFailures, 0);
});

test('documented retryable rejection retries, exhausted retries keep consent for the next run', async () => {
  const s = await fixture(); s.advance(86400);
  s.controls.refreshErrors = [20050, 20072];
  assert.equal((await s.accounts.maintain('alpha')).ok, true);
  assert.equal(s.controls.calls, 3);
  s.advance(86400); s.controls.refreshErrors = [20072, 20072, 20072];
  assert.equal((await s.accounts.maintain('alpha')).error, 'user_refresh_rejected');
  assert.equal((await s.accounts.status('alpha')).needsAuthorization, false);
  assert.equal((await s.accounts.maintain('alpha')).ok, true);
});

test('profile outage after rotation persists candidate and recovers without reusing its old refresh token', async () => {
  const s = await fixture(); s.advance(86400); s.controls.profileDown = true;
  assert.equal((await s.accounts.maintain('alpha')).error, 'identity_verification_pending');
  const status = await s.accounts.status('alpha');
  assert.equal(status.needsAuthorization, false);
  assert.equal(status.connected, false);
  const candidate = (await s.accounts.states.alpha.read()).refresh.candidate;
  assert.equal(candidate.verifiedAt, undefined);
  s.controls.profileDown = false;
  const token = await s.accounts.userToken('alpha');
  assert.equal(token.generation, candidate.generation);
  assert.equal(s.controls.calls, 1);
});

test('profile outage longer than an access lifetime recovers using the saved new refresh token', async () => {
  const s = await fixture(); s.advance(86400); s.controls.profileDown = true;
  await s.accounts.maintain('alpha');
  s.advance(86400); s.controls.profileDown = false;
  assert.equal((await s.accounts.maintain('alpha')).ok, true);
  assert.equal(s.controls.calls, 2);
});

test('wrong refreshed identity is fenced and never returned for business use', async () => {
  const s = await fixture(); s.advance(86400); s.controls.wrongProfile = true;
  assert.equal((await s.accounts.maintain('alpha')).error, 'user_identity_mismatch');
  await assert.rejects(s.accounts.userToken('alpha'), /user_authorization_required/);
});

test('lost candidate or final commit replies reconcile from Blob without upstream replay', async () => {
  for (const target of ['lease', 'candidate', 'verified']) {
    const s = await fixture(); s.advance(86400);
    const exchange = s.backend.compareExchange.bind(s.backend);
    let injected = false;
    s.backend.compareExchange = async (path, etag, body) => {
      const doc = unseal(body, s.accounts.states.alpha.key, path);
      const hit = target === 'lease' ? doc.refresh && !doc.refresh.candidate : target === 'candidate' ? doc.refresh?.candidate : doc.token?.refreshCount === 1 && !doc.refresh;
      const result = await exchange(path, etag, body);
      if (hit && result && !injected) { injected = true; throw new Error('write succeeded but response lost'); }
      return result;
    };
    assert.equal((await s.accounts.maintain('alpha')).ok, true);
    assert.equal(injected, true);
    assert.equal(s.controls.calls, 1);
  }
});

test('unrecoverable refresh response is fenced while the other identity still renews', async () => {
  const s = await fixture(); s.advance(86400); s.controls.refreshErrors = ['lost-response'];
  assert.equal((await s.accounts.maintain('alpha')).error, 'refresh_outcome_uncertain');
  const count = s.controls.calls;
  assert.equal((await s.accounts.maintain('alpha')).error, 'user_authorization_required');
  assert.equal(s.controls.calls, count);
  assert.equal((await s.accounts.maintain('beta')).ok, true);
});

test('annual deadline warning and explicit upstream revocation are visible without cross-account fallback', async () => {
  const s = await fixture();
  await s.accounts.states.alpha.update(doc => { doc.token.authorizedAt -= 340 * 86400000; });
  assert.ok((await s.accounts.status('alpha')).warnings.includes('annual_reauthorization_due_soon'));
  s.advance(86400); s.controls.refreshErrors = [20064];
  assert.equal((await s.accounts.maintain('alpha')).error, 'user_authorization_required');
  assert.equal((await s.accounts.status('beta')).needsAuthorization, false);
});


test('a simultaneous Cron and business read only rotate one generation', async () => {
  const s = await fixture(); s.advance(86400);
  const results = await Promise.allSettled([s.accounts.maintain('alpha'), s.accounts.userToken('alpha')]);
  assert.equal(s.controls.calls, 1);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal((await s.accounts.userToken('alpha')).openId, 'alpha');
});


test('a live competing refresh defers maintenance without falsely requesting login', async () => {
  const s = await fixture(); s.advance(86400);
  await s.accounts.states.alpha.update(doc => { doc.refresh = { id: 'other-request', generation: doc.token.generation, deadline: Date.parse('2026-09-16T00:00:00Z') }; });
  const result = await s.accounts.maintain('alpha');
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.needsAuthorization, false);
  assert.equal(s.controls.calls, 0);
});

test('business refreshes do not hide a missing daily maintenance schedule', async () => {
  const s = await fixture();
  assert.ok(!(await s.accounts.status('alpha')).warnings.includes('daily_maintenance_overdue'));
  await s.accounts.maintain('alpha');
  s.advance(3 * 86400);
  await s.accounts.userToken('alpha');
  const status = await s.accounts.status('alpha');
  assert.equal(status.connected, true);
  assert.ok(status.warnings.includes('daily_maintenance_overdue'));
  await s.accounts.maintain('alpha');
  assert.ok(!(await s.accounts.status('alpha')).warnings.includes('daily_maintenance_overdue'));
  assert.ok((await s.accounts.status('beta')).warnings.includes('daily_maintenance_overdue'), 'never-run maintenance is also reported after the authorization grace period');
});
