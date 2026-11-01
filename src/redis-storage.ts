import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { REDIS_KEY_PREFIX } from './protocol.ts';
import { countStateOperation as count, deriveKey, seal, unseal, STATE_RETRY_SECONDS, StateUnavailable, type StorageBackend, type StoredValue } from './state.ts';

// EVAL (never EVAL_RO or no-writes) pins reads to the primary. A per-client
// Read-Your-Writes token is not sufficient across independent Vercel instances.
// https://upstash.com/blog/replicated-cache-backed-by-redis (Step 6).
export const REDIS_READ = "return redis.call('HMGET', KEYS[1], 'revision', 'body')";
export const REDIS_GRANT = "return redis.call('HMGET', KEYS[1], 'revision', ARGV[1])";
export const REDIS_LIST = "return redis.call('SMEMBERS', KEYS[1])";
export const REDIS_CAS = `
local current = redis.call('HGET', KEYS[1], 'revision')
if (current or '') ~= ARGV[1] then return 0 end
local old = redis.call('HKEYS', KEYS[1])
local fields = {'revision', ARGV[2], 'body', ARGV[3]}
local keep = {revision=true, body=true}
for i=5,#ARGV,2 do
  fields[#fields+1] = ARGV[i]
  fields[#fields+1] = ARGV[i+1]
  keep[ARGV[i]] = true
end
-- Index first: a failed write cannot leave an unlisted state object. A dangling
-- index entry remains discoverable for integrity checks.
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('HSET', KEYS[1], unpack(fields))
for _,field in ipairs(old) do
  if not keep[field] then redis.call('HDEL', KEYS[1], field) end
end
return 1`;
export const REDIS_REMOVE = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1`;

export interface RedisConfig { url: string; token: string; master: string }
export interface RedisExecutor { eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> }
const LIMIT = 1_048_576;
const OAUTH_PATH = 'state/v1/oauth.json';

export class RedisBackend implements StorageBackend {
  private client: RedisExecutor;
  private key: Buffer;
  private now: () => number;
  private unavailableUntil = 0;
  private pending = new Map<string, Promise<unknown>>();
  constructor(config: RedisConfig, io?: { client: RedisExecutor; now?: () => number }) {
    let url: URL;
    try { url = new URL(config.url); } catch { throw new Error('Invalid Upstash configuration'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port || !config.token) throw new Error('Invalid Upstash configuration');
    this.key = deriveKey(config.master, 'state:oauth');
    this.now = io?.now ?? Date.now;
    this.client = io?.client ?? new Redis({
      url: config.url, token: config.token, retry: false, automaticDeserialization: false,
      enableAutoPipelining: false, readYourWrites: false, enableTelemetry: false,
      cache: 'no-store', responseEncoding: false, signal: () => AbortSignal.timeout(15_000),
    });
  }
  private location(path: string) {
    const match = /^generations\/([a-z0-9][a-z0-9-]{0,63})\/(state\/v1\/[a-z][a-z0-9-]{0,63}\.json)$/.exec(path);
    if (!match) throw new Error('Redis state requires a generation and a state document path');
    const prefix = `${REDIS_KEY_PREFIX}:{${match[1]}}:`;
    return { object: prefix + match[2], inventory: prefix + 'inventory', logical: match[2] };
  }
  private checkAvailable() {
    if (this.now() < this.unavailableUntil) { count('blocked'); throw new StateUnavailable('State storage is temporarily unavailable'); }
  }
  private unavailable() {
    this.unavailableUntil = this.now() + STATE_RETRY_SECONDS * 1000;
    return new StateUnavailable('State storage is temporarily unavailable');
  }
  private async eval(script: string, keys: string[], args: (string | number)[], operation: 'reads' | 'writes') {
    this.checkAvailable();
    try { count(operation); return await this.client.eval(script, keys, args); }
    catch { throw this.unavailable(); } // No SDK retries or secret-bearing errors.
  }
  private async coalesce<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.checkAvailable();
    let pending = this.pending.get(id);
    if (!pending) { pending = work(); this.pending.set(id, pending); } else count('coalesced');
    try { return await pending as T; }
    finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }
  read(path: string): Promise<StoredValue | null> {
    const target = this.location(path);
    return this.coalesce(path, async () => {
      const values = await this.eval(REDIS_READ, [target.object], [], 'reads');
      if (!Array.isArray(values) || values.length !== 2) throw this.unavailable();
      if (values[0] === null && values[1] === null) return null;
      if (typeof values[0] !== 'string' || !values[0] || typeof values[1] !== 'string' || Buffer.byteLength(values[1]) > LIMIT) throw this.unavailable();
      return { etag: values[0], body: values[1] };
    });
  }
  readGrant(path: string, recordKey: string): Promise<string | null> {
    const target = this.location(path);
    if (target.logical !== OAUTH_PATH || !/^Grant:[A-Za-z0-9_-]{43}$/.test(recordKey)) throw new Error('Invalid Grant lookup');
    return this.coalesce(`${path}#${recordKey}`, async () => {
      const values = await this.eval(REDIS_GRANT, [target.object], [recordKey], 'reads');
      if (!Array.isArray(values) || values.length !== 2) throw this.unavailable();
      if (values[1] === null) return null;
      try {
        const item = JSON.parse(values[1]);
        if (typeof values[0] !== 'string' || item.revision !== values[0] || typeof item.body !== 'string' || Buffer.byteLength(item.body) > LIMIT) throw new Error();
        return item.body;
      } catch { throw this.unavailable(); }
    });
  }
  async compareExchange(path: string, expected: string | null, body: string): Promise<boolean> {
    this.checkAvailable();
    const target = this.location(path);
    if (Buffer.byteLength(body) > LIMIT) throw new StateUnavailable('State capacity exceeded');
    const revision = randomUUID();
    const args = [expected ?? '', revision, body, path];
    // The encrypted full document is retained for atomic mutations.
    // Only current, non-revoked Grants get small projections.
    // One CAS publishes both, so a stale refresh cannot resurrect an index.
    if (target.logical === OAUTH_PATH) {
      const doc = unseal(body, this.key, OAUTH_PATH);
      if (doc.v !== 1 || !doc.records || Array.isArray(doc.records)) throw new StateUnavailable('Invalid OAuth state');
      const entries = Object.entries(doc.records).filter(([id]) => id.startsWith('Grant:'));
      if (entries.length > 1024) throw new StateUnavailable('Grant capacity exceeded');
      for (const [id, record] of entries as [string, any][]) {
        if (!/^Grant:[A-Za-z0-9_-]{43}$/.test(id) || !record.payload || record.model !== 'Grant') throw new StateUnavailable('Invalid Grant state');
        if (doc.revoked?.[id]) continue;
        // Grant payloads do not link to another grant; fail closed if this
        // invariant changes instead of omitting a revocation check.
        if (record.payload.grantId) throw new StateUnavailable('Unexpected nested Grant');
        args.push(id, JSON.stringify({ revision, body: seal(record, this.key, `${OAUTH_PATH}#${id}`) }));
      }
    }
    if (Buffer.byteLength(JSON.stringify(args)) > 4 * LIMIT) throw new StateUnavailable('Redis request capacity exceeded');
    this.pending.clear();
    try {
      const result = await this.eval(REDIS_CAS, [target.object, target.inventory], args, 'writes');
      if (result !== 0 && result !== 1) throw this.unavailable();
      return result === 1;
    } finally { this.pending.clear(); }
  }
  async remove(paths: string[]) {
    for (const path of paths) {
      const target = this.location(path);
      this.pending.clear();
      try { await this.eval(REDIS_REMOVE, [target.object, target.inventory], [path], 'writes'); }
      finally { this.pending.clear(); }
    }
  }
  async list(prefix: string) {
    const match = /^generations\/([a-z0-9][a-z0-9-]{0,63})\/(.*)$/.exec(prefix);
    if (!match) throw new Error('Redis inventory requires a generation');
    const values = await this.eval(REDIS_LIST, [`${REDIS_KEY_PREFIX}:{${match[1]}}:inventory`], [], 'reads');
    if (!Array.isArray(values) || values.length > 8192 || values.some(path => typeof path !== 'string' || !path.startsWith(`generations/${match[1]}/state/v1/`))) throw this.unavailable();
    for (const path of values) this.location(path);
    return values.filter(path => path.startsWith(prefix)).sort() as string[];
  }
}

