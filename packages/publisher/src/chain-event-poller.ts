import type { ChainEventDispatchContext } from './chain-event-dispatch-context.js';
import type { ChainAdapter, ChainEvent } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
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
}, context: ChainEventDispatchContext) => Promise<void>;

/** Callback for KnowledgeAssetUpdated events (spec §5.1). */
export type OnCollectionUpdated = (info: {
  merkleRoot: Uint8Array;
  batchId: bigint;
  blockNumber: number;
}, context: ChainEventDispatchContext) => Promise<void>;

/** Callback for AllowListUpdated events (spec §5.1). */
export type OnAllowListUpdated = (info: {
  contextGraphId: string;
  agent: string;
  added: boolean;
  blockNumber: number;
}, context: ChainEventDispatchContext) => Promise<void>;

/** Callback for ProfileCreated / ProfileUpdated events (spec §5.1). */
export type OnProfileEvent = (info: {
  identityId: bigint;
  blockNumber: number;
}, context: ChainEventDispatchContext) => Promise<void>;

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
}, context: ChainEventDispatchContext) => Promise<void>;

/**
 * Callback for `KnowledgeAssetCreated` events — OT-RFC-43 Option-1 allocator
 * reconciliation. The storage contract emits `KnowledgeAssetCreated(kaId,
 * author, …)` (see `packages/evm-module/contracts/storage/DKGKnowledgeAssets.sol`).
 * `number` is the per-author ordinal extracted from the low 96 bits of `kaId`
 * using full-precision bigint math.
 */
export type OnKnowledgeAssetCreated = (e: { kaId: bigint; author: string; number: bigint; txHash: string; txIndex: number; blockNumber: number }, context: ChainEventDispatchContext) => void | Promise<void>;

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

/** One admitted generation owns all work that stop/restart must retire. */
interface ChainEventPollGeneration {
  readonly controller: AbortController;
  timer: ReturnType<typeof setInterval> | null;
  active: Promise<void> | null;
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
  private currentGeneration: ChainEventPollGeneration | null = null;
  /** Closed generations retain ownership until all physical work has settled. */
  private retirement: Promise<void> = Promise.resolve();

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
    if (this.currentGeneration) return;
    const previous = this.retirement;
    const generation: ChainEventPollGeneration = {
      controller: new AbortController(), timer: null, active: null,
    };
    this.currentGeneration = generation;
    const { signal } = generation.controller;
    const ctx = createOperationContext('system');
    const restore = (async () => {
      // A queued generation owns this wait too: closing/restarting it cannot
      // bypass the physical work still retiring from its predecessor.
      await previous;
      if (this.isCurrentGeneration(generation)) {
        await this.laneRunner.restoreCurrentlyActive({ operation: ctx, signal });
      }
    })();
    generation.active = restore;
    try {
      await restore;
    } catch (error) {
      if (!signal.aborted) {
        this.closeAdmission();
        throw error;
      }
    } finally {
      if (generation.active === restore) generation.active = null;
    }
    if (!this.isCurrentGeneration(generation)) return;

