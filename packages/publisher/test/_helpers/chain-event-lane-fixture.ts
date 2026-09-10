import { Logger } from '@origintrail-official/dkg-core';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { ChainEventLaneRunner, type ChainEventCursorStrategy, type ChainEventPollerLane, type ChainEventPollerLaneSpec } from '../../src/chain-event-lane-runner.js';
import type { CursorPersistence, LaneCursorPersistence, LegacyCursorPersistence } from '../../src/chain-event-lane-cursor-store.js';

export function lane(name: ChainEventPollerLane, eventTypes: string[], strategy: ChainEventCursorStrategy = { kind: 'live-tail' }) {
  const state = {
    enabled: true,
    strategy,
    events: [] as ChainEvent[],
    dispatch: async (_event: ChainEvent): Promise<void> => {},
  };
  const spec: ChainEventPollerLaneSpec = {
    name, enabled: () => state.enabled, eventTypes: () => eventTypes,
    cursorStrategy: () => state.strategy, cadenceMs: 20,
    dispatch: async (event) => { state.events.push(event); await state.dispatch(event); },
  };
  return { state, spec };
}

export function createLaneFixture(initialHead: number | undefined = 1000) {
  const state = {
    now: 0, head: initialHead, headReads: 0,
    filters: [] as EventFilter[], events: [] as ChainEvent[],
    beforeScan: async (_filter: EventFilter): Promise<void> => {},
  };
  const chain = {
    chainId: 'mock:0',
    async getBlockNumber() { state.headReads++; if (state.head === undefined) throw new Error('head unavailable'); return state.head; },
    async *listenForEvents(filter: EventFilter) {
      state.filters.push(filter);
      await state.beforeScan(filter);
      for (const event of state.events) {
        if (filter.eventTypes.includes(event.type) && event.blockNumber >= (filter.fromBlock ?? 0)
          && event.blockNumber <= (filter.toBlock ?? Infinity)) yield event;
      }
    },
  } as unknown as ChainAdapter;
  return {
    state, chain,
    runner(lanes: ChainEventPollerLaneSpec[], cursorPersistence?: CursorPersistence, maxRange = 9000) {
      return new ChainEventLaneRunner({ chain, lanes, cursorPersistence, maxRange,
        clock: () => state.now, log: new Logger('lane-fixture') });
    },
  };
}

export function laneCursor(initial: Array<[ChainEventPollerLane, number]> = []) {
  const values = new Map(initial);
  const loads: ChainEventPollerLane[] = [];
  const saves: Array<[ChainEventPollerLane, number]> = [];
  const cursor: LaneCursorPersistence = {
    async loadLane(name) { loads.push(name); return values.get(name); },
    async saveLane(name, block) { saves.push([name, block]); values.set(name, block); },
  };
  return { cursor, values, loads, saves };
}

export function legacyCursor(initial?: number) {
  const state = { value: initial, loads: 0, saves: [] as number[] };
  const cursor: LegacyCursorPersistence = {
    async load() { state.loads++; return state.value; },
    async save(block) { state.saves.push(block); state.value = block; },
  };
  return { cursor, state };
}
