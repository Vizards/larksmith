import type { StateDocument, StateValue } from './state.ts';
import { errors } from 'oidc-provider';

export const IDLE_SECONDS = 10 * 365 * 24 * 60 * 60;
const epoch = () => Math.floor(Date.now() / 1000);
const live = (record, now) => record && (!record.until || record.until > now);

export function createOAuthAdapter(state: StateDocument, clock = epoch) {
  const key = (model, id) => `${model}:${state.identifier(String(id))}`;
  function prune(doc: StateValue, now: number) {
    for (const [id, record] of Object.entries(doc.records)) if (!live(record, now)) delete doc.records[id];
    doc.revoked ||= {};
    for (const [id, until] of Object.entries(doc.revoked as Record<string, number>)) if (until <= now) delete doc.revoked[id];
  }
  function revoke(doc: StateValue, grantId: string, now: number) {
    doc.revoked ||= {};
    doc.revoked[key('Grant', grantId)] = now + IDLE_SECONDS;
    for (const [id, record] of Object.entries(doc.records)) {
      if (id === key('Grant', grantId) || record.payload.grantId === grantId) delete doc.records[id];
    }
  }

  return class OAuthAdapter {
    model: string;
    constructor(model) { this.model = model; }
    async upsert(id, payload, expiresIn) {
      const now = clock();
      await state.update(doc => {
        prune(doc, now);
        const recordKey = key(this.model, id);
        if (doc.revoked[recordKey] || (payload.grantId && doc.revoked[key('Grant', payload.grantId)])) throw new errors.InvalidGrant('grant revoked');
        const old = doc.records[recordKey];
        if (this.model === 'ReplayDetection' && live(old, now)) throw new errors.InvalidClientAuth('client assertion already used');
        if (this.model === 'Client' && !old && Object.keys(doc.records).filter(k => k.startsWith('Client:')).length >= 32) throw new errors.InvalidClientMetadata('client limit reached');
        if (this.model === 'Interaction' && !old && Object.keys(doc.records).filter(k => k.startsWith('Interaction:')).length >= 64) throw new errors.TemporarilyUnavailable('too many pending logins');
        doc.records[recordKey] = {
          model: this.model,
          payload: structuredClone({ ...payload, ...(old?.payload.consumed ? { consumed: old.payload.consumed } : {}) }),
          until: expiresIn ? now + expiresIn : null,
        };
      });
    }
    async find(id) {
      if (this.model === 'Grant' && state.backend.readGrant) {
        const record = await state.readGrant(key(this.model, id));
        return live(record, clock()) ? structuredClone(record.payload) : undefined;
      }
      const doc = await state.read();
      const recordKey = key(this.model, id);
      const record = doc.records[recordKey];
      if (!live(record, clock()) || doc.revoked?.[recordKey] || doc.revoked?.[key('Grant', record.payload.grantId)]) return undefined;
      return structuredClone(record.payload);
    }
    async findByUid(uid) {
      const doc = await state.read();
      const match = Object.values(doc.records).find(r => r.model === this.model && r.payload.uid === uid && live(r, clock()));
      return match && structuredClone(match.payload);
    }
    async findByUserCode() { return undefined; } // Device grant is disabled.
    async consume(id) {
      const now = clock();
      const accepted = await state.update(doc => {
        prune(doc, now);
        const record = doc.records[key(this.model, id)];
        if (!live(record, now)) return false;
        if (record.payload.consumed) {
          if (record.payload.grantId) revoke(doc, record.payload.grantId, now);
          return false;
        }
        const grantId = record.payload.grantId;
        if (grantId && (!live(doc.records[key('Grant', grantId)], now) || doc.revoked[key('Grant', grantId)])) return false;
        record.payload.consumed = now;
        if (this.model === 'RefreshToken' && grantId) {
          const grant = doc.records[key('Grant', grantId)];
          grant.until = now + IDLE_SECONDS;
          grant.payload.exp = now + IDLE_SECONDS;
        }
        return true;
      });
      if (!accepted) throw new errors.InvalidGrant('token already used, expired or revoked');
    }
    async destroy(id) {
      await state.update(doc => {
        prune(doc, clock());
        if (this.model === 'Grant') revoke(doc, id, clock());
        else delete doc.records[key(this.model, id)];
      });
    }
    async revokeByGrantId(id) {
      await state.update(doc => { prune(doc, clock()); revoke(doc, id, clock()); });
    }
  };
}
