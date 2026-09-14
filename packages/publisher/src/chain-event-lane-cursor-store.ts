import {
  CHAIN_EVENT_POLLER_LANES,
  type ChainEventPollerLane,
} from './chain-event-lanes.js';

/** Legacy aggregate cursor persistence for saving/loading one shared cursor. */
export interface LegacyCursorPersistence {
  load(): Promise<number | undefined>;
  save(blockNumber: number): Promise<void>;
}

/** Lane-aware cursor persistence for saving/loading independent lane cursors. */
export interface LaneCursorPersistence {
  loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
  saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
  /**
   * Seed several lanes at one block as a single committed operation.
   *
   * Persistence that can commit lanes together owns bulk seeding, so a failed
   * seed never leaves a partially advanced poller frontier behind. Adapters
   * that cannot are still supported: the store then degrades to sequential
   * `saveLane` calls.
   */
  saveLanes?(lanes: readonly ChainEventPollerLane[], blockNumber: number): Promise<void>;
}

export type CursorPersistence = LegacyCursorPersistence | LaneCursorPersistence;

export type LaneCursorStore =
  | {
      kind: 'lane';
      loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
      saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
      /** One semantic operation, committed by the persistence owner. */
      seedLanes(lanes: readonly ChainEventPollerLane[], blockNumber: number): Promise<void>;
    }
  | {
      kind: 'legacy';
      loadLegacyAggregate(): Promise<number | undefined>;
      saveLegacyAggregate(blockNumber: number): Promise<void>;
    };

export function createLaneCursorStore(cursorPersistence?: CursorPersistence): LaneCursorStore | undefined {
  if (!cursorPersistence) return undefined;
  const maybeLane = cursorPersistence as Partial<LaneCursorPersistence>;
  const hasLoadLane = typeof maybeLane.loadLane === 'function';
  const hasSaveLane = typeof maybeLane.saveLane === 'function';
  if (hasLoadLane || hasSaveLane) {
    if (!hasLoadLane || !hasSaveLane) {
      throw new Error('ChainEventPoller cursorPersistence must provide both loadLane and saveLane, or neither.');
    }
    const laneStore = cursorPersistence as LaneCursorPersistence;
    const saveLanes = laneStore.saveLanes?.bind(laneStore);
    return {
      kind: 'lane',
      loadLane: (lane) => laneStore.loadLane(lane),
      saveLane: (lane, blockNumber) => laneStore.saveLane(lane, blockNumber),
      seedLanes: async (lanes, blockNumber) => {
        if (saveLanes) {
          await saveLanes(lanes, blockNumber);
          return;
        }
        for (const lane of lanes) await laneStore.saveLane(lane, blockNumber);
      },
    };
  }

  const legacyStore = cursorPersistence as LegacyCursorPersistence;
  let loaded: Promise<number | undefined> | undefined;
  return {
    kind: 'legacy',
    loadLegacyAggregate: async () => {
      loaded ??= legacyStore.load();
      return loaded;
    },
    saveLegacyAggregate: (blockNumber) => legacyStore.save(blockNumber),
  };
}

export async function seedLaneCursorStore(
  cursorStore: LaneCursorStore | undefined,
  lanes: readonly ChainEventPollerLane[],
  blockNumber: number,
): Promise<void> {
  if (!cursorStore) throw new Error('Chain event cursor persistence is not configured.');
  // The accepted seed domain has to match what a cursor can restore. Zero is
  // the runner's "no cursor yet" sentinel and the persistence layer's own
  // invariant (the node database constrains cursor rows to positive block
  // numbers), so a zero seed would silently degrade to an absent cursor and
  // let a live-tail lane resume near the head instead of at block 1.
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) {
    throw new Error('Chain event cursor seed must be a positive safe integer.');
  }
  if (cursorStore.kind === 'legacy') {
    await cursorStore.saveLegacyAggregate(blockNumber);
    return;
  }
  await cursorStore.seedLanes([...new Set(lanes)], blockNumber);
}

/**
 * Seed persistent storage for every production poller lane without constructing a poller.
 *
 * Only lane-aware persistence can honour that contract. A legacy aggregate
 * cursor is deliberately ignored by full-history lanes such as
 * `allocatorReconcile`, so one aggregate write would report success while that
 * lane still replays its complete history after the next restart. Seeding a
 * legacy aggregate therefore has to stay a runner-scoped operation, where the
 * seed also lives in the lane state for the rest of that runner's lifetime.
 */
export async function seedChainEventPollerCursors(
  cursorPersistence: CursorPersistence,
  blockNumber: number,
): Promise<void> {
  const cursorStore = createLaneCursorStore(cursorPersistence);
  if (cursorStore?.kind === 'legacy') {
    throw new Error(
      'Chain event cursor persistence must provide loadLane and saveLane to seed every production poller lane; '
      + 'a legacy aggregate cursor cannot restore full-history lanes.',
    );
  }
  await seedLaneCursorStore(cursorStore, CHAIN_EVENT_POLLER_LANES, blockNumber);
}
