import type { ChainAdapter, EventFilter, ChainEvent } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import type { PublishHandler } from './publish-handler.js';
import { ethers } from 'ethers';

/** Callback invoked when a ContextGraphCreated event is detected. */
export type OnContextGraphCreated = (info: {
  contextGraphId: string;
  creator: string;
  accessPolicy: number;
  blockNumber: number;
}) => Promise<void>;

/** @deprecated Use OnContextGraphCreated */
export type OnParanetCreated = OnContextGraphCreated;

/** Callback for KnowledgeCollectionUpdated events (spec §5.1). */
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

/** Persistence interface for saving/loading the last processed block. */
export interface CursorPersistence {
  load(): Promise<number | undefined>;
  save(blockNumber: number): Promise<void>;
}

export interface ChainEventPollerConfig {
  chain: ChainAdapter;
  publishHandler: PublishHandler;
  /** Polling interval in ms. Default: 12000 (roughly 1 L2 block). */
  intervalMs?: number;
  /** Called when a ContextGraphCreated event is detected on-chain. */
  onContextGraphCreated?: OnContextGraphCreated;
  /** Called when a KnowledgeCollectionUpdated event is detected. */
  onCollectionUpdated?: OnCollectionUpdated;
  /** Called when an AllowListUpdated event is detected. */
  onAllowListUpdated?: OnAllowListUpdated;
  /** Called when a ProfileCreated/Updated event is detected. */
  onProfileEvent?: OnProfileEvent;
  /** Persistent cursor for surviving restarts. */
  cursorPersistence?: CursorPersistence;
}

/**
 * Background poller that watches for on-chain events (spec §5.1):
 * - KnowledgeBatchCreated / KCCreated: promotes tentative publishes to confirmed
 * - ParanetCreated / ContextGraphCreated: notifies the agent of new CGs
 * - KnowledgeCollectionUpdated: applies UPDATE to LTM
 * - AllowListUpdated: updates subscription state
 * - ProfileCreated / ProfileUpdated: updates peer identity cache
 *
 * The chain is the single source of truth for finalization ordering.
 * GossipSub is best-effort — the poller is the safety net that ensures
 * eventual convergence with the chain.
 */
export class ChainEventPoller {
  private readonly chain: ChainAdapter;
  private readonly publishHandler: PublishHandler;
  private readonly intervalMs: number;
  private readonly onContextGraphCreated?: OnContextGraphCreated;
  private readonly onCollectionUpdated?: OnCollectionUpdated;
  private readonly onAllowListUpdated?: OnAllowListUpdated;
  private readonly onProfileEvent?: OnProfileEvent;
  private readonly cursorPersistence?: CursorPersistence;
  private readonly log = new Logger('ChainEventPoller');
  private lastBlock = 0;
  private headKnown = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /**
   * Consecutive transient failures since the last successful poll. Used to
   * escalate a stuck transient (e.g. RPC URL is permanently broken) from
   * [WARN] to [ERROR] so genuinely-broken endpoints surface in the E2E
   * "no fatal ERROR lines" contract instead of being suppressed forever.
   */
  private consecutiveTransientFailures = 0;

  /** Max blocks to scan per poll — stays within typical RPC range limits. */
  private static readonly MAX_RANGE = 9_000;
  /**
   * After this many consecutive transient failures we assume the
   * "transient" classifier is masking a permanent fault and log at
   * [ERROR] instead. With the default 12s interval that is ~60s of
   * uninterrupted upstream errors, well past any reasonable transient
   * blip on a healthy RPC endpoint.
   */
  private static readonly TRANSIENT_ESCALATION_AFTER = 5;

