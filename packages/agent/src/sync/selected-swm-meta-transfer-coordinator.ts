// SPDX-License-Identifier: Apache-2.0

import type { SelectedSwmMetaFetcher } from './selected-swm-meta-fetcher.js';

interface SelectedSwmMetaTransferEntry {
  fetcher: SelectedSwmMetaFetcher | undefined;
  tail: Promise<void>;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  active: boolean;
}

/** Agent-owned peer serialization, expiry, and shutdown for retained metadata prefixes. */
export class SelectedSwmMetaTransferCoordinator {
  readonly #entries = new Map<string, SelectedSwmMetaTransferEntry>();

  readonly #now: () => number;

  #closed = false;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  run<T>(
    remotePeerId: string,
    createFetcher: () => SelectedSwmMetaFetcher,
    operation: (fetcher: SelectedSwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    let entry = this.#entries.get(remotePeerId);
    if (!entry) {
      entry = {
        fetcher: undefined,
        tail: Promise.resolve(),
        expiryTimer: undefined,
        active: false,
      };
      this.#entries.set(remotePeerId, entry);
    }

    const execute = entry.tail.then(async () => {
      if (this.#closed) throw this.#closedError();
      entry!.active = true;
      try {
        const retainedBeforeRun = entry!.fetcher?.settleOuterInvocation();
        if (entry!.fetcher && !retainedBeforeRun?.retained) {
          entry!.fetcher.cleanup();
          entry!.fetcher = undefined;
        }
        const fetcher = entry!.fetcher ?? createFetcher();
        entry!.fetcher = fetcher;
        let succeeded = false;
        try {
          const result = await operation(fetcher);
          succeeded = true;
          return result;
        } finally {
          if (!succeeded) {
            fetcher.cleanup();
            entry!.fetcher = undefined;
          } else {
            const retention = fetcher.settleOuterInvocation();
            if (!retention.retained) {
              fetcher.cleanup();
              entry!.fetcher = undefined;
            } else {
              this.#scheduleExpiry(remotePeerId, entry!, retention.nextExpiryAtMs);
            }
          }
        }
      } finally {
        entry!.active = false;
      }
    });
    const settled = execute.then(() => undefined, () => undefined);
    entry.tail = settled;
    void settled.then(() => {
      if (
        this.#entries.get(remotePeerId) === entry
        && entry!.tail === settled
        && !entry!.fetcher
      ) {
        this.#entries.delete(remotePeerId);
      }
    });
    return execute;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) this.#clearExpiryTimer(entry);
    await Promise.all(entries.map((entry) => entry.tail));
    for (const entry of entries) {
      entry.fetcher?.cleanup();
      entry.fetcher = undefined;
    }
    this.#entries.clear();
  }

  #clearExpiryTimer(entry: SelectedSwmMetaTransferEntry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
  }

  #scheduleExpiry(
    remotePeerId: string,
    entry: SelectedSwmMetaTransferEntry,
    nextExpiryAtMs: number | undefined,
  ): void {
    this.#clearExpiryTimer(entry);
    if (nextExpiryAtMs === undefined || this.#closed) return;
    const delayMs = Math.max(1, nextExpiryAtMs - this.#now());
    entry.expiryTimer = setTimeout(() => {
      entry.expiryTimer = undefined;
      if (this.#closed || this.#entries.get(remotePeerId) !== entry) return;
      // Expiry enforces a process-global budget. Prune inactive CG states even
      // while this peer owns another operation; the fetcher protects active CGs.
      const retention = entry.fetcher?.pruneExpiredPrefixes();
      if (!retention?.retained) {
        if (!entry.active) {
          entry.fetcher?.cleanup();
          entry.fetcher = undefined;
          this.#entries.delete(remotePeerId);
        }
        return;
      }
      this.#scheduleExpiry(remotePeerId, entry, retention.nextExpiryAtMs);
    }, delayMs);
    entry.expiryTimer.unref?.();
  }

  #closedError(): Error {
    const error = new Error('Selected SWM metadata transfer coordinator is closed');
    error.name = 'AbortError';
    return error;
  }
}
