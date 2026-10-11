import { normalizeKnowledgeAssetUpdateIdentity, type KnowledgeAssetUpdateIdentity, type ChainEvent } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { ChainEventPoller, type ChainEventPollerLane, type LaneCursorPersistence, type OnCollectionUpdated } from '../src/chain-event-poller.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller collection updates', () => {
  it('dispatches collection update events and advances the collectionUpdates cursor', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 50,
      data: {
        merkleRoot: '0x' + '44'.repeat(32),
        batchId: '42',
      },
    };
    const { adapter, filters } = makeChain({ head: 100, events: [event] });
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const seen: Array<Parameters<OnCollectionUpdated>[0]> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onCollectionUpdated: async (info) => { seen.push(info); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['KnowledgeAssetUpdated']);
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0].merkleRoot).toString('hex')).toBe('44'.repeat(32));
    expect(seen[0].batchId).toBe(42n);
    expect(seen[0].eventIdentity.blockNumber).toBe(50);
    expect(seen[0].blockNumber).toBe(50);
    for (const field of ['txHash', 'logIndex', 'blockHash']) expect(field in seen[0]).toBe(false);
    expect(saveCalls).toEqual([{ lane: 'collectionUpdates', block: 100 }]);
  });

  it('passes the update\'s transaction and block/log identity to the callback', async () => {
    const { adapter } = makeChain({
      head: 100,
      events: [{
        type: 'KnowledgeAssetUpdated',
        blockNumber: 50,
        data: {
          merkleRoot: '0x' + '44'.repeat(32), batchId: '42',
          txHash: '0x' + 'ab'.repeat(32), logIndex: 7, blockHash: '0x' + 'cd'.repeat(32),
        },
      }],
    });
    const seen: Array<Parameters<OnCollectionUpdated>[0]> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onCollectionUpdated: async (info) => { seen.push(info); },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(seen.map((info) => info.eventIdentity.txHash)).toEqual(['0x' + 'ab'.repeat(32)]);
    expect(seen.map((info) => info.eventIdentity.logIndex)).toEqual([7]);
    expect(seen.map((info) => info.eventIdentity.blockHash)).toEqual(['0x' + 'cd'.repeat(32)]);
    expect(seen[0]).toMatchObject({ blockNumber: 50, logIndex: 7,
      txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32) });
  });

  it('preserves an adapter-owned identity instead of reconstructing it from legacy fields', async () => {
    const eventIdentity = normalizeKnowledgeAssetUpdateIdentity({ blockNumber: 50, logIndex: 7, txHash: '0xAB', blockHash: '0xCD' });
    const { adapter } = makeChain({ head: 100, events: [{ type: 'KnowledgeAssetUpdated', blockNumber: 50, updateIdentity: eventIdentity,
      data: { merkleRoot: '0x' + '44'.repeat(32), batchId: '42' } }] });
    const seen: Array<Parameters<OnCollectionUpdated>[0]> = [];
    const poller = new ChainEventPoller({ chain: adapter, publishHandler: makeHandler(), intervalMs: 60_000,
      onCollectionUpdated: async (info) => { seen.push(info); } });
    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(seen[0]).toMatchObject({ blockNumber: 50, logIndex: 7, txHash: '0xab', blockHash: '0xcd' });
    expect(seen[0].eventIdentity).toBe(eventIdentity);
  });

  it('keeps legacy callback fields absent when the canonical adapter has no position evidence', async () => {
    const eventIdentity = normalizeKnowledgeAssetUpdateIdentity({});
    const { adapter } = makeChain({ head: 100, events: [{ type: 'KnowledgeAssetUpdated', blockNumber: 50,
      updateIdentity: eventIdentity, data: { batchId: '42', merkleRoot: '0x' + '44'.repeat(32),
        txHash: '0xlegacy', blockHash: '0xlegacy', logIndex: 9 } }] });
    const seen: Array<Parameters<OnCollectionUpdated>[0]> = [];
    const poller = new ChainEventPoller({ chain: adapter, publishHandler: makeHandler(),
      intervalMs: 60_000, onCollectionUpdated: async (info) => { seen.push(info); } });
    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(seen).toHaveLength(1);
    expect(seen[0].blockNumber).toBe(50);
    expect(seen[0].eventIdentity).toBe(eventIdentity);
    for (const field of ['txHash', 'logIndex', 'blockHash']) expect(field in seen[0]).toBe(false);
  });

  it('holds the page when an adapter returns a non-update to the collection update lane', async () => {
    const { adapter } = makeChain({ head: 100 });
    let incoming: ChainEvent = { type: 'ContextGraphCreated', blockNumber: 50,
      updateIdentity: normalizeKnowledgeAssetUpdateIdentity({ blockNumber: 50 }),
      data: { batchId: '42', merkleRoot: '0x' + '44'.repeat(32) } };
    adapter.listenForEvents = async function* () { yield incoming; };
    let now = 0;
    const seen: Array<Parameters<OnCollectionUpdated>[0]> = [];
    const saved: number[] = [];
    const poller = new ChainEventPoller({ chain: adapter, publishHandler: makeHandler(),
      intervalMs: 12_000, clock: () => now, onCollectionUpdated: async (info) => { seen.push(info); },
      cursorPersistence: { async loadLane() { return undefined; }, async saveLane(_lane, block) { saved.push(block); } } });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();
    await poll();
    expect(seen).toEqual([]);
    expect(saved).toEqual([]);
    incoming = { ...incoming, type: 'KnowledgeAssetUpdated' };
    now = 60_000;
    await poll();
    expect(seen).toHaveLength(1);
    expect(saved).toEqual([100]);
  });

  it('delivers distinct canonical-only logs with the same root and suppresses their exact replays', async () => {
    const identities = [7, 8].map((logIndex) => normalizeKnowledgeAssetUpdateIdentity({
      blockNumber: 160, logIndex, blockHash: '0xcanonical', txHash: '0xsame',
    }));
    const events: ChainEvent[] = identities.map((updateIdentity) => ({
      type: 'KnowledgeAssetUpdated', blockNumber: 160, updateIdentity,
      data: { batchId: '42', merkleRoot: '0x' + '44'.repeat(32) },
    }));
    let head = 200;
    let now = 0;
    const { adapter } = makeChain({ head: () => head, events });
    const seen: KnowledgeAssetUpdateIdentity[] = [];
    const poller = new ChainEventPoller({ chain: adapter, publishHandler: makeHandler(),
      intervalMs: 12_000, clock: () => now,
      onCollectionUpdated: async ({ eventIdentity }) => { seen.push(eventIdentity); } });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();
    await poll();
    expect(seen).toEqual(identities);
    expect(seen[0]).toBe(identities[0]);
    expect(seen[1]).toBe(identities[1]);
    now = 12_000;
    head = 201;
    await poll();
    expect(seen).toEqual(identities);
  });

  it('delivers a canonical-only replacement fork on a later poll and suppresses exact replays', async () => {
    const oldIdentity = normalizeKnowledgeAssetUpdateIdentity({ blockNumber: 160,
      logIndex: 7, blockHash: '0xold', txHash: '0xsame' });
    const canonical = normalizeKnowledgeAssetUpdateIdentity({ blockNumber: 160,
      logIndex: 7, blockHash: '0xcanonical', txHash: '0xsame' });
    const events: ChainEvent[] = [{ type: 'KnowledgeAssetUpdated', blockNumber: 160,
      updateIdentity: oldIdentity, data: { batchId: '42', merkleRoot: '0x' + '44'.repeat(32) } }];
    let head = 200;
    let now = 0;
    const { adapter } = makeChain({ head: () => head, events });
    const seen: KnowledgeAssetUpdateIdentity[] = [];
    const poller = new ChainEventPoller({ chain: adapter, publishHandler: makeHandler(),
      intervalMs: 12_000, clock: () => now,
      onCollectionUpdated: async ({ eventIdentity }) => { seen.push(eventIdentity); } });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();
    await poll();
    expect(seen).toEqual([oldIdentity]);
    now = 12_000;
    head = 201;
    await poll();
    expect(seen).toEqual([oldIdentity]);
    events[0] = { ...events[0], updateIdentity: canonical };
    now = 24_000;
    head = 202;
    await poll();
    expect(seen).toEqual([oldIdentity, canonical]);
    expect(seen[1]).toBe(canonical);
    now = 36_000;
    head = 203;
    await poll();
    expect(seen).toEqual([oldIdentity, canonical]);
  });

  it.each([
    { position: 'log', metadata: { txHash: '0xsame', logIndex: 7 } },
    { position: 'legacy-block', metadata: {} },
  ])('redelivers a $position replacement block below its cursor without restarting', async ({ metadata }) => {
    const oldFork: ChainEvent = {
      type: 'KnowledgeAssetUpdated', blockNumber: 160,
      data: { batchId: '42', merkleRoot: '0x' + '44'.repeat(32),
        blockHash: '0xold', ...metadata },
    };
    const events = [oldFork];
    let head = 200;
    let now = 0;
    const { adapter, filters } = makeChain({ head: () => head, events });
    const seen: string[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 12_000,
      clock: () => now,
      onCollectionUpdated: async ({ eventIdentity }) => { seen.push(eventIdentity.blockHash ?? ''); },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    await poll();
    expect(seen).toEqual(['0xold']);
    now = 12_000;
    head = 201;
    await poll();
    expect(seen).toEqual(['0xold']);

    events.splice(0, 1, { ...oldFork, data: { ...oldFork.data, blockHash: '0xcanonical' } });
    now = 24_000;
    head = 202;
    await poll();
    expect(seen).toEqual(['0xold', '0xcanonical']);
    expect(filters.at(-1)).toMatchObject({ fromBlock: 138, toBlock: 202 });
  });

  it('persists the cursor no higher than the ceiling of unsettled callback work', async () => {
    let head = 100;
    const { adapter } = makeChain({ head: () => head, events: [] });
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let ceiling: number | undefined = 49;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onCollectionUpdated: async () => { /* sink */ },
      collectionUpdatesPersistCeiling: () => ceiling,
    });
    let now = 0;

    await (poller as unknown as { poll(): Promise<void> }).poll();
    // The work settles: the next scan that advances persists its block.
    ceiling = undefined;
    head = 120;
    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(saveCalls).toEqual([
      { lane: 'collectionUpdates', block: 49 },
      { lane: 'collectionUpdates', block: 120 },
    ]);
  });

  it('holds the lane at a page whose callback fails and dispatches it again after the backoff', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 50,
      data: { merkleRoot: '0x' + '44'.repeat(32), batchId: '42' },
    };
    const { adapter } = makeChain({ head: 100, events: [event] });
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let now = 0;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 12_000,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onCollectionUpdated: async () => {
        calls += 1;
        if (calls === 1) throw new Error('store busy');
      },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    await poll();
    expect(calls).toBe(1);
    expect(saveCalls).toEqual([]);

    // Still inside the lane's failure backoff: nothing is scanned.
    now = 12_000;
    await poll();
    expect(calls).toBe(1);

    now = 60_000;
    await poll();
    expect(calls).toBe(2);
    expect(saveCalls).toEqual([{ lane: 'collectionUpdates', block: 100 }]);
  });
});