// Route state exclusively to Redis and encrypted file chunks exclusively to Blob.
export class SplitStorageBackend implements StorageBackend {
  readonly readGrant: NonNullable<StorageBackend['readGrant']>;
  private state: RedisBackend;
  private files: StorageBackend;
  constructor(state: RedisBackend, files: StorageBackend) {
    this.state = state;
    this.files = files;
    this.readGrant = (path, id) => state.readGrant(path, id);
  }
  private select(path: string) {
    if (/^generations\/[^/]+\/state\/v1\//.test(path)) return this.state;
    if (/^generations\/[^/]+\/temporary-uploads\/v1\//.test(path)) return this.files;
    throw new Error('Unsupported storage path');
  }
  read(path: string) { return this.select(path).read(path); }
  compareExchange(path: string, expected: string | null, body: string) { return this.select(path).compareExchange(path, expected, body); }
  async remove(paths: string[]) {
    for (const backend of [this.state, this.files]) await backend.remove(paths.filter(path => this.select(path) === backend));
  }
  async list(prefix: string) {
    const generation = /^generations\/[a-z0-9][a-z0-9-]{0,63}\/$/.test(prefix);
    if (generation) return [...await this.state.list(prefix + 'state/v1/'), ...await this.files.list(prefix + 'temporary-uploads/v1/')].sort();
    return this.select(prefix).list(prefix);
  }
}
