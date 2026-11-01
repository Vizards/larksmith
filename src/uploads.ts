import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateDocument, deriveKey, seal, unseal, type StorageBackend } from './state.ts';
import type { Mutations } from './mutations.ts';
import { invoke } from './cli.ts';
import { digest, failure } from './mutations.ts';
import { CHUNK_BYTES, MAX_UPLOAD_BYTES, decodeChunk, downloadInput } from './file-input.ts';

const tokenPattern = /^[A-Za-z0-9_-]{1,256}$/;
export function uploadTarget({ name, folderToken }) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f/\\]/.test(name) || name === '.' || name === '..') throw failure('invalid_upload_name');
  if (folderToken !== undefined && !tokenPattern.test(folderToken)) throw failure('invalid_folder_token');
  return { name, ...(folderToken ? { folderToken } : {}) };
}

export class Uploads {
  state: StateDocument;
  backend: StorageBackend;
  key: Buffer;
  mutations: Mutations;
  remove: (paths: string[]) => Promise<void>;
  now: () => number;
  run: typeof invoke;
  download: typeof downloadInput;
  constructor({ master, mutations, state, backend, remove, now = Date.now, run = invoke, download = downloadInput }: { master: string; mutations: Mutations; state?: StateDocument; backend: StorageBackend; remove?: (paths: string[]) => Promise<void>; now?: () => number; run?: typeof invoke; download?: typeof downloadInput }) {
    this.state = state || new StateDocument({ master, name: 'uploads', backend });
    this.backend = backend;
    this.key = deriveKey(master, 'temporary-upload-chunks');
    this.mutations = mutations;
    this.remove = remove || (paths => backend.remove(paths));
    this.now = now;
    this.run = run;
    this.download = download;
  }
  owner(clientId, account) { return this.state.identifier(JSON.stringify([clientId, account])); }
  record(doc, id, clientId, account) {
    const value = doc.records[id];
    if (!value || value.owner !== this.owner(clientId, account)) throw failure('upload_not_found_for_this_client_and_account');
    if (value.expires <= this.now()) throw failure('upload_expired_start_new_request');
    return value;
  }
  public(id, record) {
    return { uploadId: id, account: record.account, identity: 'user', name: record.target.name, bytes: record.bytes, sha256: record.sha256,
      chunkBytes: CHUNK_BYTES, chunks: Math.ceil(record.bytes / CHUNK_BYTES), stagedIndices: Object.keys(record.parts).map(Number),
      expiresAt: new Date(record.expires).toISOString(), phase: record.result ? 'done' : 'staging', ...(record.result ? { result: record.result } : {}) };
  }
  async begin(clientId, account, { requestId, name, folderToken, bytes, sha256 }) {
    const target = uploadTarget({ name, folderToken });
    this.mutations.key(clientId, account, requestId);
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) throw failure('upload_size_must_be_1_byte_to_32_mib');
    if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw failure('upload_sha256_required');
    const id = this.state.identifier(JSON.stringify([clientId, account, requestId]));
    const fingerprint = digest(JSON.stringify({ target, bytes, sha256 }));
    const record = await this.state.update(doc => {
      if (doc.records[id]) {
        const prior = this.record(doc, id, clientId, account);
        if (prior.fingerprint !== fingerprint) throw failure('request_id_reused_with_different_input');
        return prior;
      }
      const entries = Object.values(doc.records);
      if (entries.length >= 32 || entries.filter(v => !v.result).reduce((sum, v) => sum + v.bytes, 0) + bytes > 96 * 1024 * 1024) throw failure('temporary_upload_capacity_reached_cancel_or_wait_for_cleanup');
      const value = { owner: this.owner(clientId, account), account, requestId, target, bytes, sha256, fingerprint, parts: {}, expires: this.now() + 86400_000 };
      doc.records[id] = value;
      return value;
    });
    return this.public(id, record);
  }
  path(id, index) { return `temporary-uploads/v1/${id}/${index}.json`; }
  async status(clientId, account, id) { return this.public(id, this.record(await this.state.read(), id, clientId, account)); }
  async chunk(clientId, account, { uploadId, index, data }) {
    const bytes = decodeChunk(data);
    const hash = digest(bytes);
    await this.state.update(doc => {
      const entry = this.record(doc, uploadId, clientId, account);
      if (entry.result) throw failure('upload_already_committed');
      if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(entry.bytes / CHUNK_BYTES) || bytes.length !== Math.min(CHUNK_BYTES, entry.bytes - index * CHUNK_BYTES)) throw failure('chunk_index_or_size_mismatch');
      if (entry.parts[index] && entry.parts[index] !== hash) throw failure('chunk_already_reserved_with_different_content');
      entry.parts[index] = hash;
    });
    const path = this.path(uploadId, index);
    let written = false;
    try { written = await this.backend.compareExchange(path, null, seal({ data }, this.key, path)); } catch { /* Reconcile an uncertain object create below. */ }
    if (!written) {
      const existing = await this.backend.read(path);
      if (!existing || digest(Buffer.from(unseal(existing.body, this.key, path).data, 'base64')) !== hash) throw failure('chunk_not_persisted_retry_same_chunk');
    }
    return { uploadId, index, bytes: bytes.length, sha256: hash, accepted: true };
  }
  async assemble(id, record) {
    const count = Math.ceil(record.bytes / CHUNK_BYTES);
    if (Object.keys(record.parts).length !== count) throw failure('upload_missing_chunks');
    const chunks: Buffer[] = [];
    for (let index = 0; index < count; index += 4) {
      chunks.push(...await Promise.all(Array.from({ length: Math.min(4, count - index) }, async (_, offset) => {
        const part = index + offset;
        const path = this.path(id, part);
        const blob = await this.backend.read(path);
        if (!blob) throw failure('upload_missing_chunks_retry_unconfirmed_chunk');
        const bytes = decodeChunk(unseal(blob.body, this.key, path).data);
        if (digest(bytes) !== record.parts[part]) throw failure('upload_chunk_integrity_failed');
        return bytes;
      })));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw failure('upload_size_or_sha256_mismatch');
    return bytes;
  }
  async upload(clientId, account, requestId, target, bytes, getToken) {
    const sha256 = digest(bytes);
    // Obtain/refresh credentials before reserving the irreversible write.
    const token = await getToken();
    return this.mutations.run(clientId, account, requestId, { operation: 'drive_upload', target, bytes: bytes.length, sha256 }, async () => {
      const args = ['drive', '+upload', '--file=./input.bin', `--name=${target.name}`, ...(target.folderToken ? [`--folder-token=${target.folderToken}`] : []), '--as=user', '--json'];
      const result = await this.run(args, token, { timeout: 120_000, prepare: scratch => writeFile(join(scratch, 'input.bin'), bytes, { mode: 0o600 }) });
      const output = JSON.parse(result.output);
      return { ok: result.ok && output.ok !== false, account, identity: 'user', name: target.name, bytes: bytes.length, sha256, result: output,
        ...(!result.ok || output.ok === false ? { instruction: 'Do not assume the upload was rolled back. Inspect the destination before using a new requestId.' } : {}) };
    });
  }
  async commit(clientId, account, uploadId, getToken) {
    const entry = this.record(await this.state.read(), uploadId, clientId, account);
    if (entry.result) return { ...entry.result, replayed: true };
    const bytes = await this.assemble(uploadId, entry);
    const result = await this.upload(clientId, account, entry.requestId, entry.target, bytes, getToken);
    await this.state.update(doc => { this.record(doc, uploadId, clientId, account).result = result; });
    await this.removeParts(uploadId, entry).catch(() => {}); // Cron retries cleanup if interrupted.
    return { ...result, inputRoute: 'chunked' };
  }
  async single(clientId, account, { requestId, name, folderToken, file, data, sha256 }, getToken) {
    const target = uploadTarget({ name: name || file?.file_name, folderToken });
    this.mutations.key(clientId, account, requestId);
    if (Boolean(file) === Boolean(data)) throw failure('provide_one_native_file_or_base64_data');
    const bytes = file ? await this.download(file.download_url) : decodeChunk(data);
    if (sha256 && digest(bytes) !== sha256) throw failure('upload_sha256_mismatch');
    const result = await this.upload(clientId, account, requestId, target, bytes, getToken);
    return { ...result, inputRoute: file ? 'native_file' : 'base64' };
  }
  async removeParts(id, entry) {
    const paths = Object.keys(entry.parts).map(index => this.path(id, index));
    if (paths.length) await this.remove(paths);
  }
  async cancel(clientId, account, id) {
    const entry = this.record(await this.state.read(), id, clientId, account);
    await this.state.update(doc => { this.record(doc, id, clientId, account).expires = this.now() - 1; });
    await this.removeParts(id, entry);
    return { uploadId: id, cancelled: true, instruction: 'Staging cancelled. Any already-created Feishu file is retained.' };
  }
  async cleanup() {
    const saved = await this.state.read();
    let removed = 0;
    for (const [id, entry] of Object.entries(saved.records)) if (entry.expires < this.now() || entry.result) {
      await this.removeParts(id, entry);
      await this.state.update(doc => {
        if (doc.records[id]?.expires < this.now()) { delete doc.records[id]; removed++; }
        else if (doc.records[id]?.result) doc.records[id].parts = {};
      });
    }
    return { removed, stagingTtlHours: 24 };
  }
}
