export class MemoryBackend {
  data = new Map();
  generation = 0;
  async list(prefix) { return [...this.data.keys()].filter(path => path.startsWith(prefix)).sort(); }
  async remove(paths) { for (const path of paths) this.data.delete(path); }
  async read(path) { return structuredClone(this.data.get(path) ?? null); }
  async compareExchange(path, expected, body) {
    const current = this.data.get(path);
    if ((current?.etag ?? null) !== expected) return false;
    this.data.set(path, { etag: String(++this.generation), body });
    return true;
  }
}
