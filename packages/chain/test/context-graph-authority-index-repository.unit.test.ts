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
    const scoped = repository.forScope('scope');
    const staleLoad = scoped.load();
    await firstLoadEntered.promise;
    repository.clear();
    store.record = { token: 2, value: currentCheckpoint };
    releaseFirstLoad.resolve();

    await expect(staleLoad).resolves.toMatchObject({
      kind: 'checkpoint',
      token: 1,
    });
    const current = await scoped.load();
    expect(current).toMatchObject({ kind: 'checkpoint', token: 2 });
    await expect(scoped.load()).resolves.toBe(current);
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
    const scoped = repository.forScope('scope');
    const rejected = await scoped.load();
    const winner = checkpoint(25);
    store.invalidate = async (_scope, expectedToken) => {
      expect(expectedToken).toBe(1);
      store.record = { token: 2, value: winner };
      return undefined;
    };

    const recovery = await scoped.invalidateOrReloadWinner(rejected);
    expect(recovery).toMatchObject({
      kind: 'winner',
      record: { kind: 'checkpoint', token: 2, checkpoint: winner },
    });
    await expect(scoped.load()).resolves.toBe(recovery.record);
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
    const scoped = repository.forScope('scope');
    const previous = await scoped.load();
    const winner = checkpoint(25);
    store.compareAndSwap = async (_scope, expectedToken) => {
      expect(expectedToken).toBe(1);
      store.record = { token: 2, value: winner };
      return undefined;
    };

    const recovery = await scoped.commitOrReloadWinner(previous, checkpoint(21));
    expect(recovery).toMatchObject({
      kind: 'winner',
      record: { kind: 'checkpoint', token: 2, checkpoint: winner },
    });
    await expect(scoped.load()).resolves.toBe(recovery.record);
    expect(loadCount).toBe(2);
  });

  it('rejects observations produced by another repository scope', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 1, value: checkpoint(20) };
    const repository = new ContextGraphAuthorityIndexRepository(store);
    const first = repository.forScope('first');
    const second = repository.forScope('second');
    const observation = await first.load();

    await expect(second.commitOrReloadWinner(observation, checkpoint(21)))
      .rejects.toThrow('observation belongs to another scope');
    expect(store.commits).toEqual([]);
  });
});
