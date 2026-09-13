import { describe, expect, it } from 'vitest';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { ChainEventLaneRunner } from '../src/chain-event-lane-runner.js';
import type { ChainEventPollerLaneSpec } from '../src/chain-event-lane-runner.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller scheduler', () => {
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
