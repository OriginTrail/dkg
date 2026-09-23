import type {
  ChainAdapter,
  ChainEvent,
  EventFilter,
  EventScanHorizonLease,
} from '@origintrail-official/dkg-chain';
import { createOperationContext, type Logger, type OperationContext } from '@origintrail-official/dkg-core';
import {
  createLaneCursorStore,
  type CursorPersistence,
  type LaneCursorStore,
} from './chain-event-lane-cursor-store.js';

export type ChainEventPollerLane =
  | 'publish'
  | 'allocatorReconcile'
  | 'contextGraphDiscovery'
  | 'vmReconcile'
  | 'collectionUpdates'
  | 'allowListUpdates'
  | 'profileEvents';

interface ChainEventPollerLaneState {
  lastBlock: number;
  headKnown: boolean;
  cursorStrategyKind?: ChainEventPollerLaneCursorStrategy['kind'];
  nextRunAtMs?: number;
  failureBackoffMs?: number;
}

/**
 * Describes the cursor lifecycle for a lane as one explicit strategy.
 *
 * `legacyAggregateCursor` is required on both variants, and deliberately so.
 * It is not derivable from `kind`: the restored-publish lane is `full-history`
 * yet must keep reading the shared legacy cursor, while the live publish lane
 * is `live-tail` yet must stay out of it. It is also not safely omissible - an
 * omitted marker reads as opt-out in `loadPersistedLaneCursor`, and via the
 * `every(...)` in `legacyAggregateCursorToSave` a single opted-out lane zeroes
 * the aggregate save for every other active lane. Stating it per lane is what
 * makes that combination impossible to reach by accident.
 */
export type ChainEventPollerLaneCursorStrategy =
  | {
    kind: 'full-history';
    legacyAggregateCursor: boolean;
    onBackfillFromGenesis?(ctx: OperationContext): void;
  }
  | {
    kind: 'live-tail';
    legacyAggregateCursor: boolean;
    liveSeedLookbackBlocks?: number;
  };

const DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS = 500;
const FAILURE_BACKOFF_INITIAL_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export interface ChainEventPollerLaneSpec {
  name: ChainEventPollerLane;
  enabled(): boolean;
  eventTypes(): readonly string[];
  cursorStrategy(): ChainEventPollerLaneCursorStrategy;
  cadenceMs: number;
  dispatch(event: ChainEvent, ctx: OperationContext, signal?: AbortSignal): Promise<void>;
}

interface ChainEventPollerLaneRuntime {
  spec: ChainEventPollerLaneSpec;
  state: ChainEventPollerLaneState;
  eventTypes: string[];
  cursorStrategy: ChainEventPollerLaneCursorStrategy;
}

interface ChainEventPollerLaneScanResult {
  lane: ChainEventPollerLaneRuntime;
  blockNumber: number;
  advanced: boolean;
  lease?: EventScanHorizonLease;
  stateBefore?: ChainEventPollerLaneState;
}

interface ChainEventLaneBoundary {
  readonly head: number | undefined;
  readonly lease?: EventScanHorizonLease;
}

type ChainEventLaneScheduleOutcome =
  | { kind: 'noWork'; now: number }
  | { kind: 'success'; now: number; caughtUp: boolean }
  | { kind: 'failure'; now: number };

export interface ChainEventLaneRunnerConfig {
  chain: ChainAdapter;
  lanes: readonly ChainEventPollerLaneSpec[];
  maxRange: number;
  clock: () => number;
  log: Logger;
  cursorPersistence?: CursorPersistence;
}

/**
 * Owns the lane scheduler, cursor migration/restoration, head seeding, and
 * block-window scanning for `ChainEventPoller`.
 */
