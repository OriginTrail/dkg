import type { ChainEventPollerLane } from './chain-event-lane-runner.js';

/** Legacy aggregate cursor persistence for saving/loading one shared cursor. */
export interface LegacyCursorPersistence {
  load(): Promise<number | undefined>;
  save(blockNumber: number): Promise<void>;
}

/** An inclusive replay window whose durable dispatch rejected (review r20). */
export interface LaneReplayRetryWindow {
  fromBlock: number;
  toBlock: number;
}

/**
 * Lane-aware cursor persistence for saving/loading independent lane cursors.
 *
 * The replay-retry methods are OPTIONAL (review r20): the in-process retained
 * window (r19) survives a restart only when the store persists it — the
 * forward cursor is durable, so without these a rejected replay discovery
 * could be lost across a restart while the cursor stays ahead of it. A store
 * that implements one must implement all three; `saveLaneReplayRetry` with
 * `undefined` clears the persisted window.
 */
export interface LaneCursorPersistence {
  loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
  saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
  loadLaneReplayRetry?(lane: ChainEventPollerLane): Promise<LaneReplayRetryWindow | undefined>;
  saveLaneReplayRetry?(lane: ChainEventPollerLane, window: LaneReplayRetryWindow | undefined): Promise<void>;
}

export type CursorPersistence = LegacyCursorPersistence | LaneCursorPersistence;

export type LaneCursorStore =
  | {
      kind: 'lane';
      loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
      saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
      loadLaneReplayRetry?(lane: ChainEventPollerLane): Promise<LaneReplayRetryWindow | undefined>;
      saveLaneReplayRetry?(lane: ChainEventPollerLane, window: LaneReplayRetryWindow | undefined): Promise<void>;
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
      ...(laneStore.loadLaneReplayRetry && laneStore.saveLaneReplayRetry
        ? {
            loadLaneReplayRetry: (lane: ChainEventPollerLane) => laneStore.loadLaneReplayRetry!(lane),
            saveLaneReplayRetry: (lane: ChainEventPollerLane, window: LaneReplayRetryWindow | undefined) =>
              laneStore.saveLaneReplayRetry!(lane, window),
          }
        : {}),
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
