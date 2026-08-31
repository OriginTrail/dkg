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
  | 'kaRootMutations'
  | 'allowListUpdates'
  | 'profileEvents';

interface ChainEventPollerLaneState {
  lastBlock: number;
  headKnown: boolean;
  requiresFullHistory?: boolean;
  nextRunAtMs?: number;
  failureBackoffMs?: number;
  /** Ticks on which this lane was due — drives `periodicRescan`. */
  pollCount?: number;
  /** Chain head observed on the most recent due tick (diagnostics). */
  lastScanHead?: number;
  /** `clock()` at the most recent due tick (diagnostics). */
  lastScanAtMs?: number;
}

const DEFAULT_LIVE_SEED_LOOKBACK_BLOCKS = 500;
const FAILURE_BACKOFF_INITIAL_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

/** How a due tick for one lane ended. Metric label value; keep stable. */
export type ChainEventLanePollResult = 'success' | 'failure' | 'noWork';

/**
 * Lane-health recorder.
 *
 * Injected rather than reached for, so the runner records without depending on
 * a telemetry module — and so a test can assert the exact `(lane, result)`
 * pairs a production code path emits instead of inferring them from a
 * scrape. Attribute keys are fixed at `lane` and `result` BY CONSTRUCTION here:
 * neither a context-graph id, a KA id nor a transaction hash can reach a metric
 * through this interface, because there is nowhere to put one.
 */
export interface ChainEventLaneMetrics {
  laneScan(lane: ChainEventPollerLane, result: ChainEventLanePollResult): void;
  laneCursorLag(lane: ChainEventPollerLane, lagBlocks: number): void;
}

/** Per-lane liveness, surfaced for the daemon's diagnostics route. */
export interface ChainEventLaneHealth {
  lane: ChainEventPollerLane;
  lastBlock: number;
  lastScanHead?: number;
  lastScanAtMs?: number;
}

export interface ChainEventPollerLaneSpec {
  name: ChainEventPollerLane;
  enabled(): boolean;
  eventTypes(): readonly string[];
  requiresFullHistory(): boolean;
  canUseLegacyAggregateCursor?(): boolean;
  liveSeedLookbackBlocks?: number;
  cadenceMs: number;
  /**
   * Blocks to step BACK from a cursor that was restored from persistence, and
   * from the cursor a failed scan left in place.
   *
   * Deliberately NOT applied per tick: a lane that rewound on every tick would
   * never reach `fromBlock > upperBound`, so it would never take the `noWork`
   * path and an idle node would pay an `eth_getLogs` every cadence forever.
   * Restore and failure are the two moments where the cursor's provenance is
   * actually in doubt — a restart across a reorg, or a scan whose log read may
   * have been served by an endpoint behind the head that advanced it.
   */
  rewindOnRestoreBlocks?: number;
  /**
   * Re-scan a wide trailing window every `everyPolls` due ticks of this lane,
   * WITHOUT moving the cursor.
   *
   * This is the bound on the residual loss tail: a forward scan whose log read
   * lands on an endpoint lagging behind the head that advances the cursor
   * returns fewer logs, and the runner still persists `lastBlock = head`. The
   * events in `(backendTip, head]` are then past the cursor and no forward scan
   * will ever look at them again. A periodic wide re-scan is what makes that
   * loss recoverable rather than permanent.
   */
  periodicRescan?: { everyPolls: number; windowBlocks: number };
  dispatch(event: ChainEvent, ctx: OperationContext): Promise<void>;
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
  metrics?: ChainEventLaneMetrics;
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
  private readonly metrics?: ChainEventLaneMetrics;
  private readonly laneState = new Map<ChainEventPollerLane, ChainEventPollerLaneState>();
  private readonly restoredLanes = new Set<ChainEventPollerLane>();

  constructor(config: ChainEventLaneRunnerConfig) {
    this.chain = config.chain;
    this.lanes = config.lanes;
    this.maxRange = config.maxRange;
    this.clock = config.clock;
    this.log = config.log;
    this.cursorStore = createLaneCursorStore(config.cursorPersistence);
    this.metrics = config.metrics;
  }

  async restoreCurrentlyActive(ctx: OperationContext): Promise<void> {
    await this.restoreLaneCursors(this.activeLaneSpecs(), ctx);
  }