  constructor(config: ChainEventPollerConfig) {
    this.chain = config.chain;
    this.publishHandler = config.publishHandler;
    this.intervalMs = config.intervalMs ?? 12_000;
    this.onContextGraphCreated = config.onContextGraphCreated;
    this.onCollectionUpdated = config.onCollectionUpdated;
    this.onAllowListUpdated = config.onAllowListUpdated;
    this.onProfileEvent = config.onProfileEvent;
    this.cursorPersistence = config.cursorPersistence;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const ctx = createOperationContext('system');

    // Restore cursor from persistent storage (spec §5.1: scan from last processed block)
    if (this.cursorPersistence) {
      try {
        const saved = await this.cursorPersistence.load();
        if (saved != null && saved > 0) {
          this.lastBlock = saved;
          this.log.info(ctx, `Restored poller cursor from persistence: block ${saved}`);
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to load persisted cursor: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.log.info(ctx, `Starting chain event poller (interval=${this.intervalMs}ms)`);

    this.timer = setInterval(() => {
      this.poll()
        .then(() => {
          // Successful poll — reset the transient-failure escalation
          // counter so a fresh series of upstream blips starts from
          // zero rather than carrying over decade-old retries.
          this.consecutiveTransientFailures = 0;
        })
        .catch((err) => {
          this.handlePollFailure(err);
        });
    }, this.intervalMs);

    // Run first poll immediately
    this.poll().catch(() => {});
  }

  /**
   * Classify a poll-loop error as a recoverable transient or a real
   * failure. Exposed (and tested) so the rule-set is auditable in
   * isolation rather than buried inside the `setInterval` callback.
   *
   * Two transient categories are treated as recoverable:
   *
   *   - `chain head race` — Hardhat / ethers fast-iterating tests
   *     occasionally call `eth_getLogs` with `toBlock` momentarily
   *     past the current head between our `getBlockNumber()` and the
   *     `eth_getLogs` round-trip. The cursor does not advance on
   *     failure and the next tick retries. (PR #229 r12 fix.)
   *   - `upstream RPC` — public RPC endpoints (e.g. sepolia.base.org)
   *     periodically return 5xx gateway errors or close the socket
   *     mid-request. ethers wraps these as `code=SERVER_ERROR`. Same
   *     contract: cursor does not advance, next tick retries.
   *     (Post-v10-rc merge fix; surfaced by the
   *     `three-player-game.test.ts` E2E "no fatal ERROR lines"
   *     assertion red-lighting on a single 502.)
   *
   * Anything else is a real failure. Logging at [ERROR] is the right
   * shape so genuine bugs surface in the same E2E assertion.
   */
  static classifyPollFailure(err: unknown): {
    kind: 'chain-head-race' | 'upstream-rpc' | 'fatal';
    message: string;
  } {
    const message = err instanceof Error ? err.message : String(err);
    const isTransientHeadRace =
      /block range extends beyond current head block/i.test(message)
      || /code=UNKNOWN_ERROR.*32602/i.test(message);
    if (isTransientHeadRace) return { kind: 'chain-head-race', message };
    const isTransientUpstreamRpc =
      /code=SERVER_ERROR/i.test(message)
      || /\b50\d\b\s*(?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error)/i.test(message)
      || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(message);
    if (isTransientUpstreamRpc) return { kind: 'upstream-rpc', message };
    return { kind: 'fatal', message };
  }

  /**
   * Apply the classifier and emit the matching log line. Tracks
   * consecutive transient failures so a permanently broken endpoint
   * (wrong URL, dead provider) eventually escalates from [WARN] to
   * [ERROR] — without this, the warn-only classifier would itself be
   * a false-negative-producing test smell.
   */
  private handlePollFailure(err: unknown): void {
    const pollCtx = createOperationContext('system');
    const { kind, message } = ChainEventPoller.classifyPollFailure(err);
    if (kind === 'fatal') {
      this.log.error(pollCtx, `Poll failed: ${message}`);
      return;
    }
    this.consecutiveTransientFailures += 1;
    if (this.consecutiveTransientFailures >= ChainEventPoller.TRANSIENT_ESCALATION_AFTER) {
      this.log.error(
        pollCtx,
        `Poll failed: transient persisted ${this.consecutiveTransientFailures} ticks (last error: ${message})`,
      );
      return;
    }
    const reason = kind === 'chain-head-race' ? 'chain head race' : 'upstream RPC';
    this.log.warn(
      pollCtx,
      `Poll transient (${reason} — retrying next tick, ${this.consecutiveTransientFailures}/${ChainEventPoller.TRANSIENT_ESCALATION_AFTER}): ${message}`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;

    const ctx = createOperationContext('system');
    this.log.info(ctx, 'Chain event poller stopped');
  }

  private async poll(): Promise<void> {
    const hasPending = this.publishHandler.hasPendingPublishes;
    const watchContextGraphs = !!this.onContextGraphCreated;
    const watchUpdates = !!this.onCollectionUpdated;
    const watchAllowList = !!this.onAllowListUpdated;
    const watchProfiles = !!this.onProfileEvent;
    if (!hasPending && !watchContextGraphs && !watchUpdates && !watchAllowList && !watchProfiles) return;

    const ctx = createOperationContext('publish');

    // Resolve the actual chain head so we can bound the scan precisely.
    // Without a known head we cannot safely advance the cursor.
    let head: number | undefined;
    if (this.chain.getBlockNumber) {
      try { head = await this.chain.getBlockNumber(); } catch { /* unavailable */ }
    }

    // On first successful head fetch, seed cursor near the tip — but only
    // when there are no pending publishes whose confirmations we might skip.
    // Full-history context graph discovery is handled by discoverContextGraphsFromChain().
    if (head != null && !this.headKnown) {
      this.headKnown = true;
      if (this.lastBlock === 0 && !hasPending) {
        this.lastBlock = Math.max(0, head - 500);
        this.log.info(ctx, `Seeded poller cursor near chain head: ${head} → scanning from ${this.lastBlock}`);
      }
    }

    // Always listen for both V9 and V10 events: even when V10 is deployed,
    // the publisher still falls back to V9 for private publishes and ACK
    // collection failures. Stopping legacy event polling would leave those
    // publishes tentative forever on remote nodes.
    const eventTypes: string[] = ['KnowledgeBatchCreated', 'KCCreated'];
    if (watchContextGraphs) eventTypes.push('ParanetCreated');
    if (this.onCollectionUpdated) eventTypes.push('KnowledgeCollectionUpdated');
    if (this.onAllowListUpdated) eventTypes.push('AllowListUpdated');
    if (this.onProfileEvent) {
      eventTypes.push('ProfileCreated');
      eventTypes.push('ProfileUpdated');
    }

    const fromBlock = this.lastBlock + 1;
    const upperBound = head != null
      ? Math.min(fromBlock + ChainEventPoller.MAX_RANGE - 1, head)
      : fromBlock + ChainEventPoller.MAX_RANGE - 1;

    if (fromBlock > upperBound) return;

    const filter: EventFilter = {
      eventTypes,
      fromBlock,
      toBlock: upperBound,
    };

    let maxEventBlock = this.lastBlock;
    for await (const event of this.chain.listenForEvents(filter)) {
      if (event.blockNumber > maxEventBlock) maxEventBlock = event.blockNumber;
      if (event.type === 'KnowledgeBatchCreated' || event.type === 'KCCreated') {
        await this.handleBatchCreated(event, ctx);
      } else if (event.type === 'ParanetCreated') {
        await this.handleContextGraphCreated(event, ctx);
      } else if (event.type === 'KnowledgeCollectionUpdated') {
        await this.handleCollectionUpdated(event, ctx);
      } else if (event.type === 'AllowListUpdated') {
        await this.handleAllowListUpdated(event, ctx);
      } else if (event.type === 'ProfileCreated' || event.type === 'ProfileUpdated') {
        await this.handleProfileEvent(event, ctx);
      }
    }

    // Always advance cursor to upperBound. When head is known, upperBound
    // is capped to it. When head is unknown, upperBound is an estimate — but
    // the RPC successfully returned results (or empty) for this range, so
    // those blocks have been scanned and we must progress past them.
    this.lastBlock = upperBound;

    // Persist cursor for restart recovery (spec §5.1)
    if (this.cursorPersistence && this.lastBlock > 0) {
      try {
        await this.cursorPersistence.save(this.lastBlock);
      } catch {
        // Non-fatal — cursor will be re-seeded on restart
      }
    }
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
      `Chain event: KnowledgeBatchCreated block=${event.blockNumber} ` +
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
    const contextGraphId = String(data['paranetId'] ?? data['contextGraphId'] ?? '');
    const creator = String(data['creator'] ?? '');
    const accessPolicy = Number(data['accessPolicy'] ?? 0);

    this.log.info(ctx,
      `Chain event: ContextGraphCreated block=${event.blockNumber} id=${contextGraphId.slice(0, 16)}… creator=${creator.slice(0, 10)}…`,
    );

    try {
      await this.onContextGraphCreated({ contextGraphId, creator, accessPolicy, blockNumber: event.blockNumber });
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
      `Chain event: KnowledgeCollectionUpdated block=${event.blockNumber} batchId=${batchId}`,
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
}
