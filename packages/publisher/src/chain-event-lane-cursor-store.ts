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
}

export type CursorPersistence = LegacyCursorPersistence | LaneCursorPersistence;

export type LaneCursorStore =
  | {
      kind: 'lane';
      loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
      saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
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
    return {
      kind: 'lane',
      loadLane: (lane) => laneStore.loadLane(lane),
      saveLane: (lane, blockNumber) => laneStore.saveLane(lane, blockNumber),
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
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('Chain event cursor seed must be a non-negative safe integer.');
  }
  if (cursorStore.kind === 'legacy') {
    await cursorStore.saveLegacyAggregate(blockNumber);
    return;
  }
  for (const lane of new Set(lanes)) await cursorStore.saveLane(lane, blockNumber);
}

/** Seed persistent storage for every production poller lane without constructing a poller. */
export async function seedChainEventPollerCursors(
  cursorPersistence: CursorPersistence,
  blockNumber: number,
): Promise<void> {
  await seedLaneCursorStore(
    createLaneCursorStore(cursorPersistence),
    CHAIN_EVENT_POLLER_LANES,
    blockNumber,
  );
}
