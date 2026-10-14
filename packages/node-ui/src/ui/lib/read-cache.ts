/** Session-only read cache. Large results and abandoned tabs cannot grow it indefinitely. */
export class ReadCache<T> {
  private entries = new Map<string, { value: T; at: number; bytes: number; scope?: string }>();
  private bytes = 0;

  constructor(private maxBytes = 32 * 1024 * 1024, private maxEntries = 64) {}

  get(key: string, maxAgeMs: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= maxAgeMs) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, scope?: string): void {
    const bytes = JSON.stringify(value).length * 2;
    this.remove(key);
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, at: Date.now(), bytes, scope });
    this.bytes += bytes;
  }

  invalidate(scope?: string): void {
    for (const [key, entry] of this.entries) {
      if (!scope || entry.scope === scope) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

export const UI_READ_MAX_AGE_MS = 5 * 60 * 1000;
