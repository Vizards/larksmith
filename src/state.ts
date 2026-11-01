import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { KEY_DERIVATION_SALT } from './protocol.ts';

export class StateConflict extends Error {}
export class StateUnavailable extends Error {}
export const STATE_RETRY_SECONDS = 60;
export const isStateFailure = (error: unknown): boolean => error instanceof StateUnavailable || error instanceof StateConflict;
export interface StateUsage { reads: number; writes: number; coalesced: number; blocked: number }
const stateUsage = new AsyncLocalStorage<StateUsage>();
export function trackStateUsage<T>(work: (usage: StateUsage) => T): T {
  const usage = { reads: 0, writes: 0, coalesced: 0, blocked: 0 };
  return stateUsage.run(usage, () => work(usage));
}
export function countStateOperation(operation: keyof StateUsage) {
  const usage = stateUsage.getStore();
  if (usage) usage[operation]++;
}
export interface StateValue { v: number; records: Record<string, any>; [key: string]: any }
export interface StoredValue { etag: string; body: string }
export interface StateBackend {
  read(path: string): Promise<StoredValue | null>;
  compareExchange(path: string, expected: string | null, body: string): Promise<boolean>;
  // Optional atomically maintained, encrypted OAuth Grant projection.
  readGrant?(path: string, recordKey: string): Promise<string | null>;
}
export interface StorageBackend extends StateBackend { remove(paths: string[]): Promise<void>; list(prefix: string): Promise<string[]> }
export interface StateOptions { master: string; name: string; backend: StateBackend; retries?: number; delay?: boolean }

export function deriveKey(master: string, purpose: string): Buffer {
  const key = Buffer.from(master, 'base64url');
  if (key.length !== 32) throw new Error('Invalid state key configuration');
  return Buffer.from(hkdfSync('sha256', key, KEY_DERIVATION_SALT, purpose, 32));
}

// No token, key, upstream response, or encrypted document appears in an error.
export function seal(value: unknown, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64url'), data: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
}

export function unseal(encoded: string, key: Buffer, context: string): any {
  try {
    const envelope = JSON.parse(encoded);
    if (envelope.v !== 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    throw new StateUnavailable('State integrity check failed');
  }
}

// Each small state document is one encrypted CAS unit. Keeping the OAuth
// records together makes consume and grant revocation atomic without indices.
export class StateDocument {
  path: string;
  key: Buffer;
  backend: StateBackend;
  retries: number;
  delay: boolean;
  constructor({ master, name, backend, retries = 12, delay = true }: StateOptions) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid state namespace');
    this.path = `state/v1/${name}.json`;
    this.key = deriveKey(master, `state:${name}`);
    if (!backend) throw new Error('State backend is required');
    this.backend = backend;
    this.retries = retries;
    this.delay = delay;
  }

  async read(): Promise<StateValue> {
    const current = await this.backend.read(this.path);
    return current ? unseal(current.body, this.key, this.path) : { v: 1, records: {} };
  }

  async readGrant(recordKey: string) {
    if (!this.backend.readGrant) throw new Error('Grant projection is unavailable');
    const encoded = await this.backend.readGrant(this.path, recordKey);
    return encoded === null ? undefined : unseal(encoded, this.key, `${this.path}#${recordKey}`);
  }

  async update<T>(mutator: (value: StateValue) => T): Promise<T> {
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const current = await this.backend.read(this.path);
      const value: StateValue = current ? unseal(current.body, this.key, this.path) : { v: 1, records: {} };
      const result = mutator(value); // Synchronous: retries cannot repeat I/O.
      if (result instanceof Promise) throw new Error('State mutators must be synchronous');
      const encoded = seal(value, this.key, this.path);
      if (Buffer.byteLength(encoded) > 1_048_576) throw new StateUnavailable('State capacity exceeded');
      if (await this.backend.compareExchange(this.path, current?.etag ?? null, encoded)) return result;
      if (this.delay) await setTimeout(80 + Math.random() * Math.min(500, 50 * (attempt + 1)));
    }
    throw new StateConflict('State is busy; retry later');
  }

  identifier(value) {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}
