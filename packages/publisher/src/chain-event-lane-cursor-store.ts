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
 * Retired persistence keys a lane may ADOPT a durable cursor from (review
 * r26): a CLOSED union, so the scheduler union stays reserved for lanes the
 * scheduler can actually run, and a typo'd historical key fails to COMPILE
 * instead of silently reading nothing and falling back to the live seed.
 */
export type ChainEventRetiredCursorKey = 'collectionUpdates';

/**
 * Every key the persistence layer can be asked to READ. Writes stay
 * `ChainEventPollerLane`: a retired key is never written under its own name
 * — the first forward scan re-homes an adopted cursor under the live key.
 */
export type ChainEventCursorKey = ChainEventPollerLane | ChainEventRetiredCursorKey;

/**
 * Lane-aware cursor persistence for saving/loading independent lane cursors.
 *
 * `replayRetry` is OPTIONAL (reviews r20/r21): without it, the retained
 * replay window (r19) is process-lifetime only — the forward cursor is
 * durable, so a store that wants restart-safe replay recovery supplies the
 * nested capability, atomically.
 */
export interface LaneCursorPersistence {
  loadLane(lane: ChainEventCursorKey): Promise<number | undefined>;
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
      loadLane(lane: ChainEventCursorKey): Promise<number | undefined>;
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
      // One fulfilled aggregate read is shared by every lane; a REJECTED
      // read is evicted so the next poll retries it (review r16-bot) — a
      // memoized rejection would hold every unrestored lane forever behind
      // one transient SQLITE_BUSY.
      if (!loaded) {
        loaded = legacyStore.load().catch((err: unknown) => {
          loaded = undefined;
          throw err;
        });
      }
      return loaded;
    },
    saveLegacyAggregate: (blockNumber) => legacyStore.save(blockNumber),
  };
}
