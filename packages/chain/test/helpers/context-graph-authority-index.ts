// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';

import type { ContextGraphAuthorityIndexStore } from
  '../../src/context-graph-authority-index-checkpoint.js';

/** Small reusable CAS store; scenario-specific gates belong in their owning suite. */
export class MemoryAuthorityIndexStore implements ContextGraphAuthorityIndexStore {
  record: Readonly<{ token: number; value: unknown | null }> | undefined;
  readonly commits: number[] = [];
  readonly invalidations: number[] = [];

  async load(): Promise<Readonly<{ token: number; value: unknown | null }> | undefined> {
    return this.record;
  }

  async compareAndSwap(
    _scope: string,
    expectedToken: number | undefined,
    value: unknown,
  ): Promise<number | undefined> {
    if (this.record?.token !== expectedToken) return undefined;
    const nextToken = expectedToken === undefined ? 1 : expectedToken + 1;
    this.record = Object.freeze({ token: nextToken, value });
    this.commits.push(nextToken);
    return nextToken;
  }

  async invalidate(_scope: string, expectedToken: number): Promise<number | undefined> {
    if (this.record?.token !== expectedToken) return undefined;
    const nextToken = expectedToken + 1;
    this.record = Object.freeze({ token: nextToken, value: null });
    this.invalidations.push(nextToken);
    return nextToken;
  }
}

/** Per-scope CAS store with spied methods: a trust-domain key and the plain scope stay distinct. */
export class ScopedAuthorityIndexStore implements ContextGraphAuthorityIndexStore {
  readonly records = new Map<string, { token: number; value: unknown | null }>();
  load = vi.fn(async (scope: string) => this.records.get(scope));
  compareAndSwap = vi.fn(async (scope: string, token: number | undefined, value: unknown) => {
    if (this.records.get(scope)?.token !== token) return undefined;
    const next = (token ?? 0) + 1;
    this.records.set(scope, { token: next, value });
    return next;
  });
  invalidate = vi.fn(async (scope: string, token: number) => {
    if (this.records.get(scope)?.token !== token) return undefined;
    this.records.set(scope, { token: token + 1, value: null });
    return token + 1;
  });
}

export interface AbortableTipReaderOptions {
  readonly signal?: AbortSignal;
}

/** Preserve caller cancellation while leaving the provider-owned read physically shared. */
export function createAbortableTipReader<Provider>(
  provider: Provider,
  observeOptions: (options: AbortableTipReaderOptions) => void = () => undefined,
) {
  return async <T>(
    _label: string,
    read: (provider: Provider) => Promise<T>,
    options: AbortableTipReaderOptions,
  ): Promise<T> => {
    observeOptions(options);
    const pending = read(provider);
    const signal = options.signal;
    if (signal === undefined) return pending;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void pending.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  };
}
