import { BoundedWork } from './bounded-work.js';

interface PendingBlobWrite {
  readonly value: string;
  readonly ready: Promise<void>;
}

export interface ContentAddressedBlobSingleFlightOptions {
  /** Create the immutable blob or verify an existing file with the same hash. */
  readonly createOrVerify: (hash: string, value: string) => Promise<void>;
  readonly maxConcurrent?: number;
  readonly maxCachedEntries?: number;
  readonly maxCachedBytes?: number;
}

/**
 * Coalesces immutable preparations and bounds physical disk concurrency. Only
 * successful preparations enter the byte/entry-bounded LRU, owned by this blob
 * writer. A new owner verifies existing files again; failures always retry.
 */
export class ContentAddressedBlobSingleFlight {
  private readonly pending = new Map<string, PendingBlobWrite>();
  private readonly completed = new Map<string, string>();
  private cachedBytes = 0;
  private readonly preparations: BoundedWork;
  private readonly maxCachedEntries: number;
  private readonly maxCachedBytes: number;

  constructor(private readonly options: ContentAddressedBlobSingleFlightOptions) {
    const maxConcurrent = options.maxConcurrent ?? 4;
    this.maxCachedEntries = options.maxCachedEntries ?? 128;
    this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
    for (const [name, value] of Object.entries({ maxConcurrent,
      maxCachedEntries: this.maxCachedEntries, maxCachedBytes: this.maxCachedBytes })) {
      if (!Number.isSafeInteger(value) || value < (name === 'maxConcurrent' ? 1 : 0)) {
        throw new Error(`Invalid blob preparation ${name}`);
      }
    }
    this.preparations = new BoundedWork(maxConcurrent);
  }

  async createOrVerify(hash: string, value: string): Promise<void> {
    const completed = this.completed.get(hash);
    if (completed !== undefined) {
      if (completed !== value) throw new Error(`Content-addressed blob hash ${hash} has conflicting bytes`);
      this.completed.delete(hash);
      this.completed.set(hash, value);
      return;
    }
    let entry = this.pending.get(hash);
    if (entry) {
      if (entry.value !== value) {
        throw new Error(`Content-addressed blob hash ${hash} has conflicting bytes`);
      }
      await entry.ready;
      return;
    }

    // Publish pending identity before invoking any possibly reentrant preparation callback.
    const ready = Promise.resolve().then(() => this.preparations.run(async () => {
      await this.options.createOrVerify(hash, value);
      this.remember(hash, value);
    }));
    entry = { value, ready };
    this.pending.set(hash, entry);

    try {
      await ready;
    } finally {
      if (this.pending.get(hash) === entry) this.pending.delete(hash);
    }
  }

  private remember(hash: string, value: string): void {
    const bytes = Buffer.byteLength(value);
    if (this.maxCachedEntries === 0 || bytes > this.maxCachedBytes) return;
    while (this.completed.size >= this.maxCachedEntries || this.cachedBytes + bytes > this.maxCachedBytes) {
      const [oldHash, oldValue] = this.completed.entries().next().value!;
      this.completed.delete(oldHash);
      this.cachedBytes -= Buffer.byteLength(oldValue);
    }
    this.completed.set(hash, value);
    this.cachedBytes += bytes;
  }
}
