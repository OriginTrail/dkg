import { describe, expect, it, vi } from 'vitest';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { ChainEventLaneRunner } from '../src/chain-event-lane-runner.js';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import {
  STORE_BUSY_SCANS_BEFORE_ERROR,
  isBackgroundStoreBusyFailure,
} from '../src/chain-event-lane-scan-failures.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

/** The failure-backoff ceiling: a poll this much later always finds the lane due. */
const LATER = 5 * 60_000;

const backgroundBusy = () => new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'agent.vmRefresh.holders');

/** How the VM refresh reports a holders read the store did not serve. */
const wrappedBusy = () => new Error(
  'VM refresh: could not read which local graphs hold KA 7 for its update at block 150: '
    + 'Store scheduler queue wait timeout (background: agent.vmRefresh.holders)',
  { cause: backgroundBusy() },
);

function updateLane(options: {
  head: number | (() => number);
  events: ChainEvent[];
  dispatch: (event: ChainEvent) => Promise<void>;
  replayLookbackBlocks?: number;
}) {
  let now = 0;
  const saved: number[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { adapter } = makeChain({ head: options.head, events: options.events });
  const runner = new ChainEventLaneRunner({
    chain: adapter,
    lanes: [{
      name: 'collectionUpdates', enabled: () => true, eventTypes: () => ['KnowledgeAssetUpdated'],
      cursorStrategy: () => ({ kind: 'live-tail', legacyAggregateCursor: true }), cadenceMs: 20,
      dispatch: options.dispatch,
      ...(options.replayLookbackBlocks === undefined ? {} : { replayLookbackBlocks: options.replayLookbackBlocks }),
    }],
    maxRange: 9_000,
    clock: () => now,
    log: log as never,
    cursorPersistence: {
      async loadLane() { return undefined; },
      async saveLane(_lane, block) { saved.push(block); },
    },
  });
  const pollAt = async (at: number) => { now = at; await runner.poll(); };
  return { runner, log, saved, pollAt };
}

const update = (blockNumber: number): ChainEvent => ({ type: 'KnowledgeAssetUpdated', blockNumber, data: {} });

describe('chain event lane: a busy store is not a failure (#3578)', () => {
  it('warns that the range will be scanned again, holds the cursor and counts the busy scan', async () => {
    let refusals = 1;
    const dispatched: number[] = [];
    const lane = updateLane({
      head: 200,
      events: [update(150)],
      dispatch: async (event) => {
        if (refusals > 0) { refusals -= 1; throw wrappedBusy(); }
        dispatched.push(event.blockNumber);
      },
    });

    await lane.pollAt(0);
    expect(lane.log.error).not.toHaveBeenCalled();
    expect(lane.log.warn).toHaveBeenCalledTimes(1);
    expect(lane.log.warn.mock.calls[0][1]).toBe(
      'Poll lane collectionUpdates: store busy, blocks 1-200 will be scanned again (1 in a row): '
        + 'VM refresh: could not read which local graphs hold KA 7 for its update at block 150: '
        + 'Store scheduler queue wait timeout (background: agent.vmRefresh.holders)',
    );
    expect(lane.saved).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(lane.runner.storeBusyScans('collectionUpdates')).toBe(1);

    // The failure backoff still applies: the store is given time first.
    await lane.pollAt(30_000);
    expect(dispatched).toEqual([]);
    await lane.pollAt(60_000);
    expect(dispatched).toEqual([150]);
    expect(lane.saved).toEqual([200]);
    expect(lane.log.error).not.toHaveBeenCalled();
    expect(lane.runner.storeBusyScans('collectionUpdates')).toBe(1);
    expect(lane.runner.storeBusyScans('vmReconcile')).toBe(0);
  });

  it('logs an error once a busy store has held the same range for five scans in a row', async () => {
    const lane = updateLane({ head: 200, events: [update(150)], dispatch: async () => { throw wrappedBusy(); } });

    for (let scan = 1; scan < STORE_BUSY_SCANS_BEFORE_ERROR; scan += 1) {
      await lane.pollAt(scan * LATER);
      expect(lane.log.warn.mock.calls.at(-1)?.[1]).toContain(`will be scanned again (${scan} in a row)`);
    }
    expect(lane.log.error).not.toHaveBeenCalled();

    await lane.pollAt(STORE_BUSY_SCANS_BEFORE_ERROR * LATER);
    expect(lane.log.error).toHaveBeenCalledTimes(1);
    expect(lane.log.error.mock.calls[0][1]).toMatch(
      /^Poll lane collectionUpdates failed: VM refresh: .* \(store busy for 5 scans of blocks from 1 in a row\)$/,
    );
    await lane.pollAt((STORE_BUSY_SCANS_BEFORE_ERROR + 1) * LATER);
    expect(lane.log.error).toHaveBeenCalledTimes(2);
    expect(lane.log.warn).toHaveBeenCalledTimes(STORE_BUSY_SCANS_BEFORE_ERROR - 1);
    expect(lane.saved).toEqual([]);
    expect(lane.runner.storeBusyScans('collectionUpdates')).toBe(STORE_BUSY_SCANS_BEFORE_ERROR + 1);
  });

  it('starts a new streak once the lane has read its range', async () => {
    let head = 200;
    const events = [update(150)];
    let busy = true;
    const lane = updateLane({
      head: () => head,
      events,
      dispatch: async () => { if (busy) throw wrappedBusy(); },
    });
    for (let scan = 1; scan < STORE_BUSY_SCANS_BEFORE_ERROR; scan += 1) await lane.pollAt(scan * LATER);
    busy = false;
    await lane.pollAt(STORE_BUSY_SCANS_BEFORE_ERROR * LATER);
    expect(lane.saved).toEqual([200]);

    busy = true;
    head = 300;
    events.push(update(250));
    await lane.pollAt((STORE_BUSY_SCANS_BEFORE_ERROR + 1) * LATER);
    expect(lane.log.error).not.toHaveBeenCalled();
    expect(lane.log.warn.mock.calls.at(-1)?.[1]).toContain('blocks 201-300 will be scanned again (1 in a row)');
  });

  it('starts a new streak when a replay lane reads the same range again', async () => {
    // A lane that revisits its last blocks scans the same range again after a
    // success while the head stands still; only the success ends the streak.
    let busy = false;
    const events: ChainEvent[] = [];
    const addUpdate = () => {
      events.push({ type: 'KnowledgeAssetUpdated', blockNumber: 150, data: { txHash: `0x${events.length + 1}` } });
    };
    const lane = updateLane({
      head: 200,
      events,
      replayLookbackBlocks: 64,
      dispatch: async () => { if (busy) throw wrappedBusy(); },
    });
    addUpdate();
    await lane.pollAt(0);
    busy = true;
    for (let scan = 1; scan < STORE_BUSY_SCANS_BEFORE_ERROR; scan += 1) {
      addUpdate();
      await lane.pollAt(scan * LATER);
    }
    busy = false;
    await lane.pollAt(STORE_BUSY_SCANS_BEFORE_ERROR * LATER);
    busy = true;
    addUpdate();
    await lane.pollAt((STORE_BUSY_SCANS_BEFORE_ERROR + 1) * LATER);

    expect(lane.log.error).not.toHaveBeenCalled();
    expect(lane.log.warn.mock.calls.at(-1)?.[1]).toContain('blocks 137-200 will be scanned again (1 in a row)');
  });

  it('counts failures of another kind in the streak of the range they hold', async () => {
    let failure: () => Error = wrappedBusy;
    const lane = updateLane({ head: 200, events: [update(150)], dispatch: async () => { throw failure(); } });
    for (let scan = 1; scan < STORE_BUSY_SCANS_BEFORE_ERROR - 1; scan += 1) await lane.pollAt(scan * LATER);
    failure = () => new Error('chain adapter returned an unparseable log');
    await lane.pollAt((STORE_BUSY_SCANS_BEFORE_ERROR - 1) * LATER);
    expect(lane.log.error.mock.calls.at(-1)?.[1]).toBe(
      'Poll lane collectionUpdates failed: chain adapter returned an unparseable log',
    );
    failure = wrappedBusy;
    await lane.pollAt(STORE_BUSY_SCANS_BEFORE_ERROR * LATER);
    expect(lane.log.error).toHaveBeenCalledTimes(2);
    expect(lane.log.error.mock.calls.at(-1)?.[1]).toContain('(store busy for 5 scans of blocks from 1 in a row)');
  });

  it.each([
    ['a failure of another kind', () => new Error('Store query failed: syntax error')],
    ['a busy refusal of foreground work', () => new StoreSchedulerBusyError('queue_full', 'normal', 'publisher.query')],
  ])('keeps the error level for %s', async (_label, failure) => {
    const lane = updateLane({ head: 200, events: [update(150)], dispatch: async () => { throw failure(); } });

    await lane.pollAt(0);
    expect(lane.log.warn).not.toHaveBeenCalled();
    expect(lane.log.error).toHaveBeenCalledTimes(1);
    expect(lane.log.error.mock.calls[0][1]).toBe(`Poll lane collectionUpdates failed: ${failure().message}`);
    expect(lane.runner.storeBusyScans('collectionUpdates')).toBe(0);
  });

  it('reports the busy scans of a lane through the poller', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 150,
      data: {
        batchId: '7', merkleRoot: `0x${'11'.repeat(32)}`,
        txHash: `0x${'22'.repeat(32)}`, blockHash: `0x${'33'.repeat(32)}`, logIndex: 0,
      },
    };
    const { adapter } = makeChain({ head: 200, events: [event] });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onCollectionUpdated: async () => { throw wrappedBusy(); },
    });
    const log = (poller as unknown as { log: { warn(...args: unknown[]): void; error(...args: unknown[]): void } }).log;
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(poller.storeBusyScans('collectionUpdates')).toBe(1);
    expect(poller.storeBusyScans('vmReconcile')).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Poll lane collectionUpdates: store busy'));
    expect(error).not.toHaveBeenCalled();
  });
});