  /**
   * Make every currently-active lane due on the next `poll()`.
   *
   * A caught-up lane re-arms `nextRunAtMs` to `now + cadenceMs`, so a `poll()`
   * issued inside that window scans NOTHING and returns having done no work —
   * which a caller driving the poller by hand reads as "the event was not
   * there". Clearing the schedule is what makes a manual drive deterministic.
   */
  clearActiveLaneSchedules(): void {
    for (const lane of this.activeLaneSpecs()) {
      lane.state.nextRunAtMs = undefined;
    }
  }

  /** Per-lane liveness for the currently-active lanes. */
  laneHealth(): ChainEventLaneHealth[] {
    return this.activeLaneSpecs().map((lane) => ({
      lane: lane.spec.name,
      lastBlock: lane.state.lastBlock,
      lastScanHead: lane.state.lastScanHead,
      lastScanAtMs: lane.state.lastScanAtMs,
    }));
  }

  async poll(): Promise<void> {
    const ctx = createOperationContext('publish');
    const activeLanes = this.activeLaneSpecs();
    if (activeLanes.length === 0) return;

    await this.restoreLaneCursors(activeLanes, ctx);

    const now = this.clock();
    const dueLanes = activeLanes.filter((lane) => this.laneDue(lane, now));
    if (dueLanes.length === 0) return;

    let head: number | undefined;
    if (this.chain.getBlockNumber) {
      try { head = await this.chain.getBlockNumber(); } catch { /* unavailable */ }
    }

    const scanResults: ChainEventPollerLaneScanResult[] = [];
    for (const lane of dueLanes) {
      scanResults.push(await this.scanLane(lane, head, now, ctx));
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
        const rewound = this.rewindBlocks(lane, saved);
        lane.state.lastBlock = rewound;
        this.log.info(
          ctx,
          rewound === saved
            ? `Restored poller cursor from persistence: lane=${lane.spec.name} block ${saved}`
            : `Restored poller cursor from persistence: lane=${lane.spec.name} block ${saved} rewound to ${rewound}`,
        );
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

  /**
   * `block` stepped back by the lane's `rewindOnRestoreBlocks`, floored at 0.
   * Lanes without the field are returned unchanged — the field is opt-in and
   * every shipped lane except `kaRootMutations` omits it.
   */
  private rewindBlocks(lane: ChainEventPollerLaneRuntime, block: number): number {
    const rewind = lane.spec.rewindOnRestoreBlocks;
    if (rewind == null || !Number.isFinite(rewind) || rewind <= 0) return block;
    return Math.max(0, block - Math.floor(rewind));
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

    if (head != null) {
      state.lastScanHead = head;
      this.metrics?.laneCursorLag(lane.spec.name, Math.max(0, head - state.lastBlock));
    }
    state.lastScanAtMs = now;

    // Taken BEFORE the forward-work test: the wide re-scan exists precisely for
    // the steady state where the lane is caught up and the forward scan finds
    // nothing, so gating it on forward work would disable it exactly when it is
    // the only thing looking at the blocks a lagging endpoint may have hidden.
    const rescan = this.takeDueRescanWindow(lane);

    const fromBlock = state.lastBlock + 1;
    const upperBound = head != null
      ? Math.min(fromBlock + this.maxRange - 1, head)
      : fromBlock + this.maxRange - 1;

    // The re-scan is best-effort redundancy over blocks the cursor already
    // passed, and its failure handling is deliberately DIFFERENT from a
    // forward scan's (PR #2436 review r2): routing it through
    // `onLaneScanFailed` would rewind the FORWARD cursor because a REPLAY
    // failed — the one cursor movement the replay was documented never to
    // cause — and gating the forward scan on it would let a provider that
    // rejects wide history ranges starve fresh events every rescan tick.
    // A failed re-scan is logged and simply waits for its next scheduled
    // tick; the forward scan below proceeds regardless.
    if (rescan) {
      try {
        await this.dispatchWindow(lane, rescan.fromBlock, rescan.toBlock, ctx);
      } catch (err) {
        this.log.warn(
          ctx,
          `Periodic re-scan failed (forward scan unaffected): lane=${lane.spec.name} ` +
          `[${rescan.fromBlock}, ${rescan.toBlock}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (fromBlock > upperBound) {
      this.applyLaneSchedule(lane, { kind: 'noWork', now });
      return { lane, blockNumber: state.lastBlock, advanced: false };
    }

    const caughtUp = head != null && upperBound >= head;
    let advanced = false;

    try {
      await this.dispatchWindow(lane, fromBlock, upperBound, ctx);

      state.lastBlock = upperBound;
      advanced = true;
      this.applyLaneSchedule(lane, { kind: 'success', now, caughtUp });
    } catch (err) {
      this.onLaneScanFailed(lane, now, err, ctx);
    }
    return { lane, blockNumber: state.lastBlock, advanced };
  }

  private async dispatchWindow(
    lane: ChainEventPollerLaneRuntime,
    fromBlock: number,
    toBlock: number,
    ctx: OperationContext,
  ): Promise<void> {
    const filter: EventFilter = { eventTypes: lane.eventTypes, fromBlock, toBlock };
    for await (const event of this.chain.listenForEvents(filter)) {
      await lane.spec.dispatch(event, ctx);
    }
  }

  private onLaneScanFailed(
    lane: ChainEventPollerLaneRuntime,
    now: number,
    err: unknown,
    ctx: OperationContext,
  ): void {
    this.log.error(ctx, `Poll lane ${lane.spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    // Rewind on the FIRST failure of a streak only. A lane that rewound on
    // every failure would walk its cursor backwards without bound while a
    // dependency stayed down, and would then re-dispatch that whole stretch on
    // recovery. `failureBackoffMs` is undefined exactly while the lane was last
    // healthy, so it is the streak marker — and it is read before
    // `applyLaneSchedule` sets it.
    const firstFailureOfStreak = lane.state.failureBackoffMs == null;
    this.applyLaneSchedule(lane, { kind: 'failure', now });
    if (!firstFailureOfStreak) return;
    const rewound = this.rewindBlocks(lane, lane.state.lastBlock);
    if (rewound === lane.state.lastBlock) return;
    lane.state.lastBlock = rewound;
    this.log.info(ctx, `Rewound poller cursor after lane failure: lane=${lane.spec.name} scanning from ${rewound}`);
  }

  /**
   * The trailing window to re-scan on this tick, if one is due — and count the
   * tick.
   *
   * Named `take…` because it MUTATES: the per-lane tick counter advances on
   * every due tick, idle ones included. That is deliberate — the loss this
   * bounds happens while the lane is idle and caught up, so idle ticks are
   * exactly the ones that must carry the schedule forward.
   */
  private takeDueRescanWindow(
    lane: ChainEventPollerLaneRuntime,
  ): { fromBlock: number; toBlock: number } | undefined {
    const rescan = lane.spec.periodicRescan;
    if (!rescan) return undefined;
    const everyPolls = Math.floor(rescan.everyPolls);
    const windowBlocks = Math.floor(rescan.windowBlocks);

    const count = (lane.state.pollCount ?? 0) + 1;
    lane.state.pollCount = count;

    if (!Number.isFinite(everyPolls) || everyPolls <= 0) return undefined;
    if (!Number.isFinite(windowBlocks) || windowBlocks <= 0) return undefined;
    if (count % everyPolls !== 0) return undefined;

    const toBlock = lane.state.lastBlock;
    // Nothing has been scanned yet — there is no history to look back over,
    // and `[1, 0]` would be an inverted window.
    if (toBlock < 1) return undefined;
    // Inclusive window of EXACTLY `windowBlocks` blocks (review r3): the naive
    // `toBlock - windowBlocks` spans windowBlocks + 1 blocks inclusive, which a
    // provider enforcing a strict range cap would reject — turning the re-scan
    // into a permanent no-op on exactly the providers it exists to survive.
    return { fromBlock: Math.max(1, toBlock - windowBlocks + 1), toBlock };
  }

  private applyLaneSchedule(lane: ChainEventPollerLaneRuntime, outcome: ChainEventLaneScheduleOutcome): void {
    const state = lane.state;
    if (outcome.kind === 'noWork') {
      this.metrics?.laneScan(lane.spec.name, 'noWork');
      state.nextRunAtMs = outcome.now + lane.spec.cadenceMs;
      return;
    }
    if (outcome.kind === 'success') {
      this.metrics?.laneScan(lane.spec.name, 'success');
      state.failureBackoffMs = undefined;
      state.nextRunAtMs = outcome.caughtUp ? outcome.now + lane.spec.cadenceMs : undefined;
      return;
    }

    this.metrics?.laneScan(lane.spec.name, 'failure');
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
