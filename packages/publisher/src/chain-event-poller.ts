import type { ChainAdapter, ChainEvent } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import type { PublishHandler } from './publish-handler.js';
import { ethers } from 'ethers';
import {
  ChainEventLaneRunner,
  type ChainEventPollerLaneSpec,
} from './chain-event-lane-runner.js';
import type { CursorPersistence as RunnerCursorPersistence } from './chain-event-lane-cursor-store.js';

export type { ChainEventPollerLane } from './chain-event-lane-runner.js';
export type {
  CursorPersistence,
  LaneCursorPersistence,
  LegacyCursorPersistence,
} from './chain-event-lane-cursor-store.js';

/** Callback invoked when a ContextGraphCreated event is detected. */
export type OnContextGraphCreated = (info: {
  contextGraphId: string;
  creator: string;
  accessPolicy: number;
  publishPolicy?: number;
  /**
   * OT-RFC-38 / LU-6 Phase B — curator-committed wire id (the
   * `bytes32 indexed nameHash` field on `ContextGraphCreated`).
   * `null` indicates the curator opted out at create time; cores then
   * rely on the discovery-beacon path to learn the wire id. Lowercase
   * 0x-prefixed 32-byte hex when set.
   */
  nameHash?: string | null;
  blockNumber: number;
}) => Promise<void>;

/** Callback for KnowledgeAssetUpdated events (spec §5.1). */
export type OnCollectionUpdated = (info: {
  merkleRoot: Uint8Array;
  batchId: bigint;
  blockNumber: number;
}) => Promise<void>;

/** Callback for AllowListUpdated events (spec §5.1). */
export type OnAllowListUpdated = (info: {
  contextGraphId: string;
  agent: string;
  added: boolean;
  blockNumber: number;
}) => Promise<void>;

/** Callback for ProfileCreated / ProfileUpdated events (spec §5.1). */
export type OnProfileEvent = (info: {
  identityId: bigint;
  blockNumber: number;
}) => Promise<void>;

/**
 * Callback for `KnowledgeAssetRegisteredToContextGraph` events — the
 * canonical "a KA was bound to a CG" signal that drives chain-driven VM
 * reconciliation (Phase B). Both ids are indexed on-chain. The poller is a
 * low-latency *nudge*: the receiver runs an ordinal sweep for `contextGraphId`
 * (the event does not carry the per-CG ordinal), so a missed event is
 * harmless — the periodic/startup sweep fills it in.
 */
export type OnKARegisteredToContextGraph = (info: {
  contextGraphId: string;
  kaId: bigint;
  txHash: string;
  txIndex?: number;
  blockNumber: number;
}, signal?: AbortSignal) => Promise<void>;

/**
 * Callback for `KnowledgeAssetCreated` events — OT-RFC-43 Option-1 allocator
 * reconciliation. The storage contract emits `KnowledgeAssetCreated(kaId,
 * author, …)` (see `packages/evm-module/contracts/storage/DKGKnowledgeAssets.sol`).
 * `number` is the per-author ordinal extracted from the low 96 bits of `kaId`
 * using full-precision bigint math.
 */
export type OnKnowledgeAssetCreated = (e: { kaId: bigint; author: string; number: bigint; txHash: string; txIndex: number; blockNumber: number }) => void | Promise<void>;

export interface ChainEventPollerConfig {
  chain: ChainAdapter;
  publishHandler: PublishHandler;
  /** Polling interval in ms. Default: 12000 (roughly 1 L2 block). */
  intervalMs?: number;
  /** Test seam for deterministic lane-cadence assertions. */
  clock?: () => number;
  /** Called when a ContextGraphCreated event is detected on-chain. */
  onContextGraphCreated?: OnContextGraphCreated;
  /** Called when a KnowledgeAssetUpdated event is detected. */
  onCollectionUpdated?: OnCollectionUpdated;
  /** Called when an AllowListUpdated event is detected. */
  onAllowListUpdated?: OnAllowListUpdated;
  /** Called when a ProfileCreated/Updated event is detected. */
  onProfileEvent?: OnProfileEvent;
  /** Called when a KnowledgeAssetRegisteredToContextGraph event is detected (Phase B). */
  onKARegisteredToContextGraph?: OnKARegisteredToContextGraph;
  /** Called when a KnowledgeAssetCreated event is detected (OT-RFC-43 Option-1 allocator reconciliation). */
  onKnowledgeAssetCreated?: OnKnowledgeAssetCreated;
  /** Persistent cursor for surviving restarts. */
  cursorPersistence?: RunnerCursorPersistence;
}

