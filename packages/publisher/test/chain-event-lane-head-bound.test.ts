import { describe, expect, it } from 'vitest';
import type { EventScanHorizonLease } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane, LaneCursorPersistence } from '../src/chain-event-poller.js';
import { ChainEventLaneRunner } from '../src/chain-event-lane-runner.js';
import type {
  ChainEventPollerLaneCursorStrategy,
  ChainEventPollerLaneSpec,
} from '../src/chain-event-lane-runner.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

/**
 * A lane may only move its cursor up to a head it has actually read.
 *
 * When every head read failed, the runner used to scan the next maxRange
 * blocks blind. A provider that answers a future range with [] then let it
 * save a cursor past the chain, and from there every poll read as "no work".
 */

function laneStore(initial: Partial<Record<ChainEventPollerLane, number>>) {
  const saved: Array<{ lane: ChainEventPollerLane; block: number }> = [];
  const persistence: LaneCursorPersistence = {
    loadLane: async (lane) => initial[lane],
    saveLane: async (lane, block) => { saved.push({ lane, block }); },
  };
  return { persistence, saved };
}

function recordingLog() {
  const warnings: string[] = [];
  const log = {
    info() {},
    warn(_ctx: unknown, message: string) { warnings.push(message); },
    error() {},
  };
  return { warnings, log: log as any };
}

function lane(
  name: ChainEventPollerLane,
  cursorStrategy: ChainEventPollerLaneCursorStrategy,
  eventTypes: readonly string[] = ['ContextGraphCreated'],
): ChainEventPollerLaneSpec {
  return {
    name,
    enabled: () => true,
    eventTypes: () => eventTypes,
    cursorStrategy: () => cursorStrategy,
    cadenceMs: 20,
    dispatch: async () => { /* sink */ },
  };
}

const scanLease = (throughBlockNumber: number): EventScanHorizonLease => ({
  throughBlockNumber,
  holds: async () => true,
});

const ranges = (filters: ReadonlyArray<{ fromBlock?: number; toBlock?: number }>) =>
  filters.map((f) => [f.fromBlock, f.toBlock]);

