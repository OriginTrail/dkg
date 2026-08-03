import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
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
  requiresFullHistory?: boolean;
  nextRunAtMs?: number;
  failureBackoffMs?: number;
}

const DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS = 500;
const FAILURE_BACKOFF_INITIAL_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export interface ChainEventPollerLaneSpec {
  name: ChainEventPollerLane;
  enabled(): boolean;
  eventTypes(): readonly string[];
  requiresFullHistory(): boolean;
  canUseLegacyAggregateCursor?(): boolean;
  liveSeedLookbackBlocks?: number;
  cadenceMs: number;
  dispatch(event: ChainEvent, ctx: OperationContext, signal?: AbortSignal): Promise<void>;
  onBackfillFromGenesis?(ctx: OperationContext): void;
}

interface ChainEventPollerLaneRuntime {
  spec: ChainEventPollerLaneSpec;
  state: ChainEventPollerLaneState;
  eventTypes: string[];
  requiresFullHistory: boolean;
  canUseLegacyAggregateCursor: boolean;
  liveSeedLookbackBlocks: number;
}

interface ChainEventPollerLaneScanResult {
  lane: ChainEventPollerLaneRuntime;
  blockNumber: number;
  advanced: boolean;
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
    if (signal?.aborted) return;
    const ctx = createOperationContext('publish');
    const activeLanes = this.activeLaneSpecs();
    if (activeLanes.length === 0) return;

    await this.restoreLaneCursors(activeLanes, ctx);
    if (signal?.aborted) return;

    const now = this.clock();
    const dueLanes = activeLanes.filter((lane) => this.laneDue(lane, now));
    if (dueLanes.length === 0) return;

    let head: number | undefined;
    if (this.chain.getBlockNumber) {
      try { head = await this.chain.getBlockNumber(); } catch { /* unavailable */ }
    }
    if (signal?.aborted) return;

    const scanResults: ChainEventPollerLaneScanResult[] = [];
    for (const lane of dueLanes) {
      if (signal?.aborted) break;
      scanResults.push(await this.scanLane(lane, head, now, ctx, signal));
    }
    await this.persistScanResults(scanResults, activeLanes);
  }

  private activeLaneSpecs(): ChainEventPollerLaneRuntime[] {
    return this.lanes.flatMap((spec) => {
      if (!spec.enabled()) return [];
      const eventTypes = [...spec.eventTypes()];
      if (eventTypes.length === 0) return [];
      const requiresFullHistory = spec.requiresFullHistory();
      return [{
        spec,
        state: this.stateFor(spec.name),
        eventTypes,
        requiresFullHistory,
        canUseLegacyAggregateCursor: spec.canUseLegacyAggregateCursor?.() ?? !requiresFullHistory,
        liveSeedLookbackBlocks: this.liveSeedLookbackBlocks(spec),
      }];
    });
  }

  private liveSeedLookbackBlocks(spec: ChainEventPollerLaneSpec): number {
    const lookback = spec.liveSeedLookbackBlocks ?? DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS;
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
    if (lane.canUseLegacyAggregateCursor) return this.cursorStore.loadLegacyAggregate();
    return undefined;
  }

  private laneDue(lane: ChainEventPollerLaneRuntime, now: number): boolean {
    const nextRunAtMs = lane.state.nextRunAtMs;
    return nextRunAtMs == null || now >= nextRunAtMs;
  }

  private async persistScanResults(
    scanResults: readonly ChainEventPollerLaneScanResult[],
    activeLanes: readonly ChainEventPollerLaneRuntime[],
  ): Promise<void> {
    if (!this.cursorStore) return;
    const advancedResults = scanResults.filter((result) => result.advanced && result.blockNumber > 0);
    if (advancedResults.length === 0) return;

    if (this.cursorStore.kind === 'lane') {
      for (const result of advancedResults) {
        try {
          await this.cursorStore.saveLane(result.lane.spec.name, result.blockNumber);
        } catch {
          // Non-fatal - this lane will be re-scanned on restart.
        }
      }
      return;
    }

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
    if (!activeLanes.every((lane) => lane.canUseLegacyAggregateCursor)) return 0;

    let min = Number.POSITIVE_INFINITY;
    for (const lane of activeLanes) {
      if (lane.state.lastBlock <= 0) return 0;
      min = Math.min(min, lane.state.lastBlock);
    }
    return Number.isFinite(min) ? min : 0;
  }

  private async scanLane(
    lane: ChainEventPollerLaneRuntime,
    head: number | undefined,
    now: number,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<ChainEventPollerLaneScanResult> {
    const state = lane.state;

    this.applyHistoryModeTransition(lane, head, ctx);

    if (head != null && !state.headKnown) {
      state.headKnown = true;
      if (state.lastBlock === 0 && !lane.requiresFullHistory) {
        state.lastBlock = Math.max(0, head - lane.liveSeedLookbackBlocks);
        this.log.info(ctx, `Seeded poller cursor near chain head: lane=${lane.spec.name} head=${head} scanning from ${state.lastBlock}`);
      } else if (state.lastBlock === 0 && lane.spec.onBackfillFromGenesis) {
        lane.spec.onBackfillFromGenesis(ctx);
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

    try {
      for await (const event of this.chain.listenForEvents(filter, { signal })) {
        // A stopped partial lane must be replayed from its prior durable
        // cursor. Event callbacks are idempotent, so replay is safer than
        // advancing past events that were never dispatched.
        if (signal?.aborted) {
          return { lane, blockNumber: state.lastBlock, advanced: false };
        }
        await lane.spec.dispatch(event, ctx, signal);
      }

      if (signal?.aborted) {
        return { lane, blockNumber: state.lastBlock, advanced: false };
      }

      state.lastBlock = upperBound;
      advanced = true;
      this.applyLaneSchedule(lane, { kind: 'success', now, caughtUp });
    } catch (err) {
      if (signal?.aborted) {
        return { lane, blockNumber: state.lastBlock, advanced: false };
      }
      this.log.error(ctx, `Poll lane ${lane.spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.applyLaneSchedule(lane, { kind: 'failure', now });
    }
    return { lane, blockNumber: state.lastBlock, advanced };
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

  private applyHistoryModeTransition(
    lane: ChainEventPollerLaneRuntime,
    head: number | undefined,
    ctx: OperationContext,
  ): void {
    const state = lane.state;
    const previousRequiresFullHistory = state.requiresFullHistory;
    state.requiresFullHistory = lane.requiresFullHistory;

    if (previousRequiresFullHistory !== true || lane.requiresFullHistory || head == null) return;

    const liveSeedBlock = Math.max(0, head - lane.liveSeedLookbackBlocks);
    if (state.lastBlock >= liveSeedBlock) return;

    state.lastBlock = liveSeedBlock;
    this.log.info(
      ctx,
      `Re-seeded poller cursor after full-history lane cleared: lane=${lane.spec.name} head=${head} scanning from ${state.lastBlock}`,
    );
  }
}