/**
 * Background poller that watches for on-chain events (spec §5.1):
 * - KCCreated: promotes tentative publishes to confirmed (V10 batch creation)
 * - NameClaimed / ContextGraphCreated: notifies the agent of new CGs
 * - KnowledgeAssetUpdated: applies UPDATE to LTM
 * - AllowListUpdated: updates subscription state
 * - ProfileCreated / ProfileUpdated: updates peer identity cache
 *
 * NOTE: the legacy V9 batch-creation event was archived together with
 * `KnowledgeAssets`/`KnowledgeAssetsStorage` (see
 * `packages/chain/src/archive/`). The poller no longer subscribes to it.
 * The CHANGELOG entry for the archive PR carries the migration note.
 *
 * The chain is the single source of truth for finalization ordering.
 * GossipSub is best-effort — the poller is the safety net that ensures
 * eventual convergence with the chain.
 */
export class ChainEventPoller {
  private readonly chain: ChainAdapter;
  private readonly publishHandler: PublishHandler;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly onContextGraphCreated?: OnContextGraphCreated;
  private readonly onCollectionUpdated?: OnCollectionUpdated;
  private readonly onAllowListUpdated?: OnAllowListUpdated;
  private readonly onProfileEvent?: OnProfileEvent;
  private readonly onKARegisteredToContextGraph?: OnKARegisteredToContextGraph;
  private readonly onKnowledgeAssetCreated?: OnKnowledgeAssetCreated;
  private readonly laneRunner: ChainEventLaneRunner;
  private readonly log = new Logger('ChainEventPoller');
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopController: AbortController | null = null;
  /**
   * The currently-executing `poll()` promise (or `null` when idle).
   *
   * `stop()` awaits this so callers can deterministically tear down
   * the chain adapter (and the underlying HTTP keep-alive socket)
   * without racing an in-flight RPC. In tests, this is what stops
   * `ECONNRESET` rejections from leaking after `killHardhat()` —
   * the in-flight RPC promise has either resolved or rejected (with
   * the catch handler we attach) BEFORE the chain goes away.
   */
  private inFlightPoll: Promise<void> | null = null;

  /** Max blocks to scan per poll — stays within typical RPC range limits. */
  private static readonly MAX_RANGE = 9_000;

