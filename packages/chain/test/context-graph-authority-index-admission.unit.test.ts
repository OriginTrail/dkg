// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  admitContextGraphAuthorityIndexCheckpoint,
} from '../src/context-graph-authority-index-admission.js';
import { createContextGraphAuthorityIndexCheckpoint } from
  '../src/context-graph-authority-index-checkpoint.js';
import {
  ContextGraphAuthorityIndexRepository,
} from '../src/context-graph-authority-index-repository.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const SCOPE = 'evm:84532:hub:context-graph-storage';
const HASH_20 = `0x${'20'.repeat(32)}`;
const HASH_25 = `0x${'25'.repeat(32)}`;
const REPLACEMENT_HASH = `0x${'ff'.repeat(32)}`;

const checkpoint = createContextGraphAuthorityIndexCheckpoint({
  deploymentBlockNumber: 10,
  throughBlockNumber: 20,
  throughBlockHash: HASH_20,
}, []);

async function admit(
  repository: ContextGraphAuthorityIndexRepository,
  overrides: Readonly<{
    deploymentBlockNumber?: number;
    finalized?: Readonly<{ number: number; hash: string }>;
    readBlockHash?: () => Promise<string | null>;
  }> = {},
) {
  const scoped = repository.forScope(SCOPE);
  return admitContextGraphAuthorityIndexCheckpoint({
    repository: scoped,
    initial: await scoped.load(),
    deploymentBlockNumber: overrides.deploymentBlockNumber ?? 10,
    finalized: overrides.finalized ?? { number: 25, hash: HASH_25 },
    lifecycleSignal: new AbortController().signal,
    readBlockHash: overrides.readBlockHash ?? (async () => HASH_20),
  });
}

describe('Context Graph authority index checkpoint admission and recovery', () => {
  it('rebuilds missing and tombstoned rows without durable effects', async () => {
    const store = new MemoryAuthorityIndexStore();
    const repository = new ContextGraphAuthorityIndexRepository(store);
    await expect(admit(repository))
      .resolves.toEqual({ kind: 'missing', token: undefined });
    store.record = { token: 8, value: null };
    await expect(admit(new ContextGraphAuthorityIndexRepository(store)))
      .resolves.toEqual({ kind: 'tombstone', token: 8 });
    expect(store.invalidations).toEqual([]);
  });

  it('accepts a matching warm anchor and the requested finalized head', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 7, value: checkpoint };
    await expect(admit(new ContextGraphAuthorityIndexRepository(store)))
      .resolves.toMatchObject({ kind: 'checkpoint', token: 7 });

    const finalizedCheckpoint = createContextGraphAuthorityIndexCheckpoint({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: HASH_25,
    }, []);
    const finalizedStore = new MemoryAuthorityIndexStore();
    finalizedStore.record = { token: 8, value: finalizedCheckpoint };
    let anchorReads = 0;
    await expect(admit(new ContextGraphAuthorityIndexRepository(finalizedStore), {
      readBlockHash: async () => {
        anchorReads += 1;
        return HASH_25;
      },
    })).resolves.toMatchObject({ kind: 'checkpoint', token: 8 });
    expect(anchorReads).toBe(0);
  });

  it('keeps lagging and non-archive observations retryable without invalidation', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 7, value: checkpoint };
    await expect(admit(new ContextGraphAuthorityIndexRepository(store), {
      finalized: { number: 19, hash: HASH_25 },
    })).rejects.toThrow('finalized head 19 is behind durable cursor 20');
    await expect(admit(new ContextGraphAuthorityIndexRepository(store), {
      readBlockHash: async () => null,
    })).rejects.toThrow('anchor 20 is unavailable');
    expect(store.invalidations).toEqual([]);
  });

  it('tombstones corrupt rows, deployment changes, and proven fork replacements', async () => {
    const scenarios: Array<Readonly<{
      durableValue: unknown;
      deploymentBlockNumber?: number;
      readBlockHash?: () => Promise<string | null>;
    }>> = [
      {
        durableValue: { corrupt: true },
      },
      {
        durableValue: checkpoint,
        deploymentBlockNumber: 11,
      },
      {
        durableValue: checkpoint,
        readBlockHash: async () => REPLACEMENT_HASH,
      },
    ];

    for (const scenario of scenarios) {
      const store = new MemoryAuthorityIndexStore();
      store.record = { token: 7, value: scenario.durableValue };
      const result = await admit(
        new ContextGraphAuthorityIndexRepository(store),
        {
          deploymentBlockNumber: scenario.deploymentBlockNumber,
          readBlockHash: scenario.readBlockHash,
        },
      );
      expect(result).toEqual({ kind: 'tombstone', token: 8 });
      expect(store.invalidations).toEqual([8]);
    }
  });
});