export class ChainEventLaneRunner {
  private readonly chain: ChainAdapter;
  private readonly lanes: readonly ChainEventPollerLaneSpec[];
  private readonly maxRange: number;
  private readonly clock: () => number;
  private readonly log: Logger;
  private readonly cursorStore?: LaneCursorStore;
  private readonly laneState = new Map<ChainEventPollerLane, ChainEventPollerLaneState>();
  private readonly restoredLanes = new Set<ChainEventPollerLane>();

  constructor(config: ChainEventLaneRunnerConfig) {
    this.chain = config.chain;
    this.lanes = config.lanes;
    this.maxRange = config.maxRange;
    this.clock = config.clock;
    this.log = config.log;
    this.cursorStore = createLaneCursorStore(config.cursorPersistence);
  }

  async restoreCurrentlyActive(ctx: OperationContext): Promise<void> {
    await this.restoreLaneCursors(this.activeLaneSpecs(), ctx);
  }

  async poll(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const ctx = createOperationContext('publish');
    const activeLanes = this.activeLaneSpecs();
    if (activeLanes.length === 0) return;

    await this.restoreLaneCursors(activeLanes, ctx);
    signal?.throwIfAborted();

    const now = this.clock();
    const dueLanes = activeLanes.filter((lane) => this.laneDue(lane, now));
    if (dueLanes.length === 0) return;

    let liveHeadRead: Promise<number | undefined> | undefined;
    const readLiveHead = (): Promise<number | undefined> => {
      liveHeadRead ??= this.readLiveHead(signal);
      return liveHeadRead;
    };

    const scanResults: ChainEventPollerLaneScanResult[] = [];
    for (const lane of dueLanes) {
      signal?.throwIfAborted();
      const boundary = await this.eventScanBoundary(lane, readLiveHead, signal);
      scanResults.push(await this.scanLane(lane, boundary, now, ctx, signal));
    }
    signal?.throwIfAborted();
    const currentResults = await this.revalidateScanResults(scanResults, now, ctx, signal);
    await this.persistScanResults(currentResults, activeLanes, now, ctx, signal);
  }

  private async readLiveHead(signal?: AbortSignal): Promise<number | undefined> {
    if (!this.chain.getBlockNumber) return undefined;
    try {
      return await this.chain.getBlockNumber();
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      // Head is optional; lanes can still scan their next bounded range.
      return undefined;
    }
  }

  private async eventScanBoundary(
    lane: ChainEventPollerLaneRuntime,
    readLiveHead: () => Promise<number | undefined>,
    signal?: AbortSignal,
  ): Promise<ChainEventLaneBoundary> {
    const acquire = this.chain.acquireEventScanHorizonLease;
    if (acquire !== undefined) {
      try {
        const lease = await acquire.call(this.chain, lane.eventTypes);
        if (
          lease !== undefined
          && Number.isSafeInteger(lease.throughBlockNumber)
          && lease.throughBlockNumber >= 0
        ) return { head: lease.throughBlockNumber, lease };
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        // Refusal or uncertainty restores this lane's live-head path.
      }
    }
    return { head: await readLiveHead() };
  }

  private activeLaneSpecs(): ChainEventPollerLaneRuntime[] {
    return this.lanes.flatMap((spec) => {
      if (!spec.enabled()) return [];
      const eventTypes = [...spec.eventTypes()];
      if (eventTypes.length === 0) return [];
      const cursorStrategy = spec.cursorStrategy();
      return [{
        spec,
        state: this.stateFor(spec.name),
        eventTypes,
        cursorStrategy,
      }];
    });
  }

  private liveSeedLookbackBlocks(strategy: ChainEventPollerLaneCursorStrategy): number {
    const lookback = strategy.kind === 'live-tail'
      ? strategy.liveSeedLookbackBlocks ?? DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS
      : DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS;
    return Number.isFinite(lookback) && lookback >= 0
      ? Math.floor(lookback)
      : DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS;
  }

