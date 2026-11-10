// SPDX-License-Identifier: Apache-2.0

/**
 * A settled block's hash is read from the chain at most once; the reorg tail
 * on every read, as before. Counted at `provider.getBlock`, behind the same
 * one-line wrapper the runtime hands the page source.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_DURABLE_DEPTH_BLOCKS,
  createChainEventLogSettledBlockHashes,
} from '../src/chain-index/chain-event-log-settled-block-hashes.js';
import type { ChainEventLogRow, ChainEventLogState } from '../src/chain-index/chain-event-log.js';
import { tombstoneChainEventLogScope } from '../src/chain-index/chain-event-log-tombstones.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:hub=0xa1:settled-block-hashes';
const SETTLED = 5_000;
const HEAD = 5_050;
const DEEP = SETTLED - CHAIN_EVENT_LOG_SETTLED_BLOCK_HASH_DURABLE_DEPTH_BLOCKS;

/** One chain instance's block hashes; `chain` tells two instances apart. */
const blockHash = (blockNumber: number, chain = 0): string => (
  `0x${(chain * 1_000_000_000 + blockNumber).toString(16).padStart(64, '0')}`
);
const LINEAGE = blockHash(1);

function cursorState(options: Readonly<{
  settled?: number;
  lineage?: string;
  revision?: number;
  suspectedForkBlockNumber?: number;
}> = {}): ChainEventLogState {
  const settled = options.settled ?? SETTLED;
  return Object.freeze({
    cursor: Object.freeze({
      revision: options.revision ?? 1,
      lineage: options.lineage ?? LINEAGE,
      deploymentBlockNumber: 1,
      settledBlockNumber: settled,
      settledBlockHash: blockHash(settled),
      head: Object.freeze({
        number: HEAD,
        hash: blockHash(HEAD),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      }),
      topicSetVersion: 'v1',
    }),
    coverage: Object.freeze([]),
    ...(options.suspectedForkBlockNumber === undefined
      ? {}
      : { suspectedForkBlockNumber: options.suspectedForkBlockNumber }),
  });
}

interface FakeBlock {
  readonly number: number;
  readonly hash: string | null;
}

/** A provider whose `getBlock` is the one thing counted. */
function fakeProvider() {
  let chain = 0;
  const getBlock = vi.fn(async (blockNumber: number): Promise<FakeBlock | null> => ({
    number: blockNumber,
    hash: blockHash(blockNumber, chain),
  }));
  return {
    getBlock,
    /** Every later block read answers for another chain instance. */
    switchChain(next: number): void { chain = next; },
  };
}

function settledHashes(
  store: MemoryChainEventLogStore,
  provider: ReturnType<typeof fakeProvider>,
  options: Readonly<{ maxEntries?: number }> = {},
) {
  const signals: AbortSignal[] = [];
  const hashes = createChainEventLogSettledBlockHashes({
    scope: SCOPE,
    store,
    // Exactly the runtime's wrapper (`evm-chain-index-runtime.ts`).
    readBlockHash: async (blockNumber, signal) => {
      signals.push(signal);
      return (await provider.getBlock(blockNumber))?.hash ?? null;
    },
    ...options,
  });
  return { hashes, signals };
}

const live = (): AbortSignal => new AbortController().signal;