    this.log.info(ctx, `Starting chain event poller (interval=${this.intervalMs}ms)`);
    generation.timer = setInterval(() => this.runPoll(generation), this.intervalMs);
    this.runPoll(generation);
  }

  private isCurrentGeneration(generation: ChainEventPollGeneration): boolean {
    return this.currentGeneration === generation;
  }

  private runPoll(generation: ChainEventPollGeneration): void {
    if (!this.isCurrentGeneration(generation) || generation.active) return;
    const { signal } = generation.controller;
    const context: ChainEventDispatchContext = { operation: createOperationContext('publish'), signal };
    const pending = this.poll(context)
      .catch(error => {
        if (!signal.aborted) {
          this.log.error(context.operation, `Poll failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => { if (generation.active === pending) generation.active = null; });
    generation.active = pending;
  }

  /** Wait for admitted work, or the physical retirement after admission closes. */
  async waitForCurrentPoll(): Promise<void> {
    await (this.currentGeneration?.active ?? this.retirement);
  }

  /** Fence new events and cancel cooperative work before a shutdown await. */
  closeAdmission(): void {
    const generation = this.currentGeneration;
    if (!generation) return;
    this.currentGeneration = null;
    if (generation.timer) {
      clearInterval(generation.timer);
      generation.timer = null;
    }
    // Publish retirement before abort listeners can synchronously restart us.
    if (generation.active) this.retirement = generation.active.then(() => {}, () => {});
    generation.controller.abort();
  }

  /** Cancel admission, then physically drain the current poll or startup restore. */
  async stop(): Promise<void> {
    this.closeAdmission();
    await this.retirement;
    this.log.info(createOperationContext('system'), 'Chain event poller stopped');
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
        dispatch: (event, context) => this.handleBatchCreated(event, context),
      },
      {
        name: 'allocatorReconcile',
        enabled: () => !!this.onKnowledgeAssetCreated,
        eventTypes: () => ['KCCreated'],
        requiresFullHistory: () => true,
        canUseLegacyAggregateCursor: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, context) => this.handleKACreated(event, context),
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
        dispatch: (event, context) => this.handleContextGraphCreated(event, context),
      },
      {
        name: 'vmReconcile',
        enabled: () => !!this.onKARegisteredToContextGraph,
        eventTypes: () => ['KnowledgeAssetRegisteredToContextGraph'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, context) => this.handleKARegistered(event, context),
      },
      {
        name: 'collectionUpdates',
        enabled: () => !!this.onCollectionUpdated,
        eventTypes: () => ['KnowledgeAssetUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, context) => this.handleCollectionUpdated(event, context),
      },
      {
        name: 'allowListUpdates',
        enabled: () => !!this.onAllowListUpdated,
        eventTypes: () => ['AllowListUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, context) => this.handleAllowListUpdated(event, context),
      },
      {
        name: 'profileEvents',
        enabled: () => !!this.onProfileEvent,
        eventTypes: () => ['ProfileCreated', 'ProfileUpdated'],
        requiresFullHistory: () => false,
        cadenceMs: this.intervalMs,
        dispatch: (event, context) => this.handleProfileEvent(event, context),
      },
    ];
  }

  private async poll(context: ChainEventDispatchContext): Promise<void> {
    await this.laneRunner.poll(context);
  }

  private async handleBatchCreated(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
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

  private async handleContextGraphCreated(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
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
      }, context);
    } catch (err) {
      this.log.warn(ctx, `onContextGraphCreated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCollectionUpdated(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
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
      await this.onCollectionUpdated({ merkleRoot, batchId, blockNumber: event.blockNumber }, context);
    } catch (err) {
      this.log.warn(ctx, `onCollectionUpdated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleAllowListUpdated(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
    if (!this.onAllowListUpdated) return;
    const { data } = event;
    const contextGraphId = String(data['contextGraphId'] ?? '');
    const agent = String(data['agent'] ?? '');
    const added = Boolean(data['added'] ?? true);

    this.log.info(ctx,
      `Chain event: AllowListUpdated block=${event.blockNumber} cg=${contextGraphId.slice(0, 16)}… agent=${agent.slice(0, 10)}… added=${added}`,
    );

    try {
      await this.onAllowListUpdated({ contextGraphId, agent, added, blockNumber: event.blockNumber }, context);
    } catch (err) {
      this.log.warn(ctx, `onAllowListUpdated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleProfileEvent(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
    if (!this.onProfileEvent) return;
    const { data } = event;
    const identityId = BigInt(data['identityId'] as string ?? '0');

    this.log.info(ctx,
      `Chain event: ${event.type} block=${event.blockNumber} identityId=${identityId}`,
    );

    try {
      await this.onProfileEvent({ identityId, blockNumber: event.blockNumber }, context);
    } catch (err) {
      this.log.warn(ctx, `onProfileEvent callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleKARegistered(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
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
      }, context);
    } catch (err) {
      this.log.warn(ctx, `onKARegisteredToContextGraph callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleKACreated(event: ChainEvent, context: ChainEventDispatchContext): Promise<void> {
    const { operation: ctx } = context;
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
      }, context);
    } catch (err) {
      this.log.warn(ctx, `onKnowledgeAssetCreated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
