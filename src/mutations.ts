import { createHash, randomUUID } from 'node:crypto';
import { StateDocument } from './state.ts';

export const failure = code => Object.assign(new Error(code), { code });
export const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// Fence an uncertain remote write instead of pretending it is safe to repeat.
// Completed receipts survive 30 days; callers must retain their returned URLs.
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
  async run(clientId: string, account: string, requestId: string, input: unknown, work: () => Promise<any>): Promise<any> {
    const key = this.key(clientId, account, requestId);
    const fingerprint = digest(JSON.stringify(canonical(input)));
    const attempt = randomUUID();
    const now = this.now();
    const cached = await this.state.update(doc => {
      const prior = doc.records[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw failure('request_id_reused_with_different_input');
        if (prior.phase === 'done') return { result: prior.result };
        throw failure(prior.phase === 'running' && now - prior.started < 300_000 ? 'write_in_progress_check_before_retry' : 'write_outcome_unknown_reconcile_target');
      }
      if (Object.keys(doc.records).length >= 256) throw failure('write_receipt_capacity_reached');
      doc.records[key] = { fingerprint, attempt, phase: 'running', started: now, expires: now + 30 * 86400_000 };
      return null;
    });
    if (cached) return { ...cached.result, replayed: true };
    let result;
    try {
      result = await work();
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw failure('write_result_too_large_reconcile_target');
    } catch (error) {
      await this.state.update(doc => { if (doc.records[key]?.attempt === attempt) doc.records[key].phase = 'uncertain'; }).catch(() => {});
      throw error;
    }
    try {
      await this.state.update(doc => {
        if (doc.records[key]?.attempt !== attempt) throw failure('write_receipt_conflict');
        Object.assign(doc.records[key], { phase: 'done', result });
      });
    } catch {
      const record = (await this.state.read()).records[key];
      if (record?.phase !== 'done' || record.attempt !== attempt) throw failure('write_outcome_unknown_reconcile_target');
    }
    return result;
  }
  async cleanup() {
    return this.state.update(doc => {
      let removed = 0;
      for (const [key, record] of Object.entries(doc.records)) if (record.expires < this.now()) { delete doc.records[key]; removed++; }
      return { removed };
    });
  }
}