describe('isBackgroundStoreBusyFailure', () => {
  it('finds a background busy refusal itself or among the causes', () => {
    expect(isBackgroundStoreBusyFailure(backgroundBusy())).toBe(true);
    expect(isBackgroundStoreBusyFailure(new StoreSchedulerBusyError('queue_full', 'background', 'agent.query'))).toBe(true);
    expect(isBackgroundStoreBusyFailure(wrappedBusy())).toBe(true);
    expect(isBackgroundStoreBusyFailure(new Error('outer', { cause: wrappedBusy() }))).toBe(true);
  });

  it('refuses foreground lanes, look-alike text, other errors and unreadable values', () => {
    expect(isBackgroundStoreBusyFailure(new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'q'))).toBe(false);
    expect(isBackgroundStoreBusyFailure(new Error('Store scheduler queue wait timeout (background: x)'))).toBe(false);
    expect(isBackgroundStoreBusyFailure({ code: 'STORE_SCHEDULER_BUSY', priority: 'background' })).toBe(false);
    expect(isBackgroundStoreBusyFailure(undefined)).toBe(false);
    expect(isBackgroundStoreBusyFailure('busy')).toBe(false);
    const unreadable = Object.defineProperty({}, 'code', { get() { throw new Error('unreadable'); } });
    expect(isBackgroundStoreBusyFailure(unreadable)).toBe(false);
  });

  it('stops after a bounded number of causes', () => {
    let error: Error = backgroundBusy();
    for (let depth = 0; depth < 8; depth += 1) error = new Error(`wrap ${depth}`, { cause: error });
    expect(isBackgroundStoreBusyFailure(error)).toBe(false);
    const cyclic = new Error('cyclic') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isBackgroundStoreBusyFailure(cyclic)).toBe(false);
  });
});
