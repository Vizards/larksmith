import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadAccountsConfig } from './accounts.ts';
import { StateDocument, type StateBackend } from './state.ts';

// The official CLI v1.0.95 uses these endpoints in internal/auth/device_flow.go.
const DEVICE = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const TOKEN = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const REFRESH = 'https://accounts.feishu.cn/oauth/v3/token';
const USER = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const DAY = 86400000;
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : undefined;

export class FeishuAuthError extends Error {
  code: string;
  constructor(code) { super(code); this.code = code; }
}

export class FeishuAccounts {
  fetcher: typeof fetch;
  clock: () => number;
  secrets: Record<string, string | undefined>;
  config: Record<string, { appId: string; expectedOpenId: string; label: string; scopes: string[]; brand?: string }>;
  pause: (ms: number) => Promise<unknown>;
  states: Record<string, StateDocument>;
  constructor({ master, backend, fetcher = fetch, clock = Date.now, pause = sleep, secrets = process.env, config = loadAccountsConfig(secrets) as FeishuAccounts['config'] }: { master: string; backend: StateBackend; fetcher?: typeof fetch; clock?: () => number; pause?: (ms: number) => Promise<unknown>; secrets?: Record<string, string | undefined>; config?: FeishuAccounts['config'] }) {
    this.fetcher = fetcher; this.clock = clock; this.secrets = secrets; this.config = config;
    this.pause = pause;
    this.states = Object.fromEntries(Object.keys(config).map(account => [account, new StateDocument({ master, backend, name: `feishu-${account}` })]));
  }
  account(account) {
    if (!Object.hasOwn(this.config, account)) throw new FeishuAuthError('unknown_account');
    const config = this.config[account];
    const secret = this.secrets[`FEISHU_${account.toUpperCase().replaceAll('-', '_')}_APP_SECRET`];
    if (!secret) throw new FeishuAuthError('application_not_configured');
    return { config, secret, state: this.states[account] };
  }
  async json(url, init) {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (text.length > 1_048_576) throw new FeishuAuthError('invalid_upstream_response');
    let data;
    try { data = JSON.parse(text); } catch { throw new FeishuAuthError('invalid_upstream_response'); }
    return { status: response.status, data };
  }
  async status(account) {
    const { config, state } = this.account(account);
    const doc = await state.read();
    const candidate = doc.refresh?.candidate;
    const token = candidate || doc.token;
    const uncertain = doc.refresh?.uncertain || (doc.refresh && !candidate && doc.refresh.deadline <= this.clock());
    const needsAuthorization = !token || Boolean(uncertain) || token.refreshExpiresAt <= this.clock();
    const warnings: string[] = [];
    if (needsAuthorization) warnings.push('user_authorization_required');
    if (candidate && !uncertain) warnings.push('identity_verification_pending');
    if (token?.refreshExpiresAt < this.clock() + 2 * DAY) warnings.push('refresh_window_under_48_hours');
    if (token?.authorizedAt && token.authorizedAt + 365 * DAY < this.clock() + 30 * DAY) warnings.push('annual_reauthorization_due_soon');
    if (doc.maintenance?.error) warnings.push(doc.maintenance.error);
    const lastMaintenance = Date.parse(doc.maintenance?.lastSuccessAt || '');
    const maintenanceBaseline = Number.isFinite(lastMaintenance) ? lastMaintenance : token?.authorizedAt;
    if (maintenanceBaseline && maintenanceBaseline < this.clock() - 2 * DAY) warnings.push('daily_maintenance_overdue');
    return { account, label: config.label, identity: 'user', connected: Boolean(doc.token?.verifiedAt && !candidate && !needsAuthorization),
      needsAuthorization,
      grantedScopeCount: doc.token?.scopes.length || 0, openId: doc.token?.openId,
      refreshCount: doc.token?.refreshCount || 0,
      accessExpiresAt: doc.token ? new Date(doc.token.expiresAt).toISOString() : undefined,
      refreshExpiresAt: doc.token ? new Date(doc.token.refreshExpiresAt).toISOString() : undefined,
      authorizedAt: iso(token?.authorizedAt), annualReauthorizationAt: token?.authorizedAt ? iso(token.authorizedAt + 365 * DAY) : undefined,
      authorizationAgeKnown: Boolean(token?.authorizedAt), lastRefreshedAt: iso(doc.token?.refreshedAt),
      refreshPhase: uncertain ? 'authorization_required' : candidate ? 'verifying_identity' : doc.refresh ? 'requesting' : 'idle',
      maintenance: doc.maintenance, warnings,
      pending: Boolean(doc.pending && doc.pending.expiresAt > this.clock()) };
  }
  pendingView(account, pending) {
    return { account, status: 'authorization_pending', verificationUrl: pending.url, userCode: pending.userCode,
      expiresAt: new Date(pending.expiresAt).toISOString(), retryAfterSeconds: pending.interval,
      instruction: `Open the verification URL and sign in as ${this.config[account].label}. Complete only after the user confirms authorization.` };
  }
  async begin(account) {
    const { config, secret, state } = this.account(account);
    const existing = (await state.read()).pending;
    if (existing?.expiresAt > this.clock()) return this.pendingView(account, existing);
    const { status, data } = await this.json(DEVICE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${config.appId}:${secret}`).toString('base64')}` }, body: new URLSearchParams({ client_id: config.appId, scope: config.scopes.join(' ') }) });
    if (status !== 200 || !data.device_code || data.error) throw new FeishuAuthError('device_authorization_failed');
    const url = new URL(data.verification_uri_complete || data.verification_uri);
    if (url.origin !== 'https://accounts.feishu.cn' || url.username || url.password) throw new FeishuAuthError('unexpected_authorization_origin');
    const pending = { id: randomUUID(), deviceCode: data.device_code, url: url.href, userCode: data.user_code,
      expiresAt: this.clock() + (Number(data.expires_in) || 240) * 1000, interval: Math.max(5, Number(data.interval) || 5), nextPollAt: this.clock() + 5000 };
    pending.nextPollAt = this.clock() + pending.interval * 1000;
    const selected = await state.update(doc => {
      if (doc.pending?.expiresAt > this.clock()) return doc.pending;
      doc.pending = pending;
      return pending;
    });
    return this.pendingView(account, selected);
  }
  async checkedToken(account, data, previous = undefined) {
    const token = this.tokenCandidate(account, data, previous);
    await this.verifyIdentity(account, token);
    return { ...token, verifiedAt: this.clock() };
  }
  tokenCandidate(account, data, previous) {
    const { config } = this.account(account);
    if (!data.access_token || !data.refresh_token || !(Number(data.expires_in) > 0) || !(Number(data.refresh_token_expires_in) > 0)) throw new FeishuAuthError('incomplete_user_grant');
    return { generation: randomUUID(), appId: config.appId, openId: config.expectedOpenId,
      accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: this.clock() + Number(data.expires_in) * 1000,
      refreshExpiresAt: this.clock() + Number(data.refresh_token_expires_in) * 1000,
      scopes: typeof data.scope === 'string' && data.scope ? data.scope.split(' ') : previous?.scopes || [],
      authorizedAt: previous ? previous.authorizedAt ?? null : this.clock(),
      refreshCount: previous ? (previous.refreshCount || 0) + 1 : 0, refreshedAt: this.clock() };
  }
  async verifyIdentity(account, token) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const identity = await this.json(USER, { headers: { Authorization: `Bearer ${token.accessToken}` } });
        if (identity.status === 200 && identity.data.code === 0) {
          if (identity.data.data?.open_id !== this.config[account].expectedOpenId) throw new FeishuAuthError('user_identity_mismatch');
          return;
        }
      } catch (error) { if (error.code === 'user_identity_mismatch') throw error; }
      if (attempt < 2) await this.pause(250 * (attempt + 1));
    }
    throw new FeishuAuthError('identity_verification_pending');
  }
  async complete(account) {
    const { config, secret, state } = this.account(account);
    const pending = await state.update(doc => {
      if (!doc.pending || doc.pending.expiresAt <= this.clock()) throw new FeishuAuthError('start_authorization_again');
      if (doc.pending.nextPollAt > this.clock()) throw new FeishuAuthError('wait_before_polling');
      doc.pending.nextPollAt = this.clock() + doc.pending.interval * 1000;
      return structuredClone(doc.pending);
    });
    const { status, data } = await this.json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.deviceCode, client_id: config.appId, client_secret: secret }) });
    if (data.error === 'slow_down') {
      const slower = await state.update(doc => {
        if (doc.pending?.id !== pending.id) throw new FeishuAuthError('authorization_changed');
        doc.pending.interval = Math.min(60, doc.pending.interval + 5);
        doc.pending.nextPollAt = this.clock() + doc.pending.interval * 1000;
        return doc.pending;
      });
      return this.pendingView(account, slower);
    }
    if (data.error === 'authorization_pending') return this.pendingView(account, pending);
    if (status !== 200 || data.error) throw new FeishuAuthError('authorization_not_completed');
    const token = await this.checkedToken(account, data);
    await state.update(doc => {
      if (doc.pending?.id !== pending.id) throw new FeishuAuthError('authorization_changed');
      doc.token = token;
      delete doc.pending;
      delete doc.refresh;
    });
    return this.status(account);
  }
  async refresh(account, expectedAccessExpiresAt) {
    if (typeof expectedAccessExpiresAt !== 'string' || !Number.isFinite(Date.parse(expectedAccessExpiresAt))) throw new FeishuAuthError('expected_access_expiry_required');
    const { state } = this.account(account);
    const { token } = await state.read();
    if (!token) throw new FeishuAuthError('user_authorization_required');
    // A repeated operator/client request must not rotate a newer generation.
    if (token.expiresAt === Date.parse(expectedAccessExpiresAt)) await this.userToken(account, { refreshGeneration: token.generation });
    return this.status(account);
  }
  // Retrying a local commit never repeats the upstream one-time refresh.
  // A write whose response was lost is reconciled by its candidate generation.
  async persist(state, mutate, settled) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await state.update(mutate); }
      catch (error) {
        if (error instanceof FeishuAuthError) throw error;
        try { const result = settled(await state.read()); if (result) return result; } catch { /* Retry the same commit. */ }
        if (attempt < 2) await this.pause(250 * (attempt + 1));
      }
    }
    throw new FeishuAuthError('refresh_storage_pending');
  }
  async recoverCandidate(account, snapshot) {
    const { state } = this.account(account);
    const { id, candidate } = snapshot;
    if (candidate.expiresAt <= this.clock()) {
      // A profile-service outage can outlast the access token. Its encrypted
      // refresh token is still recoverable: rotate it under the normal lease,
      // then verify the new access token before allowing ANY business call.
      await state.update(doc => {
        if (doc.refresh?.id === id && doc.refresh.candidate?.generation === candidate.generation && !doc.refresh.uncertain) {
          doc.token = candidate; // verifiedAt is deliberately absent.
          delete doc.refresh;
        }
      });
      return this.userToken(account);
    }
    try { await this.verifyIdentity(account, candidate); }
    catch (error) {
      if (error.code === 'user_identity_mismatch') await state.update(doc => { if (doc.refresh?.id === id) { doc.refresh.uncertain = true; doc.refresh.reason = error.code; } });
      throw error;
    }
    const token = { ...candidate, verifiedAt: this.clock() };
    return this.persist(state, doc => {
      if (doc.token?.generation === token.generation) return doc.token;
      if (doc.refresh?.id !== id || doc.refresh.candidate?.generation !== token.generation) throw new FeishuAuthError('refresh_generation_changed');
      doc.token = token;
      delete doc.refresh;
      return token;
    }, doc => doc.token?.generation === token.generation && doc.token);
  }
  async userToken(account, { refreshGeneration }: { refreshGeneration?: string } = {}) {
    const { config, secret, state } = this.account(account);
    const initial = await state.read();
    if (initial.refresh?.uncertain) throw new FeishuAuthError('user_authorization_required');
    if (initial.refresh?.candidate) return this.recoverCandidate(account, initial.refresh);
    if (!initial.token || initial.token.refreshExpiresAt <= this.clock()) throw new FeishuAuthError('user_authorization_required');
    const needsRefresh = token => !token.verifiedAt || token.expiresAt <= this.clock() + 120000 || token.generation === refreshGeneration;
    if (!needsRefresh(initial.token) && !initial.refresh && initial.token.verifiedAt) return initial.token;
    const leaseId = randomUUID();
    const acquired = await this.persist(state, doc => {
      if (doc.refresh?.uncertain) return { authorizationRequired: true };
      if (doc.refresh?.candidate) return { recover: structuredClone(doc.refresh) };
      if (!doc.token || doc.token.refreshExpiresAt <= this.clock()) return { authorizationRequired: true };
      if (doc.refresh?.id === leaseId) return { source: structuredClone(doc.token) };
      if (doc.refresh) {
        if (doc.refresh.deadline <= this.clock()) doc.refresh.uncertain = true;
        return { authorizationRequired: Boolean(doc.refresh.uncertain), busy: true };
      }
      if (!needsRefresh(doc.token)) return { current: doc.token };
      doc.refresh = { id: leaseId, generation: doc.token.generation, deadline: this.clock() + 240000 };
      return { source: structuredClone(doc.token) };
    }, doc => doc.refresh?.id === leaseId && !doc.refresh.uncertain && { source: structuredClone(doc.token) });
    if (acquired.current) return acquired.current;
    if (acquired.recover) return this.recoverCandidate(account, acquired.recover);
    if (acquired.authorizationRequired) throw new FeishuAuthError('user_authorization_required');
    if (acquired.busy) throw new FeishuAuthError('user_refresh_in_progress');
    let candidate;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { status, data } = await this.json(REFRESH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acquired.source.refreshToken, client_id: config.appId, client_secret: secret }) });
        if (status === 200 && !data.error && (!data.code || data.code === 0)) {
          candidate = this.tokenCandidate(account, data, acquired.source);
          break;
        }
        // Only documented explicit non-success responses are safe to retry.
        // Network loss, malformed replies and a bare HTTP 5xx are ambiguous.
        const code = Number(data.code);
        if ([20050, 20072].includes(code) && attempt < 2) { await this.pause(500 * (attempt + 1)); continue; }
        if (Number.isInteger(code) && code > 0) {
          await state.update(doc => {
            if (doc.refresh?.id !== leaseId) return;
            if ([20037, 20064, 20073].includes(code)) { doc.refresh.uncertain = true; doc.refresh.reason = `feishu_${code}`; }
            else delete doc.refresh;
          });
          throw new FeishuAuthError([20037, 20064, 20073].includes(code) ? 'user_authorization_required' : 'user_refresh_rejected');
        }
        throw new FeishuAuthError('refresh_outcome_uncertain');
      }
    } catch (error) {
      if (!['user_refresh_rejected', 'user_authorization_required'].includes(error.code)) {
        await state.update(doc => { if (doc.refresh?.id === leaseId) { doc.refresh.uncertain = true; doc.refresh.reason = 'refresh_outcome_uncertain'; } });
      }
      throw error instanceof FeishuAuthError ? error : new FeishuAuthError('refresh_outcome_uncertain');
    }
    const snapshot = await this.persist(state, doc => {
      if (doc.token?.generation === candidate.generation) return { committed: doc.token };
      if (doc.refresh?.id !== leaseId || doc.token?.generation !== acquired.source.generation) throw new FeishuAuthError('refresh_generation_changed');
      doc.refresh.candidate = candidate;
      return structuredClone(doc.refresh);
    }, doc => doc.token?.generation === candidate.generation ? { committed: doc.token } : doc.refresh?.candidate?.generation === candidate.generation && structuredClone(doc.refresh));
    return snapshot.committed || this.recoverCandidate(account, snapshot);
  }
  async maintain(account) {
    const { state } = this.account(account);
    const started = this.clock();
    let outcome;
    try {
      const doc = await state.read();
      const token = doc.token;
      if (!doc.refresh && token && token.refreshExpiresAt > this.clock() + 2 * DAY && (token.refreshedAt || token.verifiedAt) > this.clock() - 20 * 3600000) outcome = 'recent_refresh_reused';
      else {
        for (let attempt = 0; attempt < 4; attempt++) {
          try { await this.userToken(account, { refreshGeneration: token?.generation }); break; }
          catch (error) {
            if (error.code !== 'user_refresh_in_progress') throw error;
            if (attempt < 3) { await this.pause(500 * (attempt + 1)); continue; }
            // Another live request owns the refresh. This is normal contention,
            // not a lost consent or a failed keepalive. The next run reconciles.
            await state.update(doc => { doc.maintenance = { ...doc.maintenance, lastAttemptAt: iso(started), outcome: 'refresh_in_progress' }; });
            return { ok: true, deferred: true, ...await this.status(account) };
          }
        }
        outcome = 'refreshed_or_recovered';
      }
      await state.update(doc => { doc.maintenance = { lastAttemptAt: iso(started), lastSuccessAt: iso(this.clock()), outcome, consecutiveFailures: 0 }; });
      return { ok: true, ...await this.status(account) };
    } catch (error) {
      const code = error instanceof FeishuAuthError ? error.code : 'state_unavailable';
      try { await state.update(doc => { doc.maintenance = { ...doc.maintenance, lastAttemptAt: iso(started), error: code, consecutiveFailures: (doc.maintenance?.consecutiveFailures || 0) + 1 }; }); } catch { /* Report storage outage without hiding it. */ }
      return { ok: false, account, error: code };
    }
  }
  async maintainAll() {
    const results = await Promise.all(Object.keys(this.config).map(account => this.maintain(account)));
    return { ok: results.every(result => result.ok), checkedAt: iso(this.clock()), accounts: results };
  }
}
