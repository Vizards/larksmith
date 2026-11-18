import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { StateDocument, StateConflict, seal, unseal } from './state.ts';

export const failure = code => Object.assign(new Error(code), { code });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const WRITE_WINDOW_MS = 60 * 60_000;
const FINISH_GRACE_MS = 5 * 60_000;
const timedId = /^w2_(\d{13})_[A-Za-z0-9_-]{8,80}$/;

export function writeRequest(now = Date.now()) {
  return { requestId: `w2_${now}_${randomUUID()}`, expiresAt: new Date(now + WRITE_WINDOW_MS).toISOString(), validForMinutes: 60 };
}

// Public callers carry their original issue time. Once Redis has forgotten a
// receipt, this deadline still prevents a delayed retry from becoming a write.
export function validateWriteRequest(requestId: string, now = Date.now()): number {
  const match = timedId.exec(requestId || '');
  if (!match) throw Object.assign(failure('write_request_id_requires_timestamp'), {
    writeDisposition: 'not_dispatched', suggestedRequest: writeRequest(now),
    instruction: 'This attempt was not dispatched. Old request IDs are no longer accepted. If an earlier attempt may have run, inspect the target first; then use suggestedRequest.requestId for the new action and retain it unchanged for retries.',
  });
  const issued = Number(match[1]);
  if (issued > now + 60_000 || issued + WRITE_WINDOW_MS <= now) throw Object.assign(failure('write_request_expired_or_future_reconcile_target'), {
    writeDisposition: 'not_dispatched', suggestedRequest: writeRequest(now),
    instruction: 'This attempt was not dispatched. The original 60-minute request window is closed or its timestamp is in the future. An earlier attempt may have completed; inspect the target before starting a new action. Never refresh the timestamp of a retry.',
  });
  return issued + WRITE_WINDOW_MS;
}

export function writeErrorDetails(error: any) {
  return { ...(error.writeDisposition ? { writeDisposition: error.writeDisposition } : {}),
    ...(error.suggestedRequest ? { suggestedRequest: error.suggestedRequest } : {}),
    instruction: error.instruction || 'Retain requestId. If a write was dispatched or timed out, inspect the target before using a new ID.' };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export class Mutations {
  state: StateDocument;
  now: () => number;
  constructor({ state, now = Date.now }: { state: StateDocument; now?: () => number }) {
    this.state = state;
    this.now = now;
  }
  key(clientId, account, requestId) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId || '')) throw failure('request_id_required_8_to_128_characters');
    return this.state.identifier(JSON.stringify([clientId, account, requestId]));
  }
  private async update<T>(path: string, expires: number, change: (record: any) => { record: any; result: T; unchanged?: boolean }): Promise<T> {
    for (let attempt = 0; attempt < this.state.retries; attempt++) {
      const current = await this.state.backend.read(path);
      const value = current ? unseal(current.body, this.state.key, path) : undefined;
      const next = change(value);
      if (next.unchanged) return next.result;
      if (await this.state.backend.compareExchange(path, current?.etag ?? null, seal(next.record, this.state.key, path), expires + FINISH_GRACE_MS)) return next.result;
      if (this.state.delay) await setTimeout(40 + Math.random() * 80);
    }
    throw new StateConflict('Write receipt is busy; retry the same request');
  }
  // The transport validates public IDs with validateWriteRequest. Internal
  // consumers may use an opaque ID, but only timed IDs are accepted over MCP.
  async run(clientId: string, account: string, requestId: string, input: unknown, work: () => Promise<any>): Promise<any> {
    const key = this.key(clientId, account, requestId);
    const path = `state/v2/mutations/${key}.json`;
    const expires = timedId.test(requestId) ? validateWriteRequest(requestId, this.now()) : this.now() + WRITE_WINDOW_MS;
    const fingerprint = digest(JSON.stringify(canonical(input)));
    const attempt = randomUUID();
    const cached = await this.update(path, expires, prior => {
      if (this.now() >= expires) throw Object.assign(failure('write_request_expired_or_future_reconcile_target'), { writeDisposition: 'not_dispatched' });
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw failure('request_id_reused_with_different_input');
        if (this.now() >= prior.expires) throw failure('write_request_expired_or_future_reconcile_target');
        if (prior.phase === 'done') return { record: prior, result: { result: prior.result }, unchanged: true };
        throw failure(prior.phase === 'running' && this.now() - prior.started < FINISH_GRACE_MS ? 'write_in_progress_check_before_retry' : 'write_outcome_unknown_reconcile_target');
      }
      return { record: { fingerprint, attempt, phase: 'running', started: this.now(), expires }, result: null };
    });
    if (cached) return { ...cached.result, replayed: true, requestExpiresAt: new Date(expires).toISOString() };
    let result;
    try {
      result = await work();
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw failure('write_result_too_large_reconcile_target');
    } catch (error) {
      await this.update(path, expires, record => {
        if (!record || record.attempt !== attempt) return { record, result: null, unchanged: true };
        return { record: { ...record, phase: 'uncertain' }, result: null };
      }).catch(() => {});
      throw Object.assign(error instanceof Error ? error : failure('write_outcome_unknown_reconcile_target'), { writeDisposition: 'outcome_unknown' });
    }
    try {
      await this.update(path, expires, record => {
        if (!record || record.attempt !== attempt) throw failure('write_receipt_conflict');
        return { record: { ...record, phase: 'done', result }, result: null };
      });
    } catch {
      const saved = await this.state.backend.read(path);
      const record = saved ? unseal(saved.body, this.state.key, path) : undefined;
      if (record?.phase !== 'done' || record.attempt !== attempt) throw failure('write_outcome_unknown_reconcile_target');
    }
    return { ...result, requestExpiresAt: new Date(expires).toISOString() };
  }
  async cleanup() {
    // New per-request records expire in Redis without a daily scan or index.
    return this.state.update(doc => {
      let removed = 0;
      for (const [key, record] of Object.entries(doc.records)) if (record.started + WRITE_WINDOW_MS < this.now()) { delete doc.records[key]; removed++; }
      return { removed, legacyRemaining: Object.keys(doc.records).length, receiptWindowMinutes: 60, storageTtlMinutes: 65 };
    });
  }
}
