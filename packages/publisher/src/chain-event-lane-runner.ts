import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { createOperationContext, type Logger, type OperationContext } from '@origintrail-official/dkg-core';
import { LaneReplayCoordinator } from './chain-event-lane-replay.js';
import {
  type ChainEventRetiredCursorKey,
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
  /**
   * Where this lane's cursor CAME FROM — a discriminated origin instead of
   * the previous pair of temporal booleans (review r3-bot). ABSENT means
   * FRESH: no durable cursor completed a restore, and the first head-known
   * scan live-seeds. Recorded separately from `lastBlock` because zero is
   * also the uninitialized sentinel (review r14): a low cursor rewound to
   * the zero floor must scan from block 1, not be live-seeded past the very
   * window the restore preserved.
   *
   *  - 'current': restored under the lane's OWN key — real all-event-type
   *    coverage, never capped.
   *  - 'retired': ADOPTED from a retired key (r22/r25) — proves coverage
   *    for one event type only, so the first head-known scan caps it at the
   *    live-seed floor and re-labels it 'current'.
   */
  cursorOrigin?: 'current' | 'retired';
  headKnown: boolean;
  requiresFullHistory?: boolean;
  nextRunAtMs?: number;
  failureBackoffMs?: number;


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
  /**
   * Retired persistence keys whose durable cursor this lane ADOPTS when it
   * has none of its own (review r22): a lane rename must not orphan an
   * embedder's cursor — falling back to the bounded live seed after a long
   * outage would silently skip valid events the old cursor had reached.
   * The adopted value goes through the same restore rewind and is
   * persisted under the NEW key immediately, so the handoff happens once.
   */
  adoptCursorFromRetiredKeys?: readonly ChainEventRetiredCursorKey[];
  /**
   * Bound every scan of this lane — seed, forward, replay — at the
   * adapter's confirmation depth (review r6-bot): a lane whose callback
   * contract advertises FINALIZED positions must not dispatch a tip block
   * that a reorg can still orphan, because no later scan of the canonical
   * chain would ever retract the durably persisted callback result.
   */
  scanOnlyFinalizedHead?: boolean;
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
  replay: LaneReplayCoordinator;
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

  /** Non-throwing recorder boundary around every metrics invocation (r11). */
  private readonly recordMetric: (record: () => void) => void;
  private readonly laneState = new Map<ChainEventPollerLane, ChainEventPollerLaneState>();
  private readonly restoredLanes = new Set<ChainEventPollerLane>();
  private readonly laneReplay = new Map<ChainEventPollerLane, LaneReplayCoordinator>();

  constructor(config: ChainEventLaneRunnerConfig) {
    this.chain = config.chain;
    this.lanes = config.lanes;
    this.maxRange = config.maxRange;
    this.clock = config.clock;
    this.log = config.log;
    this.cursorStore = createLaneCursorStore(config.cursorPersistence);
    this.metrics = config.metrics;
    this.recordMetric = (record: () => void): void => {
      // Metrics are OBSERVERS, not participants (review r11): an exception
      // from an injected sink must never abort a scan, turn a completed scan
      // into a failure after lane state has advanced, or re-enter failure
      // bookkeeping that would call the same throwing hook again. A broken
      // exporter is an observability problem; the warn line below is its own
      // channel for noticing it.
      try {
        record();
      } catch (cause) {
        this.log.warn(
          createOperationContext('system'),
          `metrics sink threw; ignoring: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };
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
    // A lane whose durable cursor could not be READ does not scan (review
    // r27): scanning would seed from the live lookback and the forward-scan
    // persistence would overwrite the cursor the store still holds. Fail
    // closed until a restore attempt completes.
    const dueLanes = activeLanes.filter((lane) =>
      (!this.cursorStore || this.restoredLanes.has(lane.spec.name))
      && this.laneDue(lane, now));
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
        replay: this.replayFor(spec),
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

  /** One long-lived replay coordinator per lane, like the state itself. */
  private replayFor(spec: ChainEventPollerLaneSpec): LaneReplayCoordinator {
    let coordinator = this.laneReplay.get(spec.name);
    if (!coordinator) {
      coordinator = new LaneReplayCoordinator({
        lane: spec.name,
        periodicRescan: spec.periodicRescan,
        maxRangeBlocks: this.maxRange,
        persistence:
          this.cursorStore?.kind === 'lane' ? this.cursorStore.replayRetry : undefined,
        logInfo: (message) => this.log.info(createOperationContext('publish'), message),
        logWarn: (message) => this.log.warn(createOperationContext('publish'), message),
      });
      this.laneReplay.set(spec.name, coordinator);
    }
    return coordinator;
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
      let saved = await this.loadPersistedLaneCursor(lane);
      if ((saved == null || saved <= 0) && this.cursorStore.kind === 'lane') {
        for (const retired of lane.spec.adoptCursorFromRetiredKeys ?? []) {
          // A migration read of a RETIRED key (reviews r22/r26): the cursor-key
          // union is wider than the scheduler union — reads may name a retired
          // alias, writes never do. The adopted value is NOT re-homed here (r25):
          // it still needs the live-seed CAP, which requires the head — the
          // first successful forward scan persists the corrected cursor
          // under the new key instead, so a crash cannot freeze an uncapped
          // adoption into the new lane's own durable cursor.
          const adopted = await this.cursorStore.loadLane(retired);
          if (adopted != null && adopted > 0) {
            saved = adopted;
            lane.state.cursorOrigin = 'retired';
            this.log.info(
              ctx,
              `Adopted durable cursor from retired lane key: ${retired} -> ${lane.spec.name} block ${adopted}`,
            );
            break;
          }
        }
      }
      if (saved != null && saved > 0) {
        const rewound = this.rewindBlocks(lane, saved);
        lane.state.lastBlock = rewound;
        lane.state.cursorOrigin ??= 'current';
        this.log.info(
          ctx,
          rewound === saved
            ? `Restored poller cursor from persistence: lane=${lane.spec.name} block ${saved}`
            : `Restored poller cursor from persistence: lane=${lane.spec.name} block ${saved} rewound to ${rewound}`,
        );
      }
      // A persisted replay-retry window outlives the process (review r20):
      // the forward cursor is durable, so an in-memory-only retained window
      // would let a rejected replay discovery be lost across a restart.
      await lane.replay.restoreFromPersistence();
      // Restored means the load COMPLETED (maintainer review r27). A missing
      // row is a completed load — the lane legitimately seeds from the live
      // lookback. A THROW is a store that could not answer, and marking the
      // lane restored anyway would seal a head-derived seed over a durable
      // cursor the very next persist — blocks below the lookback skipped
      // forever. Left un-restored, the next poll retries the load, and the
      // scan loop refuses to touch the lane until one succeeds.
      this.restoredLanes.add(lane.spec.name);
    } catch (err) {
      this.log.warn(
        ctx,
        `Failed to load persisted cursor (lane held; retrying next poll): lane=${lane.spec.name} ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
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

    // The finalized-head bound applies BEFORE any use of the head (review
    // r6-bot): the live seed, the cursor-lag metric, the forward upper
    // bound and the replay windows (which trail `state.lastBlock`) all see
    // the same finalized view, so a tip event is not dispatched until its
    // block has the configured confirmation depth — the rewind remains
    // reorg protection, not a substitute for finality.
    if (lane.spec.scanOnlyFinalizedHead) {
      // FAIL CLOSED (review r12-bot): a finalized lane without a readable
      // head has no bound to honor — a forward scan would run to
      // `fromBlock + maxRange`, past any observed tip, and a replay could
      // release an unfinalized retained tail. Hold the lane: no forward
      // scan, no replay, no cursor movement; the next tick re-reads the head.
      const bound = head != null ? this.chain.finalizedEventScanBound?.(head) ?? head : undefined;
      if (head == null || bound === undefined || !Number.isFinite(bound)) {
        this.log.warn(
          ctx,
          `Finalized lane held: no readable chain head this tick (lane=${lane.spec.name})`,
        );
        this.applyLaneSchedule(lane, { kind: 'noWork', now });
        return { lane, blockNumber: state.lastBlock, advanced: false };
      }
      head = Math.max(0, Math.min(head, Math.floor(bound)));
    }

    this.applyHistoryModeTransition(lane, head, ctx);

    if (head != null && !state.headKnown) {
      state.headKnown = true;
      // An ADOPTED cursor proves coverage for the retired lane's ONE event
      // type, not for the three newly subscribed ones (review r25): cap it
      // at the live-seed floor, so the new types get at least the normal
      // activation lookback. Scanning the extra range only re-delivers
      // idempotent events; skipping it loses mutations forever. An own
      // (non-adopted) cursor is real all-type coverage and is never capped.
      if (state.cursorOrigin === 'retired' && !lane.requiresFullHistory) {
        const seedFloor = Math.max(0, head - lane.liveSeedLookbackBlocks);
        if (state.lastBlock > seedFloor) {
          this.log.info(ctx, `Capping adopted cursor at the activation lookback: lane=${lane.spec.name} ${state.lastBlock} -> ${seedFloor}`);
          state.lastBlock = seedFloor;
        }
        state.cursorOrigin = 'current';
      }
      // The live seed is BOUNDED coverage by design (review r5-bot): it
      // claims nothing about mutations older than the activation lookback.
      // Coverage for assets a node ALREADY HOLDS is the stacked consumer’s
      // obligation — the first-activation bootstrap audit (dkg-agent,
      // #2435 PR-B) enqueues a zero-position re-verify intent for every
      // held KA whenever this lane’s OWN durable cursor is absent, ordered
      // before the first cursor persist so a crash cannot skip it. The two
      // ship together: this lane triggers on what CHANGES; the audit
      // covers what already existed.
      if (state.lastBlock === 0 && state.cursorOrigin === undefined && !lane.requiresFullHistory) {
        state.lastBlock = Math.max(0, head - lane.liveSeedLookbackBlocks);
        this.log.info(ctx, `Seeded poller cursor near chain head: lane=${lane.spec.name} head=${head} scanning from ${state.lastBlock}`);
      } else if (state.lastBlock === 0 && lane.spec.onBackfillFromGenesis) {
        lane.spec.onBackfillFromGenesis(ctx);
      }
    }

    if (head != null) {
      state.lastScanHead = head;
      this.recordMetric(() => this.metrics?.laneCursorLag(lane.spec.name, Math.max(0, head - state.lastBlock)));
    }
    state.lastScanAtMs = now;

    // Taken BEFORE the forward-work test: the wide re-scan exists precisely for
    // the steady state where the lane is caught up and the forward scan finds
    // nothing, so gating it on forward work would disable it exactly when it is
    // the only thing looking at the blocks a lagging endpoint may have hidden.

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
    //
    // But a failed replay window is NOT forgotten (review r19): the replay
    // is the only mechanism recovering events a lagging RPC hid, and its
    // window TRAILS the head — waiting for the next scheduled tick would
    // re-derive a NEWER window, so a mutation whose durable dispatch
    // rejected would silently exit the trailing range and be lost despite
    // the callback documented redelivery contract. The EXACT failed window
    // is retained on the lane and retried every poll until it dispatches
    // cleanly; the forward cursor and forward scan stay untouched.
    // The trailing replay — scheduling, retained-retry priority, the
    // unread-window guard and durable bookkeeping — is the coordinator’s
    // (review r3-bot); this scheduler only dispatches what it hands over.
    // After a restore rewind (or a confirmation-depth increase) the cursor
    // itself can sit above the finalized head; the replay bound must be the
    // FINALIZED view, not the raw cursor (review r7-bot). `head` here is
    // already the finalized head for a scanOnlyFinalizedHead lane.
    // `head` is already the finalized head for a scanOnlyFinalizedHead lane;
    // only such lanes carry a bound — other lanes keep the pre-existing
    // contract of dispatching a restored window in full (idempotent overlap
    // with the forward scan) and clearing it.
    const finalizedBound = lane.spec.scanOnlyFinalizedHead && head != null ? head : undefined;
    await lane.replay.dispatchDue(
      state.lastBlock,
      (window) => this.dispatchWindow(lane, window.fromBlock, window.toBlock, ctx),
      finalizedBound,
    );
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


  private applyLaneSchedule(lane: ChainEventPollerLaneRuntime, outcome: ChainEventLaneScheduleOutcome): void {
    const state = lane.state;
    if (outcome.kind === 'noWork') {
      this.recordMetric(() => this.metrics?.laneScan(lane.spec.name, 'noWork'));
      state.nextRunAtMs = outcome.now + lane.spec.cadenceMs;
      return;
    }
    if (outcome.kind === 'success') {
      this.recordMetric(() => this.metrics?.laneScan(lane.spec.name, 'success'));
      state.failureBackoffMs = undefined;
      state.nextRunAtMs = outcome.caughtUp ? outcome.now + lane.spec.cadenceMs : undefined;
      return;
    }

    this.recordMetric(() => this.metrics?.laneScan(lane.spec.name, 'failure'));
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
