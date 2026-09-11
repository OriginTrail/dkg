// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { createContextGraphAuthorityIndexCheckpoint } from
  '../src/context-graph-authority-index-checkpoint.js';
import { ContextGraphAuthorityIndexRepository } from
  '../src/context-graph-authority-index-repository.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const blockHash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

const checkpoint = (throughBlockNumber: number) => createContextGraphAuthorityIndexCheckpoint({
  deploymentBlockNumber: 10,
  throughBlockNumber,
  throughBlockHash: blockHash(throughBlockNumber),
}, []);

describe('ContextGraphAuthorityIndexRepository cache lifecycle', () => {
  it('does not let a deferred pre-clear load republish stale cache state', async () => {
    const store = new MemoryAuthorityIndexStore();
    const staleCheckpoint = checkpoint(20);
    const currentCheckpoint = checkpoint(25);
    store.record = { token: 1, value: staleCheckpoint };

    const firstLoadEntered = Promise.withResolvers<void>();
    const releaseFirstLoad = Promise.withResolvers<void>();
    const load = store.load.bind(store);
    let loadCount = 0;
    store.load = async () => {
      loadCount += 1;
      if (loadCount !== 1) return load();
      const stale = await load();
      firstLoadEntered.resolve();
      await releaseFirstLoad.promise;
      return stale;
    };

    const repository = new ContextGraphAuthorityIndexRepository(store);
    const staleLoad = repository.load('scope');
    await firstLoadEntered.promise;
    repository.clear();
    store.record = { token: 2, value: currentCheckpoint };
    releaseFirstLoad.resolve();

    await expect(staleLoad).resolves.toMatchObject({
      kind: 'checkpoint',
      token: 1,
    });
    const current = await repository.load('scope');
    expect(current).toMatchObject({ kind: 'checkpoint', token: 2 });
    await expect(repository.load('scope')).resolves.toBe(current);
    expect(loadCount).toBe(2);
  });

  it('evicts a rejected cache entry and reloads an invalidation winner', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 1, value: checkpoint(20) };
    const load = store.load.bind(store);
    let loadCount = 0;
    store.load = async () => {
      loadCount += 1;
      return load();
    };
    const repository = new ContextGraphAuthorityIndexRepository(store);
    const rejected = await repository.load('scope');
    const winner = checkpoint(25);
    store.invalidate = async (_scope, expectedToken) => {
      expect(expectedToken).toBe(1);
      store.record = { token: 2, value: winner };
      return undefined;
    };

    const recovery = await repository.invalidateOrReloadWinner('scope', rejected);
    expect(recovery).toMatchObject({
      kind: 'winner',
      record: { kind: 'checkpoint', token: 2, checkpoint: winner },
    });
    await expect(repository.load('scope')).resolves.toBe(recovery.record);
    expect(loadCount).toBe(2);
  });

  it('reloads and caches the durable winner of a checkpoint CAS loss', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 1, value: checkpoint(20) };
    const load = store.load.bind(store);
    let loadCount = 0;
    store.load = async () => {
      loadCount += 1;
      return load();
    };
    const repository = new ContextGraphAuthorityIndexRepository(store);
    const previous = await repository.load('scope');
    const winner = checkpoint(25);
    store.compareAndSwap = async (_scope, expectedToken) => {
      expect(expectedToken).toBe(1);
      store.record = { token: 2, value: winner };
      return undefined;
    };

    const recovery = await repository.commitOrReloadWinner(
      'scope',
      previous,
      checkpoint(21),
    );
    expect(recovery).toMatchObject({
      kind: 'winner',
      record: { kind: 'checkpoint', token: 2, checkpoint: winner },
    });
    await expect(repository.load('scope')).resolves.toBe(recovery.record);
    expect(loadCount).toBe(2);
  });
});
