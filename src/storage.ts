import { StateUnavailable, type StorageBackend } from './state.ts';
import { BlobFilesBackend } from './blob-files.ts';
import { RedisBackend, SplitStorageBackend } from './redis-storage.ts';

export function storageConfig(env: Record<string, string | undefined> = process.env) {
  if (env.BRIDGE_STORAGE_BACKEND && env.BRIDGE_STORAGE_BACKEND !== 'upstash') throw new Error('Upstash is the only supported state backend');
  const namespace = env.BRIDGE_STORAGE_NAMESPACE || '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) throw new Error('An explicit storage namespace is required');
  return { kind: 'upstash', namespace } as const;
}

// Namespace prefixes isolate installations without changing encryption contexts.
export class NamespacedBackend implements StorageBackend {
  readonly readGrant?: NonNullable<StorageBackend['readGrant']>;
  readonly prefix: string;
  private backend: StorageBackend;
  constructor(backend: StorageBackend, namespace: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) throw new Error('Invalid storage namespace');
    this.backend = backend;
    this.prefix = `generations/${namespace}/`;
    if (backend.readGrant) this.readGrant = (path, id) => backend.readGrant!(this.path(path), id);
  }
  private path(path: string) {
    if (!path || path.startsWith('/') || path.split('/').some(v => v === '..' || v === '.') || /[\\\x00-\x1f]/.test(path)) throw new Error('Invalid object path');
    return this.prefix + path;
  }
  read(path: string) { return this.backend.read(this.path(path)); }
  compareExchange(path: string, expected: string | null, body: string) { return this.backend.compareExchange(this.path(path), expected, body); }
  remove(paths: string[]) { return this.backend.remove(paths.map(path => this.path(path))); }
  async list(prefix: string) {
    const keys = await this.backend.list(prefix ? this.path(prefix) : this.prefix);
    if (keys.some(key => !key.startsWith(this.prefix))) throw new StateUnavailable('Invalid storage listing');
    return keys.map(key => key.slice(this.prefix.length)).sort();
  }
}

export function createStorageBackend(env: Record<string, string | undefined> = process.env): StorageBackend {
  const { namespace } = storageConfig(env);
  return new NamespacedBackend(new SplitStorageBackend(new RedisBackend({
    url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
    token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
    master: env.BRIDGE_STATE_KEY || '',
  }), new BlobFilesBackend()), namespace);
}