describe('chain event lane head bound', () => {
  it('neither scans, advances nor saves a lane while every head read fails', async () => {
    let headUp = false;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: () => {
        if (!headUp) throw new Error('head read failed on every endpoint');
        return 5_000;
      },
    });
    const store = laneStore({ contextGraphDiscovery: 4_000 });
    const { log, warnings } = recordingLog();
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane('contextGraphDiscovery', { kind: 'live-tail', legacyAggregateCursor: true })],
      maxRange: 9_000,
      clock: () => now,
      log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();
    // Before the fix this read [4_001, 13_000] blind and, answered with [],
    // saved 13_000.
    expect(filters).toEqual([]);
    expect(store.saved).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('chain head unknown')]);

    // It backs off like any failed lane instead of retrying on its cadence.
    now = 20;
    await runner.poll();
    expect(filters).toEqual([]);

    headUp = true;
    now = 60_000;
    await runner.poll();
    expect(ranges(filters)).toEqual([[4_001, 5_000]]);
    expect(store.saved).toEqual([{ lane: 'contextGraphDiscovery', block: 5_000 }]);
  });

  it('keeps the bounded page scan on an adapter with no head read at all', async () => {
    // The in-memory mock chain has no getBlockNumber; agent suites rely on its
    // first page scan to discover graphs created before the agent started.
    const { adapter, filters } = makeChain({ head: 0 });
    delete (adapter as { getBlockNumber?: unknown }).getBlockNumber;
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane('contextGraphDiscovery', { kind: 'live-tail', legacyAggregateCursor: true })],
      maxRange: 9_000,
      clock: () => 0,
      log: recordingLog().log,
    });

    await runner.poll();

    expect(ranges(filters)).toEqual([[1, 9_000]]);
  });

  it.each([
    {
      kind: 'live-tail' as const,
      name: 'contextGraphDiscovery' as const,
      strategy: { kind: 'live-tail', legacyAggregateCursor: true, liveSeedLookbackBlocks: 300 } as const,
      resetTo: 49_700,
      firstScans: [[49_701, 50_000]],
    },
    {
      kind: 'full-history' as const,
      name: 'allocatorReconcile' as const,
      strategy: { kind: 'full-history', legacyAggregateCursor: false } as const,
      resetTo: 50_000,
      firstScans: [],
    },
  ])('resets a saved $kind cursor above head, saves it, and then advances normally', async ({
    name,
    strategy,
    resetTo,
    firstScans,
  }) => {
    let head = 50_000;
    let now = 0;
    const { adapter, filters } = makeChain({ head: () => head });
    const store = laneStore({ [name]: 95_000 });
    const { log, warnings } = recordingLog();
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane(name, strategy)],
      maxRange: 9_000,
      clock: () => now,
      log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();
    expect(warnings).toEqual([
      `Poll lane ${name} cursor 95000 is past chain head 50000; reset to ${resetTo}`,
    ]);
    expect(ranges(filters)).toEqual(firstScans);
    expect(store.saved).toEqual([{ lane: name, block: 50_000 }]);

    head = 50_100;
    now = 20;
    await runner.poll();
    expect(ranges(filters)).toEqual([...firstScans, [50_001, 50_100]]);
    expect(store.saved).toEqual([
      { lane: name, block: 50_000 },
      { lane: name, block: 50_100 },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('saves a reset cursor even when the rescan from it fails', async () => {
    let failScan = true;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: 50_000,
      onListen: () => {
        if (failScan) throw new Error('rpc down');
      },
    });
    const store = laneStore({ vmReconcile: 95_000 });
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane(
        'vmReconcile',
        { kind: 'live-tail', legacyAggregateCursor: true },
        ['KnowledgeAssetRegisteredToContextGraph'],
      )],
      maxRange: 9_000,
      clock: () => now,
      log: recordingLog().log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();
    // A restart now reloads 49_500, not the cursor past the chain.
    expect(store.saved).toEqual([{ lane: 'vmReconcile', block: 49_500 }]);

    failScan = false;
    now = 60_000;
    await runner.poll();
    expect(ranges(filters)).toEqual([[49_501, 50_000], [49_501, 50_000]]);
    expect(store.saved).toEqual([
      { lane: 'vmReconcile', block: 49_500 },
      { lane: 'vmReconcile', block: 50_000 },
    ]);
  });

  it('resets a legacy aggregate cursor above head for the poller lanes that share it', async () => {
    const cursor = {
      saved: [] as number[],
      async load() { return 95_000; },
      async save(n: number) { this.saved.push(n); },
    };
    const { adapter, filters } = makeChain({ head: 50_000 });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => 0,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((f) => [f.eventTypes, f.fromBlock, f.toBlock])).toEqual([
      [['NameClaimed', 'ContextGraphCreated'], 49_501, 50_000],
      [['KnowledgeAssetRegisteredToContextGraph'], 49_501, 50_000],
    ]);
    expect(cursor.saved).toEqual([50_000]);
  });

  it('resets a cursor above a lease horizon against the live head that proves it past the chain', async () => {
    const { adapter, filters } = makeChain({
      head: 50_000,
      eventScanLease: () => scanLease(49_990),
    });
    const store = laneStore({ vmReconcile: 95_000 });
    const { log, warnings } = recordingLog();
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane(
        'vmReconcile',
        { kind: 'live-tail', legacyAggregateCursor: true },
        ['KnowledgeAssetRegisteredToContextGraph'],
      )],
      maxRange: 9_000,
      clock: () => 0,
      log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();

    expect(warnings).toEqual([
      'Poll lane vmReconcile cursor 95000 is past chain head 50000; reset to 49500',
    ]);
    expect(ranges(filters)).toEqual([[49_501, 50_000]]);
    expect(store.saved).toEqual([{ lane: 'vmReconcile', block: 50_000 }]);
  });

  it('leaves a cursor above a lagging lease horizon alone while the live head is past it', async () => {
    let liveHeadCalls = 0;
    const { adapter, filters } = makeChain({
      head: 50_010,
      eventScanLease: () => scanLease(49_990),
      onHead: () => { liveHeadCalls += 1; },
    });
    const store = laneStore({ vmReconcile: 50_000 });
    const { log, warnings } = recordingLog();
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane(
        'vmReconcile',
        { kind: 'live-tail', legacyAggregateCursor: true },
        ['KnowledgeAssetRegisteredToContextGraph'],
      )],
      maxRange: 9_000,
      clock: () => 0,
      log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();

    // The lane scanned past the horizon on the live head earlier; it waits for
    // the horizon to catch up, as before.
    expect(liveHeadCalls).toBe(1);
    expect(warnings).toEqual([]);
    expect(filters).toEqual([]);
    expect(store.saved).toEqual([]);
  });

  it('still bounds each scan by a known head', async () => {
    const { adapter, filters } = makeChain({ head: 50_000 });
    const store = laneStore({ contextGraphDiscovery: 1_000, vmReconcile: 49_900 });
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [
        lane('contextGraphDiscovery', { kind: 'live-tail', legacyAggregateCursor: true }),
        lane(
          'vmReconcile',
          { kind: 'live-tail', legacyAggregateCursor: true },
          ['KnowledgeAssetRegisteredToContextGraph'],
        ),
      ],
      maxRange: 9_000,
      clock: () => 0,
      log: recordingLog().log,
      cursorPersistence: store.persistence,
    });

    await runner.poll();

    expect(ranges(filters)).toEqual([[1_001, 10_000], [49_901, 50_000]]);
    expect(store.saved).toEqual([
      { lane: 'contextGraphDiscovery', block: 10_000 },
      { lane: 'vmReconcile', block: 50_000 },
    ]);
  });
});
