import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';
import { PublishJournal } from '../src/publish-journal.js';
import { createLaneFixture, laneCursor, legacyCursor } from './_helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller public lifecycle and policy wiring', () => {
  const stores: OxigraphStore[] = [];
  const pollers: ChainEventPoller[] = [];
  function handler(journal?: PublishJournal) {
    const store = new OxigraphStore();
    stores.push(store);
    return new PublishHandler(store, new TypedEventBus(), { journal });
  }
  function poller(config: ConstructorParameters<typeof ChainEventPoller>[0]) {
    const instance = new ChainEventPoller(config);
    pollers.push(instance);
    return instance;
  }
  afterEach(async () => {
    for (const instance of pollers.splice(0)) await instance.stop();
    for (const store of stores.splice(0)) await store.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not start scanning when stopped during asynchronous cursor restoration', async () => {
    vi.useFakeTimers();
    const f = createLaneFixture();
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const instance = poller({ chain: f.chain, publishHandler: handler(), intervalMs: 10,
      onProfileEvent: async () => {},
      cursorPersistence: { async loadLane() { began(); await blocked; return undefined; }, async saveLane() {} },
    });
    const starting = instance.start();
    await started;
    await instance.stop();
    release();
    await starting;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.state.headReads).toBe(0);
    expect(f.state.filters).toEqual([]);
  });

  it('restores a real journal and routes an old publish event through confirmation', async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-poller-journal-'));
    try {
      const journal = new PublishJournal(dir);
      const root = '0x' + '55'.repeat(32);
      const publisher = '0x' + 'a1'.repeat(20);
      await journal.save([{ ual: `did:dkg:mock:0/${publisher}/1`, contextGraphId: 'contextGraph-1',
        expectedPublisherAddress: publisher, expectedMerkleRoot: root,
        expectedStartKAId: '1', expectedEndKAId: '1', expectedChainId: 'mock:0',
        rootEntities: [], createdAt: Date.now() }]);
      const publishHandler = handler(journal);
      expect(await publishHandler.restorePendingPublishes()).toBe(1);
      expect(publishHandler.hasRestoredPendingPublishes).toBe(true);
      const confirmation = vi.spyOn(publishHandler, 'confirmByMerkleRoot').mockResolvedValue(true);
      const f = createLaneFixture(10_000);
      f.state.events = [{ type: 'KCCreated', blockNumber: 1, data: {
        kaId: '1', author: publisher, merkleRoot: root, publisherAddress: publisher,
        startKAId: '1', endKAId: '1', txHash: '0xabc', txIndex: 0,
      } }];
      const instance = poller({ chain: f.chain, publishHandler, intervalMs: 60_000 });
      await instance.start();
      await instance.waitForCurrentPoll();
      await instance.stop();
      expect(f.state.filters).toEqual([{ eventTypes: ['KCCreated'], fromBlock: 1, toBlock: 9000 }]);
      expect(confirmation).toHaveBeenCalledOnce();
      expect(confirmation.mock.calls[0][0]).toEqual(new Uint8Array(32).fill(0x55));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('gives a fresh pending publish an isolated recent page despite a legacy cursor', async () => {
    const f = createLaneFixture(20_000_000);
    const publishHandler = handler();
    vi.spyOn(publishHandler, 'hasPendingPublishes', 'get').mockReturnValue(true);
    vi.spyOn(publishHandler, 'hasRestoredPendingPublishes', 'get').mockReturnValue(false);
    const cursor = legacyCursor(50);
    const instance = poller({ chain: f.chain, publishHandler, intervalMs: 60_000, cursorPersistence: cursor.cursor });
    await instance.start();
    await instance.waitForCurrentPoll();
    expect(f.state.filters).toEqual([{ eventTypes: ['KCCreated'], fromBlock: 19_991_001, toBlock: 20_000_000 }]);
    expect(cursor.state.loads).toBe(0);
  });

  it('dispatches a near-head ContextGraphCreated payload through the public callback', async () => {
    const f = createLaneFixture(20_000_000);
    const data = { contextGraphId: '42', creator: '0x' + 'a1'.repeat(20),
      accessPolicy: 0, publishPolicy: 1, nameHash: '0x' + 'ab'.repeat(32) };
    f.state.events = [{ type: 'ContextGraphCreated', blockNumber: 19_999_990, data }];
    const onContextGraphCreated = vi.fn(async () => {});
    const instance = poller({ chain: f.chain, publishHandler: handler(), intervalMs: 60_000, onContextGraphCreated });
    await instance.start();
    await instance.waitForCurrentPoll();
    expect(f.state.filters).toEqual([{ eventTypes: ['NameClaimed', 'ContextGraphCreated'], fromBlock: 19_999_501, toBlock: 20_000_000 }]);
    expect(onContextGraphCreated).toHaveBeenCalledWith({ ...data, blockNumber: 19_999_990 });
  });

  it('dispatches converted collection update fields and persists its own lane cursor', async () => {
    const f = createLaneFixture(100);
    f.state.events = [{ type: 'KnowledgeAssetUpdated', blockNumber: 50,
      data: { merkleRoot: '0x' + '44'.repeat(32), batchId: '42' } }];
    const cursor = laneCursor();
    const onCollectionUpdated = vi.fn(async () => {});
    const instance = poller({ chain: f.chain, publishHandler: handler(), intervalMs: 60_000,
      cursorPersistence: cursor.cursor, onCollectionUpdated });
    await instance.start();
    await instance.waitForCurrentPoll();
    expect(f.state.filters[0].eventTypes).toEqual(['KnowledgeAssetUpdated']);
    expect(onCollectionUpdated).toHaveBeenCalledWith({ merkleRoot: new Uint8Array(32).fill(0x44), batchId: 42n, blockNumber: 50 });
    expect(cursor.saves).toEqual([['collectionUpdates', 100]]);
  });
});
