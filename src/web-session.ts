import { randomUUID } from 'node:crypto';
import { StateDocument, type StateBackend } from './state.ts';
import { MessageLinkError, type MessageLinkSession } from './message-links.ts';

const PASSPORT = 'https://login.feishu.cn';
const INTERVAL = 20 * 60 * 60 * 1000; // Fits the existing daily Hobby cron.
const BACKOFF = 6 * 60 * 60 * 1000;
const LEASE = 90_000;
const error = (code: string): never => { throw new MessageLinkError(code); };
const iso = (time?: number) => time ? new Date(time).toISOString() : undefined;
type Session = { cookie: string; userId: string; seed: string; generation: number; verifiedAt: number; rotatedAt?: number };
type Options = { master: string; backend: StateBackend; accounts: string[]; secrets?: Record<string, string | undefined>;
  fetcher?: typeof fetch; clock?: () => number };

// This is the web client's heartbeat, not OpenAPI OAuth refresh. Its observed
// success response does not disclose an extended session expiry. We report
// verified activity separately from actual cookie rotation.
export class WebSessions {
  private states: Record<string, StateDocument>;
  private secrets: Record<string, string | undefined>;
  private fetcher: typeof fetch;
  private clock: () => number;
  constructor(options: Options) {
    this.secrets = options.secrets ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.states = Object.fromEntries(options.accounts.map(account => {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(account)) return error('invalid_account');
      return [account, new StateDocument({ master: options.master, backend: options.backend, name: `feishu-web-${account}` })];
    }));
  }
  private configuration(account: string) {
    const state = this.states[account];
    if (!state) return error('invalid_account');
    const prefix = `FEISHU_${account.toUpperCase().replaceAll('-', '_')}_WEB_`;
    const cookie = this.secrets[prefix + 'COOKIE'];
    if (!cookie) return undefined;
    // Deliberately accept only the one credential proved necessary. A whole
    // browser cookie jar may contain other accounts and is never persisted.
    const userId = this.secrets[prefix + 'USER_ID'];
    if (!/^session=[A-Za-z0-9._~+/%=-]{1,4096}$/.test(cookie) || !userId || !/^\d{1,20}$/.test(userId)) return error('invalid_web_session_configuration');
    return { state, cookie, userId, seed: state.identifier(`${userId}\n${cookie}`) };
  }
  private async json(path: string, cookie: string, signal: AbortSignal, csrf?: string) {
    const post = path !== '/accounts/web/user?support_anonymous=0';
    const response = await this.fetcher(PASSPORT + path, { method: post ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Cookie: cookie, 'Content-Type': 'application/json;charset=UTF-8', 'X-App-Id': '1',
        'X-Terminal-Type': '2', 'X-Api-Version': '1.0.28', 'X-Device-Info': 'platform=websdk',
        ...(csrf ? { 'X-Csrf-Token': csrf } : {}) } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return error(response.status === 401 ? 'web_session_expired' : response.status === 403 ? 'web_session_rejected' :
        response.status === 429 ? 'web_session_rate_limited' : 'web_session_upstream_unavailable');
    }
    if (!response.body) return error('web_session_protocol_changed');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > 65536) return error('web_session_protocol_changed'); chunks.push(value);
    } } finally { await reader.cancel().catch(() => {}); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return error('web_session_protocol_changed'); }
    if (body.code !== 0) return error('web_session_rejected');
    return { data: body.data, cookies: response.headers.getSetCookie() };
  }
  private cookie(headers: string[], name: string, httpOnly: boolean): string | undefined {
    const matches = headers.filter(header => header.startsWith(name + '='));
    if (!matches.length) return undefined;
    if (matches.length !== 1) return error('web_session_invalid_rotation');
    const [pair, ...attributes] = matches[0].split(';').map(part => part.trim());
    const value = pair.slice(name.length + 1);
    const flags = new Map(attributes.map(attribute => { const index = attribute.indexOf('=');
      return [attribute.slice(0, index < 0 ? undefined : index).toLowerCase(), index < 0 ? '' : attribute.slice(index + 1)]; }));
    const domain = flags.get('domain')?.replace(/^\./, '').toLowerCase();
    if (!/^[A-Za-z0-9._~+/%=-]{1,4096}$/.test(value) || domain !== 'feishu.cn' || flags.get('path') !== '/' ||
      !flags.has('secure') || (httpOnly && !flags.has('httponly'))) return error('web_session_invalid_rotation');
    if (httpOnly && !flags.has('max-age') && !flags.has('expires')) return error('web_session_invalid_rotation');
    if (flags.has('max-age') && (!/^\d+$/.test(flags.get('max-age')!) || Number(flags.get('max-age')) <= 0)) return error('web_session_expired');
    if (!flags.has('max-age') && flags.has('expires') && !(Date.parse(flags.get('expires')!) > this.clock())) return error('web_session_expired');
    return value;
  }
  async status(account: string) {
    const config = this.configuration(account);
    if (!config) return { account, configured: false };
    const doc = await config.state.read();
    const current = doc.web as Session | undefined;
    const sameSeed = current?.seed === config.seed;
    const uncertain = !!doc.lease && doc.lease.deadline <= this.clock();
    return { account, configured: true, identityPinned: true,
      state: doc.seed === config.seed && (uncertain || doc.blocked) ? 'reauthorization_required' : !sameSeed ? 'not_initialized' : doc.lease ? 'maintaining' : doc.lastError ? 'degraded' : 'healthy',
      generation: sameSeed ? current?.generation : undefined,
      lastVerifiedAt: sameSeed ? iso(current?.verifiedAt) : undefined,
      lastCookieRotationAt: sameSeed ? iso(current?.rotatedAt) : undefined,
      lastAttemptAt: iso(doc.lastAttemptAt), nextCheckAt: iso(doc.nextCheckAt),
      lastError: uncertain ? 'web_session_maintenance_uncertain' : doc.lastError,
      expiryExtensionConfirmed: false, overdue: !!current && current.verifiedAt < this.clock() - 2 * 86400000 };
  }
  async maintain(account: string) {
    const config = this.configuration(account);
    if (!config) return { account, configured: false, ok: true };
    const { state, seed, userId } = config;
    const existing = await state.read();
    // Fast path performs no writes and no upstream calls, including failed
    // attempts in backoff. Business reads cannot make a refresh storm.
    if (existing.seed === seed && (existing.blocked || existing.nextCheckAt > this.clock())) return this.report(account);
    const id = randomUUID();
    let cookie = config.cookie;
    const acquired = await state.update(doc => {
      if (doc.lease) {
        if (doc.lease.deadline > this.clock()) return false;
        if (doc.seed === seed) return error('web_session_maintenance_uncertain');
        // An explicitly replaced bootstrap credential may recover a stalled
        // generation, but only after the old lease has expired.
      }
      if (doc.seed === seed && (doc.blocked || doc.nextCheckAt > this.clock())) return false;
      if (doc.web?.seed === seed) cookie = doc.web.cookie;
      doc.lease = { id, deadline: this.clock() + LEASE }; doc.seed = seed; doc.lastAttemptAt = this.clock();
      return true;
    });
    if (!acquired) return this.report(account);
    const signal = AbortSignal.timeout(30_000);
    let possibleRotation = false, heartbeatAttempted = false;
    try {
      // Verify before activating a new seed or using it for heartbeat.
      if (existing.web?.seed !== seed) {
        const profile = await this.json('/accounts/web/user?support_anonymous=0', cookie, signal);
        if (profile.data?.user?.id !== userId) return error('web_session_identity_mismatch');
        if (profile.cookies.some(value => value.startsWith('session='))) { possibleRotation = true; return error('web_session_unexpected_rotation'); }
      }
      const csrfResponse = await this.json('/accounts/csrf', cookie, signal);
      if (csrfResponse.cookies.some(value => value.startsWith('session='))) { possibleRotation = true; return error('web_session_unexpected_rotation'); }
      const csrf = this.cookie(csrfResponse.cookies, 'swp_csrf_token', false);
      if (!csrf) return error('web_session_protocol_changed');
      heartbeatAttempted = true;
      const heartbeat = await this.json('/accounts/status/heartbeat', `${cookie}; swp_csrf_token=${csrf}`, signal, csrf);
      possibleRotation = heartbeat.cookies.some(value => value.startsWith('session='));
      if (heartbeat.data?.user_id !== userId) return error('web_session_identity_mismatch');
      if (String(heartbeat.data?.auth_result) !== '1') return error('web_session_rejected');
      const rotated = this.cookie(heartbeat.cookies, 'session', true);
      const candidate = rotated ? `session=${rotated}` : cookie;
      // Persist a possible replacement before further I/O. A crash leaves the
      // lease/candidate for operator recovery; it never falls back to the seed.
      if (candidate !== cookie) {
        await state.update(doc => {
          if (doc.lease?.id !== id) return error('web_session_state_changed');
          doc.lease.candidate = candidate;
        });
        const check = await this.json('/accounts/web/user?support_anonymous=0', candidate, signal);
        if (check.data?.user?.id !== userId || check.cookies.some(value => value.startsWith('session='))) return error('web_session_identity_mismatch');
      }
      await state.update(doc => {
        if (doc.lease?.id !== id) return error('web_session_state_changed');
        const previous: Session | undefined = doc.web;
        doc.web = { cookie: candidate, userId, seed, verifiedAt: this.clock(),
          generation: (previous?.generation ?? 0) + (candidate !== previous?.cookie ? 1 : 0),
          rotatedAt: candidate !== cookie ? this.clock() : previous?.rotatedAt } satisfies Session;
        doc.nextCheckAt = this.clock() + INTERVAL;
        delete doc.lease; delete doc.blocked; delete doc.lastError;
      });
    } catch (failure) {
      const code = failure instanceof MessageLinkError ? failure.code : signal.aborted ? 'web_session_timeout' : 'web_session_maintenance_failed';
      // When a rotated credential may have been issued, keep the lease and
      // candidate. Never retry the upstream mutation or resurrect the seed.
      if (possibleRotation || (heartbeatAttempted && !(failure instanceof MessageLinkError))) throw new MessageLinkError(code);
      await state.update(doc => {
        if (doc.lease?.id !== id) return;
        delete doc.lease; doc.lastError = code; doc.nextCheckAt = this.clock() + BACKOFF;
        doc.blocked = ['web_session_expired', 'web_session_rejected', 'web_session_identity_mismatch'].includes(code);
      });
    }
    return this.report(account);
  }
  private async report(account: string) {
    const status = await this.status(account);
    return { ...status, ok: !status.configured || status.state === 'healthy' };
  }
  async session(account: string): Promise<MessageLinkSession | undefined> {
    const config = this.configuration(account);
    if (!config) return undefined;
    const current = await config.state.read();
    if (current.web?.seed === config.seed && current.web.userId === config.userId &&
      !current.lease && !current.blocked && !current.lastError && current.nextCheckAt > this.clock()) return { cookie: current.web.cookie };
    const report = await this.maintain(account);
    if (!report.ok) return error('lastError' in report && report.lastError ? report.lastError : 'web_session_maintenance_pending');
    const doc = await config.state.read();
    if (doc.lease || doc.blocked || doc.web?.seed !== config.seed || doc.web.userId !== config.userId) return error('web_session_not_verified');
    return { cookie: doc.web.cookie };
  }
  async rejected(account: string, session: MessageLinkSession) {
    const config = this.configuration(account);
    if (!config) return;
    await config.state.update(doc => {
      // A delayed failure for an old generation cannot revoke a newer cookie.
      if (doc.web?.seed === config.seed && doc.web.cookie === session.cookie) {
        doc.blocked = true; doc.lastError = 'web_session_expired';
      }
    });
  }
  async maintainAll() {
    const reports: object[] = []; let ok = true;
    for (const account of Object.keys(this.states)) {
      try { const report = await this.maintain(account); reports.push(report); ok &&= report.ok; }
      catch (failure) { ok = false; reports.push({ account, ok: false, error: failure instanceof MessageLinkError ? failure.code : 'web_session_state_unavailable' }); }
    }
    return { ok, accounts: reports };
  }
}
