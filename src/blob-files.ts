import { del, get, list, put } from '@vercel/blob';
import { isConditionalConflict } from './blob-errors.ts';
import { countStateOperation as count, STATE_RETRY_SECONDS, StateUnavailable, type StorageBackend, type StoredValue } from './state.ts';

// Private Blob contains encrypted file chunks only. State is never stored here.
export class BlobFilesBackend implements StorageBackend {
  private pending = new Map<string, Promise<StoredValue | null>>();
  private unavailableUntil = 0;
  private io: { get: typeof get; put: typeof put; now: () => number };
  constructor(io: { get: typeof get; put: typeof put; now: () => number } = { get, put, now: Date.now }) { this.io = io; }

  private filePath(path: string, prefix = false) {
    const pattern = prefix ? /^generations\/[a-z0-9][a-z0-9-]{0,63}\/temporary-uploads\/v1\/(?:[A-Za-z0-9_-]{43}\/)?$/ : /^generations\/[a-z0-9][a-z0-9-]{0,63}\/temporary-uploads\/v1\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/;
    if (!pattern.test(path)) throw new Error('Blob accepts temporary file paths only');
  }

  private checkAvailable() {
    if (this.io.now() < this.unavailableUntil) {
      count('blocked');
      throw new StateUnavailable('File storage is temporarily unavailable');
    }
  }

  private unavailable(): StateUnavailable {
    this.unavailableUntil = this.io.now() + STATE_RETRY_SECONDS * 1000;
    return new StateUnavailable('File storage is temporarily unavailable');
  }

  async read(path: string): Promise<StoredValue | null> {
    this.filePath(path);
    this.checkAvailable();
    // Coalesce overlapping downloads, but do not retain completed file snapshots.
    let pending = this.pending.get(path);
    if (!pending) {
      pending = this.fetchFile(path);
      this.pending.set(path, pending);
    } else count('coalesced');
    try { return await pending; }
    finally { if (this.pending.get(path) === pending) this.pending.delete(path); }
  }

  private async fetchFile(path: string): Promise<StoredValue | null> {
    try {
      count('reads');
      const blob = await this.io.get(path, { access: 'private', useCache: false,
        headers: { 'accept-encoding': 'identity' }, abortSignal: AbortSignal.timeout(15_000) });
      if (!blob) return null;
      if (blob.statusCode !== 200 || !blob.blob.etag || blob.blob.size > 1_048_576) throw new StateUnavailable('Invalid file response');
      return { etag: blob.blob.etag, body: await new Response(blob.stream).text() };
    } catch { throw this.unavailable(); }
  }

  async compareExchange(path: string, expected: string | null, body: string) {
    this.filePath(path);
    if (Buffer.byteLength(body) > 1_048_576) throw new StateUnavailable('File chunk capacity exceeded');
    this.checkAvailable();
    this.pending.delete(path);
    try {
      count('writes');
      await this.io.put(path, body, {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        ...(expected ? { ifMatch: expected } : { allowOverwrite: false }),
        abortSignal: AbortSignal.timeout(15_000),
      });
      return true;
    } catch (error) {
      if (isConditionalConflict(error)) return false;
      // A failed exclusive create can be a race with another initializer. No
      // mutation was applied to an existing document; retry from that document.
      if (expected === null && await this.read(path)) return false;
      throw this.unavailable();
    } finally { this.pending.delete(path); }
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) this.filePath(path);
    this.checkAvailable();
    for (const path of paths) this.pending.delete(path);
    try { if (paths.length) await del(paths, { abortSignal: AbortSignal.timeout(15_000) }); }
    catch { throw this.unavailable(); }
  }

  async list(prefix: string): Promise<string[]> {
    this.filePath(prefix, true);
    this.checkAvailable();
    try {
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000, abortSignal: AbortSignal.timeout(15_000) });
        paths.push(...page.blobs.map(blob => blob.pathname));
        if (paths.length > 8192) throw new Error('Object limit exceeded');
        if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new Error('Invalid storage listing');
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return paths.sort();
    } catch { throw this.unavailable(); }
  }
}