  constructor(config: ChainEventPollerConfig) {
    this.chain = config.chain;
    this.publishHandler = config.publishHandler;
    this.intervalMs = config.intervalMs ?? 12_000;
    this.clock = config.clock ?? (() => Date.now());
    this.onContextGraphCreated = config.onContextGraphCreated;
    this.onCollectionUpdated = config.onCollectionUpdated;
    this.onAllowListUpdated = config.onAllowListUpdated;
    this.onProfileEvent = config.onProfileEvent;
    this.onKARegisteredToContextGraph = config.onKARegisteredToContextGraph;
    this.onKnowledgeAssetCreated = config.onKnowledgeAssetCreated;
    this.laneRunner = new ChainEventLaneRunner({
      chain: this.chain,
      lanes: this.laneSpecs(),
      maxRange: ChainEventPoller.MAX_RANGE,
      clock: this.clock,
      log: this.log,
      cursorPersistence: config.cursorPersistence,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const stopController = new AbortController();
    this.stopController = stopController;

    const ctx = createOperationContext('system');

    // Restore cursor from persistent storage (spec §5.1: scan from last processed block)
    await this.laneRunner.restoreCurrentlyActive(ctx);
    if (!this.running) return;

    this.log.info(ctx, `Starting chain event poller (interval=${this.intervalMs}ms)`);

    this.timer = setInterval(() => {
      // Serialize: if the previous poll is still in flight, skip this tick.
      // Without this guard, overlapping polls would stack up — each tick
      // would overwrite `inFlightPoll` and orphan the previous one along
      // with its in-flight `eth_getLogs` HTTP request. On test teardown
      // (or any RPC connection close) those orphaned sockets surface as
      // `TCP.onStreamRead ECONNRESET` unhandled rejections — observed as
      // 40k+ errors per file in `chain-event-poller-extra.test.ts`. The
      // chain is monotonic and the poll catches up via `MAX_RANGE`, so a
      // skipped tick is functionally identical to slightly longer cadence.
      if (this.inFlightPoll) return;
      this.inFlightPoll = this.poll(this.stopController?.signal)
        .catch((err) => {
          const pollCtx = createOperationContext('system');
          this.log.error(pollCtx, `Poll failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { this.inFlightPoll = null; });
    }, this.intervalMs);

    // Run first poll immediately, and track it so `stop()` can await it.
    this.inFlightPoll = this.poll(stopController.signal)
      .catch(() => {})
      .finally(() => { this.inFlightPoll = null; });
  }

  /** Wait for the startup/current poll without exposing poller internals. */
  async waitForCurrentPoll(): Promise<void> {
    const pending = this.inFlightPoll;
    if (pending) await pending;
  }

  /**
   * Stop the interval and wait for any in-flight poll to settle.
   *
   * Returns a Promise so callers can `await poller.stop()` before
   * tearing down the chain adapter / RPC connection — without this,
   * an in-flight `eth_getLogs` would still be holding an HTTP keep-
   * alive socket open and a downstream `killHardhat()` (in tests) or
   * `provider.destroy()` (in prod shutdown) would surface as an
   * `ECONNRESET` unhandled rejection from somewhere inside ethers.
   *
   * Idempotent: a second `stop()` after the first has resolved is a
   * no-op. Legacy synchronous callers may still treat the return as
   * void; they just lose the in-flight-await guarantee.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    // Stop after the current event callback and do not start another lane or
    // dispatch another event from a large historical page. The current lane's
    // cursor deliberately remains unchanged so any partial page is replayed
    // safely on restart.
    this.stopController?.abort();
    const pending = this.inFlightPoll;
    if (pending) {
      // The `.catch(() => {})` chain at the call sites already swallows
      // rejections, but defensively guard against an externally-rejected
      // promise here too. We just want to wait for completion. The
      // `.finally(() => { this.inFlightPoll = null })` in start() will
      // null out `inFlightPoll` once the await unblocks.
      try { await pending; } catch { /* already logged or swallowed */ }
    }
    this.stopController = null;

    const ctx = createOperationContext('system');
    this.log.info(ctx, 'Chain event poller stopped');
  }

  private laneSpecs(): ChainEventPollerLaneSpec[] {
    return [
      {
        name: 'publish',
        enabled: () => this.publishHandler.hasPendingPublishes,
        eventTypes: () => ['KCCreated'],
        requiresFullHistory: () => this.publishHandler.hasRestoredPendingPublishes,
        canUseLegacyAggregateCursor: () => this.publishHandler.hasRestoredPendingPublishes,
        // A live publish can be activated after its KCCreated event is already
        // beyond the generic live-tail window on fast chains. Scan one full RPC
        // page on activation without falling back to a genesis backfill.
        liveSeedLookbackBlocks: ChainEventPoller.MAX_RANGE,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleBatchCreated(event, ctx),
      },
      {
        name: 'allocatorReconcile',
        enabled: () => !!this.onKnowledgeAssetCreated,
        eventTypes: () => ['KCCreated'],
        requiresFullHistory: () => true,
        canUseLegacyAggregateCursor: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleKACreated(event, ctx),
        onBackfillFromGenesis: (ctx) => {
          if (!this.onKnowledgeAssetCreated) return;
          this.log.info(ctx, 'Allocator-reconciliation watcher wired and no persisted cursor - scanning from block 0 (codex PR #976 F9 backfill)');
        },
      },
      {
        name: 'contextGraphDiscovery',
        enabled: () => !!this.onContextGraphCreated,
        eventTypes: () => ['NameClaimed', 'ContextGraphCreated'],
        // This poller is the low-latency live tail for new context graphs.
        // Historical recovery is handled by the daemon's
        // discoverContextGraphsFromChain scan and incremental watermark.
        requiresFullHistory: () => false,
        canUseLegacyAggregateCursor: () => true,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleContextGraphCreated(event, ctx),
      },
      {
        name: 'vmReconcile',
        enabled: () => !!this.onKARegisteredToContextGraph,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx, signal) => this.handleKARegistered(event, ctx, signal),
      },
      {
        name: 'collectionUpdates',
        enabled: () => !!this.onCollectionUpdated,
        eventTypes: () => ['KnowledgeAssetUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleCollectionUpdated(event, ctx),
      },
      {
        name: 'allowListUpdates',
        enabled: () => !!this.onAllowListUpdated,
        eventTypes: () => ['AllowListUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleAllowListUpdated(event, ctx),
      },
      {
        name: 'profileEvents',
        enabled: () => !!this.onProfileEvent,
        eventTypes: () => ['ProfileCreated', 'ProfileUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, ctx) => this.handleProfileEvent(event, ctx),
      },
    ];
  }

  private async poll(signal?: AbortSignal): Promise<void> {
    await this.laneRunner.poll(signal);
  }

  private async handleBatchCreated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    const { data } = event;

    const merkleRoot = typeof data['merkleRoot'] === 'string'
      ? ethers.getBytes(data['merkleRoot'] as string)
      : data['merkleRoot'] as Uint8Array;

    const publisherAddress = data['publisherAddress'] as string ?? '';
    const startKAId = BigInt(data['startKAId'] as string ?? '0');
    const endKAId = BigInt(data['endKAId'] as string ?? '0');

    this.log.info(ctx,
      `Chain event: KCCreated block=${event.blockNumber} ` +
      `publisher=${publisherAddress} range=${startKAId}..${endKAId}`,
    );

    const confirmed = await this.publishHandler.confirmByMerkleRoot(
      merkleRoot,
      {
        publisherAddress,
        startKAId,
        endKAId,
        chainId: this.chain.chainId,
      },
      ctx,
    );

    if (confirmed) {
      this.log.info(ctx, `Confirmed tentative publish via chain event (block ${event.blockNumber})`);
    }
  }

  private async handleContextGraphCreated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onContextGraphCreated) return;
    const { data } = event;
    const contextGraphId = String(data['contextGraphId'] ?? '');
    const creator = String(data['creator'] ?? data['owner'] ?? data['manager'] ?? '');
    const accessPolicy = Number(data['accessPolicy'] ?? 0);
    const publishPolicy = data['publishPolicy'] == null ? undefined : Number(data['publishPolicy']);
    // OT-RFC-38 / LU-6 Phase B — surface the curator-committed wire id
    // verbatim. The EVM/mock adapters already normalise to a lowercase
    // 0x-prefixed hex string or `null` (opt-out path); the poller
    // passes the value through so the agent's auto-subscribe handler
    // can derive the SWM gossip topic without round-tripping back to
    // chain. Field name on the adapter event surface is `nameHash`.
    const rawNameHash = data['nameHash'];
    const nameHash: string | null = typeof rawNameHash === 'string' && rawNameHash.length > 0
      ? rawNameHash.toLowerCase()
      : null;

    this.log.info(ctx,
      `Chain event: ContextGraphCreated block=${event.blockNumber} id=${contextGraphId.slice(0, 16)}… creator=${creator.slice(0, 10)}… nameHash=${nameHash ? nameHash.slice(0, 10) + '…' : '(opt-out)'}`,
    );

    try {
      await this.onContextGraphCreated({
        contextGraphId,
        creator,
        accessPolicy,
        publishPolicy,
        nameHash,
        blockNumber: event.blockNumber,
      });
    } catch (err) {
      this.log.warn(ctx, `onContextGraphCreated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCollectionUpdated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onCollectionUpdated) return;
    const { data } = event;
    const merkleRoot = typeof data['merkleRoot'] === 'string'
      ? ethers.getBytes(data['merkleRoot'] as string)
      : data['merkleRoot'] as Uint8Array;
    const batchId = BigInt(data['batchId'] as string ?? '0');

    this.log.info(ctx,
      `Chain event: KnowledgeAssetUpdated block=${event.blockNumber} batchId=${batchId}`,
    );

    try {
      await this.onCollectionUpdated({ merkleRoot, batchId, blockNumber: event.blockNumber });
    } catch (err) {
      this.log.warn(ctx, `onCollectionUpdated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleAllowListUpdated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onAllowListUpdated) return;
    const { data } = event;
    const contextGraphId = String(data['contextGraphId'] ?? '');
    const agent = String(data['agent'] ?? '');
    const added = Boolean(data['added'] ?? true);

    this.log.info(ctx,
      `Chain event: AllowListUpdated block=${event.blockNumber} cg=${contextGraphId.slice(0, 16)}… agent=${agent.slice(0, 10)}… added=${added}`,
    );

    try {
      await this.onAllowListUpdated({ contextGraphId, agent, added, blockNumber: event.blockNumber });
    } catch (err) {
      this.log.warn(ctx, `onAllowListUpdated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleProfileEvent(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onProfileEvent) return;
    const { data } = event;
    const identityId = BigInt(data['identityId'] as string ?? '0');

    this.log.info(ctx,
      `Chain event: ${event.type} block=${event.blockNumber} identityId=${identityId}`,
    );

    try {
      await this.onProfileEvent({ identityId, blockNumber: event.blockNumber });
    } catch (err) {
      this.log.warn(ctx, `onProfileEvent callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleKARegistered(
    event: ChainEvent,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.onKARegisteredToContextGraph) return;
    const { data } = event;
    const contextGraphId = String(data['contextGraphId'] ?? '');
    const kaId = BigInt((data['kaId'] as string) ?? '0');
    const txHash = String(data['txHash'] ?? '');
    const rawTxIndex = data['txIndex'];
    const txIndex = typeof rawTxIndex === 'number' && Number.isFinite(rawTxIndex) && rawTxIndex >= 0
      ? rawTxIndex
      : undefined;

    if (!contextGraphId || kaId === 0n) return;

    this.log.info(ctx,
      `Chain event: KnowledgeAssetRegisteredToContextGraph block=${event.blockNumber} cg=${contextGraphId} kaId=${kaId}`,
    );

    try {
      await this.onKARegisteredToContextGraph({
        contextGraphId,
        kaId,
        txHash,
        txIndex,
        blockNumber: event.blockNumber,
      }, signal);
    } catch (err) {
      this.log.warn(ctx, `onKARegisteredToContextGraph callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleKACreated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onKnowledgeAssetCreated) return;
    const { data } = event;
    const kaId = BigInt((data['kaId'] as string) ?? '0');
    if (kaId === 0n) return;
    const author = String(data['author'] ?? '').toLowerCase();
    const txHash = String(data['txHash'] ?? '');
    const rawTxIndex = data['txIndex'];
    const txIndex = typeof rawTxIndex === 'number' && Number.isFinite(rawTxIndex) && rawTxIndex >= 0
      ? rawTxIndex
      : 0;
    // OT-RFC-43 Option-1 — the per-author ordinal lives in the low 96 bits of
    // the kaId. Use full-precision bigint math; never coerce through Number()
    // (the value can exceed Number.MAX_SAFE_INTEGER and silently lose digits).
    const number = kaId & ((1n << 96n) - 1n);

    this.log.info(ctx,
      `Chain event: KnowledgeAssetCreated block=${event.blockNumber} kaId=${kaId} author=${author.slice(0, 10)}… number=${number}`,
    );

    try {
      await this.onKnowledgeAssetCreated({
        kaId,
        author,
        number,
        txHash,
        txIndex,
        blockNumber: event.blockNumber,
      });
    } catch (err) {
      this.log.warn(ctx, `onKnowledgeAssetCreated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