/** Let a fire-and-forget durable write and its follow-up settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe('settled block hashes', () => {
  it('reads a settled block from the chain once, then never again', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);

    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000));
    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000));
    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000));

    expect(provider.getBlock).toHaveBeenCalledTimes(1);
    expect(hashes.stats()).toMatchObject({ chainReads: 1, memoryHits: 2 });
  });

  it('reads a block in the reorg tail from the chain every time', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);

    await hashes.readBlockHash(SETTLED + 1, live());
    await hashes.readBlockHash(SETTLED + 1, live());
    await hashes.readBlockHash(HEAD - 1, live());
    await hashes.readBlockHash(HEAD - 1, live());

    expect(provider.getBlock).toHaveBeenCalledTimes(4);
    expect(hashes.stats().entries).toBe(1); // the settled boundary, nothing else
  });

  it('answers from the log\'s own rows and cursor before anything else', async () => {
    const store = new MemoryChainEventLogStore();
    const row: ChainEventLogRow = Object.freeze({
      blockNumber: 4_200,
      blockHash: blockHash(4_200),
      logIndex: 0,
      transactionHash: blockHash(7),
      address: `0x${'cd'.repeat(20)}`,
      topics: Object.freeze([blockHash(9)]),
      data: '0x',
      settled: true,
    });
    store.seed(SCOPE, cursorState(), [row]);
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);

    expect(await hashes.readBlockHash(4_200, live())).toBe(blockHash(4_200));
    expect(await hashes.readBlockHash(SETTLED, live())).toBe(blockHash(SETTLED));
    expect(await hashes.readBlockHash(HEAD, live())).toBe(blockHash(HEAD));
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('keeps each settled boundary it sees, so the next admission needs no read', async () => {
    // The authority checkpoint is committed at the boundary a scan anchored
    // on; by the next scan the cursor has moved on and `blockHashAt` no longer
    // names that block.
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState({ settled: SETTLED }));
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);

    await hashes.readBlockHash(4_000, live());
    store.seed(SCOPE, cursorState({ settled: SETTLED + 3, revision: 2 }));

    expect(await hashes.readBlockHash(SETTLED, live())).toBe(blockHash(SETTLED));
    expect(provider.getBlock).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent reads of one block, and keeps it', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.getBlock.mockImplementation(async (blockNumber: number) => {
      await gate;
      return { number: blockNumber, hash: blockHash(blockNumber) };
    });
    const { hashes } = settledHashes(store, provider);

    const reads = [
      hashes.readBlockHash(4_000, live()),
      hashes.readBlockHash(4_000, live()),
      hashes.readBlockHash(4_000, live()),
    ];
    await vi.waitFor(() => expect(provider.getBlock).toHaveBeenCalledTimes(1));
    await settle();
    release();

    expect(await Promise.all(reads)).toEqual([
      blockHash(4_000), blockHash(4_000), blockHash(4_000),
    ]);
    expect(provider.getBlock).toHaveBeenCalledTimes(1);
    expect(hashes.stats()).toMatchObject({ chainReads: 1, sharedReads: 2 });
    await hashes.readBlockHash(4_000, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(1);
  });

  it('never shares one read between a foreground and a background caller', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.getBlock.mockImplementation(async (blockNumber: number) => {
      await gate;
      return { number: blockNumber, hash: blockHash(blockNumber) };
    });
    const { hashes } = settledHashes(store, provider);

    const foreground = hashes.readBlockHash(4_000, live());
    const background = withRpcRequestContext(
      { requestClass: 'background' },
      () => hashes.readBlockHash(4_000, live()),
    );
    await vi.waitFor(() => expect(provider.getBlock).toHaveBeenCalledTimes(2));
    release();

    expect(await foreground).toBe(blockHash(4_000));
    expect(await background).toBe(blockHash(4_000));
    expect(hashes.stats().sharedReads).toBe(0);
  });

  it('lets a caller give up without cancelling the read others still wait for', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.getBlock.mockImplementation(async (blockNumber: number) => {
      await gate;
      return { number: blockNumber, hash: blockHash(blockNumber) };
    });
    const { hashes, signals } = settledHashes(store, provider);
    const first = new AbortController();

    const abandoned = hashes.readBlockHash(4_000, first.signal);
    const kept = hashes.readBlockHash(4_000, live());
    await vi.waitFor(() => expect(provider.getBlock).toHaveBeenCalledTimes(1));
    await settle();
    first.abort(new Error('caller went away'));
    await expect(abandoned).rejects.toThrow('caller went away');
    expect(signals[0]!.aborted).toBe(false);
    release();

    expect(await kept).toBe(blockHash(4_000));
    // Kept although the caller that opened the request had left.
    await settle();
    await hashes.readBlockHash(4_000, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(1);
  });

  it('cancels the request once its last caller gives up, and keeps nothing', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.getBlock.mockImplementation(async (blockNumber: number) => {
      await gate;
      return { number: blockNumber, hash: blockHash(blockNumber) };
    });
    const { hashes, signals } = settledHashes(store, provider);
    const only = new AbortController();

    const read = hashes.readBlockHash(4_000, only.signal);
    await vi.waitFor(() => expect(provider.getBlock).toHaveBeenCalledTimes(1));
    only.abort(new Error('gone'));
    await expect(read).rejects.toThrow('gone');
    expect(signals[0]!.aborted).toBe(true);
    release();
    await settle();

    provider.getBlock.mockImplementation(async (blockNumber: number) => (
      { number: blockNumber, hash: blockHash(blockNumber) }
    ));
    await hashes.readBlockHash(4_000, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing for a block the chain cannot name', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    provider.getBlock.mockResolvedValue(null);
    const { hashes } = settledHashes(store, provider);

    expect(await hashes.readBlockHash(4_000, live())).toBeNull();
    expect(await hashes.readBlockHash(4_000, live())).toBeNull();
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('empties when the lineage changes, so a reset chain is never answered from the old one', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);
    await hashes.readBlockHash(4_000, live());

    // A devnet reset or redeploy: same scope string, same heights, new chain.
    provider.switchChain(1);
    store.seed(SCOPE, cursorState({ lineage: blockHash(1, 1), revision: 9 }));

    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000, 1));
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('empties when the scope is tombstoned, even when it comes back on the same lineage', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);
    await hashes.readBlockHash(4_000, live());

    // A reorg below the tail: the tick tombstones, and the cold start finds
    // the deployment block unchanged, so the lineage is the same.
    await tombstoneChainEventLogScope(store, SCOPE, 1);
    provider.switchChain(2);
    // While the scope has no cursor: the chain, and nothing kept.
    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000, 2));
    store.seed(SCOPE, cursorState({ revision: 3 }));

    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000, 2));
    expect(provider.getBlock).toHaveBeenCalledTimes(3);
    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000, 2));
    expect(provider.getBlock).toHaveBeenCalledTimes(3);
  });

  it('empties on a tombstone it never saw, when the scope is already rebuilt on its lineage', async () => {
    // No read lands while the scope is tombstoned, so the first thing this
    // reader sees afterwards is a live cursor on the very same lineage. Only
    // the tombstone generation tells the two logs apart.
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);
    await hashes.readBlockHash(4_000, live());

    await tombstoneChainEventLogScope(store, SCOPE, 1);
    store.seed(SCOPE, cursorState({ revision: 3 }));
    provider.switchChain(3);

    expect(await hashes.readBlockHash(4_000, live())).toBe(blockHash(4_000, 3));
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('serves and keeps nothing while a fork is suspected', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);
    await hashes.readBlockHash(4_000, live());

    store.seed(SCOPE, cursorState({ revision: 2, suspectedForkBlockNumber: SETTLED }));
    await hashes.readBlockHash(4_000, live());
    await hashes.readBlockHash(4_001, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(3);

    // Withdrawn by a matching re-read: what was kept before it holds again,
    // and what was read during it was not kept.
    store.seed(SCOPE, cursorState({ revision: 3 }));
    await hashes.readBlockHash(4_000, live());
    await hashes.readBlockHash(4_001, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(4);
  });

  it('reads the chain as before, keeping nothing, when the cursor cannot be loaded', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);
    await hashes.readBlockHash(4_000, live());
    const load = vi.spyOn(store, 'load').mockRejectedValue(new Error('SQLITE_BUSY'));

    expect(await hashes.readBlockHash(4_001, live())).toBe(blockHash(4_001));
    expect(await hashes.readBlockHash(4_001, live())).toBe(blockHash(4_001));
    expect(provider.getBlock).toHaveBeenCalledTimes(3);
    load.mockRestore();
  });

  it('reads the chain and keeps nothing while the scope has no cursor', async () => {
    const store = new MemoryChainEventLogStore();
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider);

    await hashes.readBlockHash(4_000, live());
    await hashes.readBlockHash(4_000, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
    expect(hashes.stats().entries).toBe(0);
  });

  it('holds at most its bound in memory, dropping the least recently used', async () => {
    const store = new MemoryChainEventLogStore();
    store.seed(SCOPE, cursorState());
    const provider = fakeProvider();
    const { hashes } = settledHashes(store, provider, { maxEntries: 4 });

    for (let blockNumber = 4_000; blockNumber < 4_010; blockNumber += 1) {
      await hashes.readBlockHash(blockNumber, live());
      expect(hashes.stats().entries).toBeLessThanOrEqual(4);
    }
    expect(provider.getBlock).toHaveBeenCalledTimes(10);
    await hashes.readBlockHash(4_009, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(10);
    await hashes.readBlockHash(4_000, live());
    expect(provider.getBlock).toHaveBeenCalledTimes(11);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => createChainEventLogSettledBlockHashes({
        scope: SCOPE,
        store: new MemoryChainEventLogStore(),
        readBlockHash: async () => null,
        maxEntries,
      })).toThrow('positive integer');
    }
  });

  describe('with a durable memo', () => {
    it('carries a deep settled hash across a restart, so it is read once ever', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      const provider = fakeProvider();
      await settledHashes(store, provider).hashes.readBlockHash(DEEP, live());
      await settle();
      expect(store.memoSize(SCOPE)).toBe(1);

      // A new process: empty memory, same store.
      const restarted = settledHashes(store, provider).hashes;
      expect(await restarted.readBlockHash(DEEP, live())).toBe(blockHash(DEEP));
      expect(provider.getBlock).toHaveBeenCalledTimes(1);
      expect(restarted.stats()).toMatchObject({ durableHits: 1, chainReads: 0 });
      // And then from memory, without asking the store again.
      const reads = store.memoReads;
      await restarted.readBlockHash(DEEP, live());
      expect(store.memoReads).toBe(reads);
    });

    it('keeps a block near the boundary in memory only', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      const provider = fakeProvider();
      await settledHashes(store, provider).hashes.readBlockHash(DEEP + 1, live());
      await settle();

      expect(store.memoWrites).toBe(0);
      expect(store.memoReads).toBe(0);
      await settledHashes(store, provider).hashes.readBlockHash(DEEP + 1, live());
      expect(provider.getBlock).toHaveBeenCalledTimes(2);
    });

    it('drops the durable memo with the lineage, so a restart reads the new chain', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      const provider = fakeProvider();
      await settledHashes(store, provider).hashes.readBlockHash(DEEP, live());
      await settle();

      provider.switchChain(1);
      store.seed(SCOPE, cursorState({ lineage: blockHash(1, 1), revision: 9 }));
      expect(store.memoSize(SCOPE)).toBe(0);

      expect(await settledHashes(store, provider).hashes.readBlockHash(DEEP, live()))
        .toBe(blockHash(DEEP, 1));
      expect(provider.getBlock).toHaveBeenCalledTimes(2);
    });

    it('drops the durable memo with a tombstone', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      const provider = fakeProvider();
      await settledHashes(store, provider).hashes.readBlockHash(DEEP, live());
      await settle();

      await tombstoneChainEventLogScope(store, SCOPE, 1);
      expect(store.memoSize(SCOPE)).toBe(0);
    });

    it('keeps nothing, in memory either, when the store refuses the write', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      store.rememberSettledBlockHash = vi.fn(async () => false);
      const provider = fakeProvider();
      const { hashes } = settledHashes(store, provider);

      await hashes.readBlockHash(DEEP, live());
      await settle();
      await hashes.readBlockHash(DEEP, live());
      expect(provider.getBlock).toHaveBeenCalledTimes(2);
    });

    it('reads the chain as before when the memo fails', async () => {
      const store = new MemoryChainEventLogStore({ settledBlockHashMemo: true });
      store.seed(SCOPE, cursorState());
      store.readSettledBlockHash = vi.fn(async () => { throw new Error('SQLITE_BUSY'); });
      store.rememberSettledBlockHash = vi.fn(async () => { throw new Error('SQLITE_FULL'); });
      const provider = fakeProvider();
      const { hashes } = settledHashes(store, provider);

      expect(await hashes.readBlockHash(DEEP, live())).toBe(blockHash(DEEP));
      await settle();
      expect(await hashes.readBlockHash(DEEP, live())).toBe(blockHash(DEEP));
      expect(provider.getBlock).toHaveBeenCalledTimes(2);
    });
  });
});
