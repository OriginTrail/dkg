import { describe, expect, it } from 'vitest';
import {
  activeRpcRequestContext,
  type ChainAdapter,
  type ChainEvent,
  type EventFilter,
  type EventScanHorizonLease,
} from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { ChainEventLaneRunner } from '../src/chain-event-lane-runner.js';
import type { ChainEventPollerLaneSpec } from '../src/chain-event-lane-runner.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

const scanLease = (
  throughBlockNumber: number,
  holds: () => Promise<boolean> = async () => true,
): EventScanHorizonLease => ({ throughBlockNumber, holds });

describe('ChainEventPoller scheduler', () => {
  it('classifies every poller RPC as background work', async () => {
    const requestClasses: string[] = [];
    const { adapter } = makeChain({
      head: () => {
        requestClasses.push(activeRpcRequestContext().requestClass);
        return 100;
      },
      onListen: () => {
        requestClasses.push(activeRpcRequestContext().requestClass);
      },
    });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(requestClasses.length).toBeGreaterThanOrEqual(2);
    expect(requestClasses).toEqual(requestClasses.map(() => 'background'));
  });

  it('live-tails context graph discovery near the current head on cold start', async () => {
    const { adapter, filters } = makeChain({ head: 10_000, events: [] });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(9501);
    expect(filters[0].toBlock).toBe(10_000);
  });

  it('dispatches a near-head context graph event on the first poll', async () => {
    const event: ChainEvent = {
      type: 'ContextGraphCreated',
      blockNumber: 19_999_990,
      data: {
        contextGraphId: '42',
        creator: '0x' + 'a1'.repeat(20),
        accessPolicy: 0,
        publishPolicy: 1,
        nameHash: '0x' + 'ab'.repeat(32),
      },
    };
    const { adapter, filters } = makeChain({ head: 20_000_000, events: [event] });
    const seen: Array<{ contextGraphId: string; blockNumber: number }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async (info) => { seen.push(info); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(19_999_501);
    expect(filters[0].toBlock).toBe(20_000_000);
    expect(seen).toMatchObject([{ contextGraphId: '42', blockNumber: 19_999_990 }]);
  });

  it('tails context graph discovery on the normal poll cadence', async () => {
    let now = 0;
    let head = 1000;
    let blockNumberCalls = 0;
    const { adapter, filters } = makeChain({
      head: () => {
        blockNumberCalls++;
        return head;
      },
    });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* normal-cadence lane */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);

    now = 25;
    head = 1100;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(blockNumberCalls).toBe(2);
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);
    expect(filters[2].fromBlock).toBe(1001);
    expect(filters[2].toBlock).toBe(1100);
    expect(filters[3].fromBlock).toBe(1001);
    expect(filters[3].toBlock).toBe(1100);
  });

  it('keeps a mixed lane live while an exact indexed lane uses its lease', async () => {
    let liveHeadCalls = 0;
    const { adapter, filters } = makeChain({
      head: 1_000,
      eventScanLease: (eventTypes) => eventTypes.length === 1
        && eventTypes[0] === 'KnowledgeAssetRegisteredToContextGraph'
        ? scanLease(100)
        : undefined,
      onHead: () => { liveHeadCalls += 1; },
    });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => 0,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(liveHeadCalls).toBe(1);
    expect(filters.map((filter) => ({
      events: filter.eventTypes,
      from: filter.fromBlock,
      to: filter.toBlock,
    }))).toEqual([
      { events: ['NameClaimed', 'ContextGraphCreated'], from: 501, to: 1_000 },
      { events: ['KnowledgeAssetRegisteredToContextGraph'], from: 1, to: 100 },
    ]);
  });

  it('keeps a sole unsupported lane on the live head', async () => {
    let liveHeadCalls = 0;
    const requested: string[][] = [];
    const { adapter, filters } = makeChain({
      head: 1_000,
      eventScanLease: (eventTypes) => {
        requested.push([...eventTypes]);
        return undefined;
      },
      onHead: () => { liveHeadCalls += 1; },
    });
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [{
        name: 'allowListUpdates',
        enabled: () => true,
        eventTypes: () => ['AllowListUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* sink */ },
      }],
      maxRange: 9_000,
      clock: () => 0,
      log: { info() {}, warn() {}, error() {} } as any,
    });

    await runner.poll();

    expect(requested).toEqual([['AllowListUpdated']]);
    expect(liveHeadCalls).toBe(1);
    expect(filters).toMatchObject([{ fromBlock: 501, toBlock: 1_000 }]);
  });

  it('falls back to the live head for absent, throwing or invalid leases', async () => {
    const leaseReaders: Array<() => EventScanHorizonLease | undefined> = [
      () => undefined,
      () => { throw new Error('log unavailable'); },
      () => scanLease(-1),
      () => scanLease(10.5),
    ];

    for (const eventScanLease of leaseReaders) {
      let liveHeadCalls = 0;
      const { adapter, filters } = makeChain({
        head: 1_000,
        eventScanLease,
        onHead: () => { liveHeadCalls += 1; },
      });
      const lane: ChainEventPollerLaneSpec = {
        name: 'contextGraphDiscovery',
        enabled: () => true,
        eventTypes: () => ['ContextGraphCreated'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* sink */ },
      };
      const runner = new ChainEventLaneRunner({
        chain: adapter,
        lanes: [lane],
        maxRange: 9_000,
        clock: () => 0,
        log: { info() {}, warn() {}, error() {} } as any,
      });

      await runner.poll();

      expect(liveHeadCalls).toBe(1);
      expect(filters).toMatchObject([{ fromBlock: 501, toBlock: 1_000 }]);
    }
  });

  it('catches a delayed event after the conservative lease advances', async () => {
    let now = 0;
    let horizon = 100;
    const delayed: ChainEvent = {
      type: 'KnowledgeAssetRegisteredToContextGraph',
      blockNumber: 110,
      data: {
        contextGraphId: '42',
        kaId: '7',
        txHash: '0x' + 'ab'.repeat(32),
      },
    };
    const { adapter, filters } = makeChain({
      head: 1_000,
      eventScanLease: () => scanLease(horizon),
      events: [delayed],
    });
    const seen: number[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => now,
      onKARegisteredToContextGraph: async (event) => { seen.push(event.blockNumber); },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(seen).toEqual([]);
    horizon = 120;
    now = 20;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([
      [1, 100],
      [101, 120],
    ]);
    expect(seen).toEqual([110]);
  });

  it('advances only the successful lane and retries a failed horizon range intact', async () => {
    let now = 0;
    let failDiscovery = true;
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const { adapter, filters } = makeChain({
      head: 1_000,
      eventScanLease: scanLease(100),
      onListen: (filter) => {
        if (failDiscovery && filter.eventTypes.includes('ContextGraphCreated')) {
          failDiscovery = false;
          throw new Error('discovery unavailable');
        }
      },
    });
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const lanes: ChainEventPollerLaneSpec[] = [
      {
        name: 'contextGraphDiscovery',
        enabled: () => true,
        eventTypes: () => ['ContextGraphCreated'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* sink */ },
      },
      {
        name: 'vmReconcile',
        enabled: () => true,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* sink */ },
      },
    ];
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes,
      maxRange: 9_000,
      clock: () => now,
      log: { info() {}, warn() {}, error() {} } as any,
      cursorPersistence: cursor,
    });

    await runner.poll();
    expect(saveCalls).toEqual([{ lane: 'vmReconcile', block: 100 }]);

    now = 60_000;
    await runner.poll();

    expect(filters.map((filter) => [filter.eventTypes[0], filter.fromBlock, filter.toBlock]))
      .toEqual([
        ['ContextGraphCreated', 1, 100],
        ['KnowledgeAssetRegisteredToContextGraph', 1, 100],
        ['ContextGraphCreated', 1, 100],
      ]);
    expect(saveCalls).toEqual([
      { lane: 'vmReconcile', block: 100 },
      { lane: 'contextGraphDiscovery', block: 100 },
    ]);
  });

  it('stops A dispatch immediately after rotation and replays both B events at or below H', async () => {
    let generation: 'A' | 'B' = 'A';
    let now = 0;
    const filters: EventFilter[] = [];
    const saved: number[] = [];
    const seen: string[] = [];
    let releaseDispatch = (): void => {};
    let markDispatchStarted = (): void => {};
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 1_000,
      acquireEventScanHorizonLease: async (eventTypes: readonly string[]) => {
        if (
          eventTypes.length !== 1
          || eventTypes[0] !== 'KnowledgeAssetRegisteredToContextGraph'
        ) return undefined;
        const issuedFor = generation;
        return scanLease(100, async () => generation === issuedFor);
      },
      listenForEvents: async function* (filter: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(filter);
        const scanGeneration = generation;
        for (const row of [1, 2]) {
          yield {
            type: 'KnowledgeAssetRegisteredToContextGraph',
            blockNumber: 49 + row,
            data: { generation: scanGeneration, row },
          };
        }
      },
    } as unknown as ChainAdapter;
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [{
        name: 'vmReconcile',
        enabled: () => true,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async (event) => {
          const observed = `${String(event.data['generation'])}:${String(event.data['row'])}`;
          seen.push(observed);
          if (observed === 'A:1') {
            markDispatchStarted();
            await new Promise<void>((resolve) => { releaseDispatch = resolve; });
          }
        },
      }],
      maxRange: 9_000,
      clock: () => now,
      log: { info() {}, warn() {}, error() {} } as any,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(_lane, block) { saved.push(block); },
      },
    });

    const firstPoll = runner.poll();
    await dispatchStarted;
    generation = 'B';
    releaseDispatch();
    await firstPoll;

    expect(saved).toEqual([]);
    expect(filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[1, 100]]);
    expect(seen).toEqual(['A:1']);

    now = 60_000;
    await runner.poll();

    expect(filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([
      [1, 100],
      [1, 100],
    ]);
    expect(seen).toEqual(['A:1', 'B:1', 'B:2']);
    expect(saved).toEqual([100]);
  });

  it('rechecks each lease at its own cursor save after another lane blocks validation', async () => {
    let laneOneCurrent = true;
    let laneOneHolds = 0;
    let laneTwoHolds = 0;
    let releaseLaneTwoValidation = (): void => {};
    let markLaneTwoValidationStarted = (): void => {};
    const laneTwoValidationStarted = new Promise<void>((resolve) => {
      markLaneTwoValidationStarted = resolve;
    });
    const saved: ChainEventPollerLane[] = [];
    const adapter = {
      chainId: 'mock:0',
      acquireEventScanHorizonLease: async (eventTypes: readonly string[]) => {
        if (eventTypes[0] === 'ContextGraphCreated') {
          return scanLease(100, async () => {
            laneOneHolds += 1;
            return laneOneCurrent;
          });
        }
        return scanLease(100, async () => {
          laneTwoHolds += 1;
          if (laneTwoHolds === 2) {
            markLaneTwoValidationStarted();
            await new Promise<void>((resolve) => { releaseLaneTwoValidation = resolve; });
          }
          return true;
        });
      },
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        // Empty successful ranges still advance, and therefore still require
        // their own currentness proof at the exact persistence boundary.
      },
    } as unknown as ChainAdapter;
    const lanes: ChainEventPollerLaneSpec[] = [
      {
        name: 'contextGraphDiscovery',
        enabled: () => true,
        eventTypes: () => ['ContextGraphCreated'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* no rows */ },
      },
      {
        name: 'vmReconcile',
        enabled: () => true,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* no rows */ },
      },
    ];
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes,
      maxRange: 9_000,
      clock: () => 0,
      log: { info() {}, warn() {}, error() {} } as any,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane) { saved.push(lane); },
      },
    });

    const poll = runner.poll();
    await laneTwoValidationStarted;
    expect(laneOneHolds).toBe(2);
    laneOneCurrent = false;
    releaseLaneTwoValidation();
    await poll;

    expect(laneOneHolds).toBe(3);
    expect(laneTwoHolds).toBe(3);
    expect(saved).toEqual(['vmReconcile']);
  });

  it('rechecks a lease at the legacy aggregate save boundary', async () => {
    let holds = 0;
    const saved: number[] = [];
    const adapter = {
      chainId: 'mock:0',
      acquireEventScanHorizonLease: async () => scanLease(100, async () => {
        holds += 1;
        return holds < 3;
      }),
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        // no rows
      },
    } as unknown as ChainAdapter;
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [{
        name: 'vmReconcile',
        enabled: () => true,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: 20,
        dispatch: async () => { /* no rows */ },
      }],
      maxRange: 9_000,
      clock: () => 0,
      log: { info() {}, warn() {}, error() {} } as any,
      cursorPersistence: {
        async load() { return undefined; },
        async save(block) { saved.push(block); },
      },
    });

    await runner.poll();

    expect(holds).toBe(3);
    expect(saved).toEqual([]);
  });

  it('backs off a failed context graph discovery lane and retries the same range later', async () => {
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: 100,
      onListen: () => {
        calls++;
        if (calls === 1) throw new Error('rpc down');
      },
    });
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 20;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(filters).toHaveLength(1);

    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(2);
    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[1].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(100);
    expect(filters[1].fromBlock).toBe(1);
    expect(filters[1].toBlock).toBe(100);
    expect(saveCalls).toEqual([{ lane: 'contextGraphDiscovery', block: 100 }]);
  });

  it('exponentially backs off repeated lane failures and resets after success', async () => {
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let head = 100;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: () => head,
      onListen: () => {
        calls++;
        if (calls === 1 || calls === 2 || calls === 4) throw new Error('rpc down');
      },
    });
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 120_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 180_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
    ]);
    expect(saveCalls).toEqual([{ lane: 'contextGraphDiscovery', block: 100 }]);

    head = 200;
    now = 180_020;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 240_019;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 240_020;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
      [101, 200],
      [101, 200],
    ]);
    expect(saveCalls).toEqual([
      { lane: 'contextGraphDiscovery', block: 100 },
      { lane: 'contextGraphDiscovery', block: 200 },
    ]);
  });

  it('caps repeated lane failures at the internal max backoff', async () => {
    let calls = 0;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: 100,
      onListen: () => {
        calls++;
        if (calls <= 5) throw new Error('rpc down');
      },
    });
    const lane: ChainEventPollerLaneSpec = {
      name: 'contextGraphDiscovery',
      enabled: () => true,
      eventTypes: () => ['ContextGraphCreated'],
      requiresFullHistory: () => false,
      cadenceMs: 20,
      dispatch: async () => { /* sink */ },
    };
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane],
      maxRange: 1000,
      clock: () => now,
      log: { info() {}, warn() {}, error() {} } as any,
    });

    await runner.poll();
    now = 59_999;
    await runner.poll();
    now = 60_000;
    await runner.poll();
    now = 179_999;
    await runner.poll();
    now = 180_000;
    await runner.poll();
    now = 419_999;
    await runner.poll();
    now = 420_000;
    await runner.poll();
    now = 719_999;
    await runner.poll();
    now = 720_000;
    await runner.poll();
    now = 1_019_999;
    await runner.poll();
    now = 1_020_000;
    await runner.poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
      [1, 100],
      [1, 100],
      [1, 100],
    ]);
  });

  it('keeps headless scans due until a known head proves the lane is caught up', async () => {
    const { adapter, filters } = makeChain({
      head: () => { throw new Error('head unavailable'); },
    });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => 0,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 90));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(2);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(filters[1].fromBlock).toBe(9001);
    expect(filters[1].toBlock).toBe(18_000);
  });
});