  private stateFor(lane: ChainEventPollerLane): ChainEventPollerLaneState {
    let state = this.laneState.get(lane);
    if (!state) {
      state = { lastBlock: 0, headKnown: false };
      this.laneState.set(lane, state);
    }
    return state;
  }

  private async restoreLaneCursors(
    activeLanes: readonly ChainEventPollerLaneRuntime[],
    ctx: OperationContext,
  ): Promise<void> {
    if (!this.cursorStore) return;
    for (const lane of activeLanes) {
      if (this.restoredLanes.has(lane.spec.name)) continue;
      await this.restoreLaneCursor(lane, ctx);
    }
  }

  private async restoreLaneCursor(lane: ChainEventPollerLaneRuntime, ctx: OperationContext): Promise<void> {
    if (!this.cursorStore) return;
    try {
      const saved = await this.loadPersistedLaneCursor(lane);
      if (saved != null && saved > 0) {
        lane.state.lastBlock = saved;
        this.log.info(ctx, `Restored poller cursor from persistence: lane=${lane.spec.name} block ${saved}`);
      }
    } catch (err) {
      this.log.warn(ctx, `Failed to load persisted cursor: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.restoredLanes.add(lane.spec.name);
    }
  }

  private async loadPersistedLaneCursor(lane: ChainEventPollerLaneRuntime): Promise<number | undefined> {
    if (!this.cursorStore) return undefined;
    if (this.cursorStore.kind === 'lane') return this.cursorStore.loadLane(lane.spec.name);
    if (lane.cursorStrategy.legacyAggregateCursor) return this.cursorStore.loadLegacyAggregate();
    return undefined;
  }

  private laneDue(lane: ChainEventPollerLaneRuntime, now: number): boolean {
    const nextRunAtMs = lane.state.nextRunAtMs;
    return nextRunAtMs == null || now >= nextRunAtMs;
  }

  private async persistScanResults(
    scanResults: readonly ChainEventPollerLaneScanResult[],
    activeLanes: readonly ChainEventPollerLaneRuntime[],
    now: number,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.cursorStore) return;
    const advancedResults = scanResults.filter((result) => result.advanced && result.blockNumber > 0);
    if (advancedResults.length === 0) return;

    if (this.cursorStore.kind === 'lane') {
      for (const result of advancedResults) {
        signal?.throwIfAborted();
        if (!await this.scanResultLeaseHoldsForPersistence(result, now, ctx, signal)) continue;
        try {
          await this.cursorStore.saveLane(result.lane.spec.name, result.blockNumber);
        } catch {
          // Non-fatal - this lane will be re-scanned on restart.
        }
      }
      return;
    }

    const leasedResults = advancedResults.filter((
      result,
    ): result is ChainEventPollerLaneScanResult & {
      lease: EventScanHorizonLease;
      stateBefore: ChainEventPollerLaneState;
    } => result.lease !== undefined && result.stateBefore !== undefined);
    if (leasedResults.length > 1) {
      // A legacy cursor persists all lanes in one scalar. Independent leases
      // cannot be proven atomically: while the second awaits, the first can
      // retire. Refuse the aggregate and replay every leased lane instead of
      // composing separately-current observations into one stale commit.
      for (const result of leasedResults) {
        this.retireScanResult(
          result,
          result.stateBefore,
          now,
          ctx,
          'legacy aggregate cursor persistence',
        );
      }
      return;
    }
    if (
      leasedResults[0] !== undefined
      && !await this.scanResultLeaseHoldsForPersistence(
        leasedResults[0],
        now,
        ctx,
        signal,
      )
    ) return;

    const legacySafeCursor = this.legacyAggregateCursorToSave(activeLanes);
    if (legacySafeCursor > 0) {
      try {
        await this.cursorStore.saveLegacyAggregate(legacySafeCursor);
      } catch {
        // Non-fatal - legacy aggregate callers will re-scan on restart.
      }
    }
  }

  private legacyAggregateCursorToSave(activeLanes: readonly ChainEventPollerLaneRuntime[]): number {
    if (activeLanes.length === 0) return 0;
    if (!activeLanes.every((lane) => lane.cursorStrategy.legacyAggregateCursor)) return 0;

    let min = Number.POSITIVE_INFINITY;
    for (const lane of activeLanes) {
      if (lane.state.lastBlock <= 0) return 0;
      min = Math.min(min, lane.state.lastBlock);
    }
    return Number.isFinite(min) ? min : 0;
  }

  private async scanLane(
    lane: ChainEventPollerLaneRuntime,
    boundary: ChainEventLaneBoundary,
    now: number,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<ChainEventPollerLaneScanResult> {
    const state = lane.state;
    const stateBefore = { ...state };
    const { head, lease } = boundary;

    this.applyCursorStrategyTransition(lane, head, ctx);

    if (head != null && !state.headKnown) {
      state.headKnown = true;
      if (state.lastBlock === 0 && lane.cursorStrategy.kind === 'live-tail') {
        state.lastBlock = Math.max(0, head - this.liveSeedLookbackBlocks(lane.cursorStrategy));
        this.log.info(ctx, `Seeded poller cursor near chain head: lane=${lane.spec.name} head=${head} scanning from ${state.lastBlock}`);
      } else if (state.lastBlock === 0 && lane.cursorStrategy.kind === 'full-history') {
        lane.cursorStrategy.onBackfillFromGenesis?.(ctx);
      }
    }

    const fromBlock = state.lastBlock + 1;
    const upperBound = head != null
      ? Math.min(fromBlock + this.maxRange - 1, head)
      : fromBlock + this.maxRange - 1;

    if (fromBlock > upperBound) {
      this.applyLaneSchedule(lane, { kind: 'noWork', now });
      return { lane, blockNumber: state.lastBlock, advanced: false };
    }

    const filter: EventFilter = {
      eventTypes: lane.eventTypes,
      fromBlock,
      toBlock: upperBound,
    };
    const caughtUp = head != null && upperBound >= head;
    let advanced = false;
    let leaseExpired = false;

    try {
      for await (const event of this.chain.listenForEvents(filter)) {
        signal?.throwIfAborted();
        if (lease !== undefined && !await this.eventScanLeaseHolds(lease)) {
          leaseExpired = true;
          throw new Error('event scan horizon lease expired before event dispatch');
        }
        signal?.throwIfAborted();
        await lane.spec.dispatch(event, ctx, signal);
        signal?.throwIfAborted();
        if (lease !== undefined && !await this.eventScanLeaseHolds(lease)) {
          leaseExpired = true;
          throw new Error('event scan horizon lease expired after event dispatch');
        }
        signal?.throwIfAborted();
      }

      signal?.throwIfAborted();
      if (lease !== undefined && !await this.eventScanLeaseHolds(lease)) {
        leaseExpired = true;
        throw new Error('event scan horizon lease expired before cursor advance');
      }
      signal?.throwIfAborted();
      state.lastBlock = upperBound;
      advanced = true;
      this.applyLaneSchedule(lane, { kind: 'success', now, caughtUp });
    } catch (err) {
      if (signal?.aborted) signal.throwIfAborted();
      if (leaseExpired) this.restoreLaneState(state, stateBefore);
      this.log.error(ctx, `Poll lane ${lane.spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.applyLaneSchedule(lane, { kind: 'failure', now });
    }
    return {
      lane,
      blockNumber: state.lastBlock,
      advanced,
      ...(advanced && lease !== undefined ? { lease, stateBefore } : {}),
    };
  }

  private async revalidateScanResults(
    scanResults: readonly ChainEventPollerLaneScanResult[],
    now: number,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<readonly ChainEventPollerLaneScanResult[]> {
    const current: ChainEventPollerLaneScanResult[] = [];
    for (const result of scanResults) {
      if (!result.advanced || result.lease === undefined || result.stateBefore === undefined) {
        current.push(result);
        continue;
      }
      signal?.throwIfAborted();
      if (await this.eventScanLeaseHolds(result.lease)) {
        signal?.throwIfAborted();
        current.push(result);
        continue;
      }

      current.push(this.retireScanResult(
        result,
        result.stateBefore,
        now,
        ctx,
        'cursor persistence',
      ));
    }
    return current;
  }

  private async scanResultLeaseHoldsForPersistence(
    result: ChainEventPollerLaneScanResult,
    now: number,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (result.lease === undefined || result.stateBefore === undefined) return true;
    signal?.throwIfAborted();
    if (await this.eventScanLeaseHolds(result.lease)) {
      signal?.throwIfAborted();
      return true;
    }
    this.retireScanResult(result, result.stateBefore, now, ctx, 'cursor save');
    return false;
  }

  private retireScanResult(
    result: ChainEventPollerLaneScanResult,
    stateBefore: ChainEventPollerLaneState,
    now: number,
    ctx: OperationContext,
    phase: string,
  ): ChainEventPollerLaneScanResult {
    this.restoreLaneState(result.lane.state, stateBefore);
    this.applyLaneSchedule(result.lane, { kind: 'failure', now });
    this.log.warn(
      ctx,
      `Poll lane ${result.lane.spec.name} lease expired before ${phase}; range will replay`,
    );
    return {
      lane: result.lane,
      blockNumber: result.lane.state.lastBlock,
      advanced: false,
    };
  }

  private async eventScanLeaseHolds(lease: EventScanHorizonLease): Promise<boolean> {
    try {
      return await lease.holds();
    } catch {
      return false;
    }
  }

  private restoreLaneState(
    state: ChainEventPollerLaneState,
    previous: ChainEventPollerLaneState,
  ): void {
    state.lastBlock = previous.lastBlock;
    state.headKnown = previous.headKnown;
    state.cursorStrategyKind = previous.cursorStrategyKind;
    state.nextRunAtMs = previous.nextRunAtMs;
    state.failureBackoffMs = previous.failureBackoffMs;
  }

  private applyLaneSchedule(lane: ChainEventPollerLaneRuntime, outcome: ChainEventLaneScheduleOutcome): void {
    const state = lane.state;
    if (outcome.kind === 'noWork') {
      state.nextRunAtMs = outcome.now + lane.spec.cadenceMs;
      return;
    }
    if (outcome.kind === 'success') {
      state.failureBackoffMs = undefined;
      state.nextRunAtMs = outcome.caughtUp ? outcome.now + lane.spec.cadenceMs : undefined;
      return;
    }

    const previous = state.failureBackoffMs;
    const next = previous == null
      ? Math.max(FAILURE_BACKOFF_INITIAL_MS, lane.spec.cadenceMs)
      : Math.min(previous * 2, FAILURE_BACKOFF_MAX_MS);
    state.failureBackoffMs = next;
    state.nextRunAtMs = outcome.now + next;
  }

  private applyCursorStrategyTransition(
    lane: ChainEventPollerLaneRuntime,
    head: number | undefined,
    ctx: OperationContext,
  ): void {
    const state = lane.state;
    const previousStrategyKind = state.cursorStrategyKind;
    state.cursorStrategyKind = lane.cursorStrategy.kind;

    if (previousStrategyKind !== 'full-history' || lane.cursorStrategy.kind === 'full-history' || head == null) return;

    const liveSeedBlock = Math.max(0, head - this.liveSeedLookbackBlocks(lane.cursorStrategy));
    if (state.lastBlock >= liveSeedBlock) return;

    state.lastBlock = liveSeedBlock;
    this.log.info(
      ctx,
      `Re-seeded poller cursor after full-history lane cleared: lane=${lane.spec.name} head=${head} scanning from ${state.lastBlock}`,
    );
  }
}
