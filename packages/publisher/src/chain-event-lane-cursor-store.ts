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
 * Durable persistence for a rejected replay window, as ONE capability
 * (review r21): both operations or neither — a half-implemented pair is
 * UNREPRESENTABLE rather than policed at runtime. `save(lane, undefined)`
 * clears the persisted window.
 */
export interface LaneReplayRetryPersistence {
  load(lane: ChainEventPollerLane): Promise<LaneReplayRetryWindow | undefined>;
  save(lane: ChainEventPollerLane, window: LaneReplayRetryWindow | undefined): Promise<void>;
}

/**
 * Lane-aware cursor persistence for saving/loading independent lane cursors.
 *
 * `replayRetry` is OPTIONAL (reviews r20/r21): without it, the retained
 * replay window (r19) is process-lifetime only — the forward cursor is
 * durable, so a store that wants restart-safe replay recovery supplies the
 * nested capability, atomically.
 */
export interface LaneCursorPersistence {
  loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
  saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
  replayRetry?: LaneReplayRetryPersistence;
}

// Zero-emit type proof (review r21): a half-implemented replay capability
// cannot type-check — the nested object requires BOTH operations.
type Expect<T extends true> = T;
type NotAssignable<A, B> = A extends B ? false : true;
type _halfPairIsUnrepresentable = Expect<NotAssignable<
  { load: LaneReplayRetryPersistence['load'] },
  LaneReplayRetryPersistence
>>;

export type CursorPersistence = LegacyCursorPersistence | LaneCursorPersistence;

export type LaneCursorStore =
  | {
      kind: 'lane';
      loadLane(lane: ChainEventPollerLane): Promise<number | undefined>;
      saveLane(lane: ChainEventPollerLane, blockNumber: number): Promise<void>;
      replayRetry?: LaneReplayRetryPersistence;
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
      ...(laneStore.replayRetry ? { replayRetry: laneStore.replayRetry } : {}),
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
