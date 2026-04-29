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
  /**
   * post-restart WAL
   * reconciler. Called when an on-chain `KnowledgeBatchCreated`
   * arrives whose `merkleRoot` does NOT match any in-memory pending
   * publish (the common case after a process crash that wiped
   * `pendingPublishes` but persisted the WAL). Implementations
   * should look the merkle root up in the recovered
   * `preBroadcastJournal`, drop the matching entry from both memory
   * and the WAL file, and emit any reconciliation telemetry.
   * Returning `true` means the recovery path matched — useful for
   * tests / observability — and `false` means no surviving WAL
   * record matched (which is benign: the on-chain event was simply
   * not produced by this node).
   */
  onUnmatchedBatchCreated?: (info: {
    merkleRoot: Uint8Array;
    publisherAddress: string;
    startKAId: bigint;
    endKAId: bigint;
    blockNumber: number;
  }) => Promise<boolean | void>;
  /**
   * — chain-event-poller.ts:271).
   * Optional accessor for "is there actually any recoverable WAL
   * right now?". Pre-fix, the poller treated `onUnmatchedBatchCreated`
   * being installed as a proxy for "WAL recovery is needed" — but
   * `DKGAgent` ALWAYS wires the callback, so a brand-new node with
   * an empty journal would scan from genesis on first boot
   * (`lastBlock === 0` + the seed-near-tip suppression). On long-lived
   * chains this is a multi-hour startup penalty for zero benefit.
   *
   * When this accessor is provided AND returns `false`, the poller
   * treats WAL recovery as inactive — which restores the seed-near-
   * tip behaviour for fresh nodes. When it's omitted or returns
   * `true`, the legacy behaviour kicks in (refuse to seed, scan
   * from `lastBlock` so any WAL entries can drain). The accessor is
   * called fresh on every poll tick so a WAL entry written AFTER
   * boot still flips the gate immediately on the next tick.
   */
  hasRecoverableWal?: () => boolean;
}

/**
 * Background poller that watches for on-chain events (spec §5.1):
 * - KnowledgeBatchCreated / KCCreated: promotes tentative publishes to confirmed
 * - NameClaimed / ContextGraphCreated: notifies the agent of new CGs
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
  private readonly onUnmatchedBatchCreated?: ChainEventPollerConfig['onUnmatchedBatchCreated'];
  private readonly hasRecoverableWal?: ChainEventPollerConfig['hasRecoverableWal'];
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
    this.onUnmatchedBatchCreated = config.onUnmatchedBatchCreated;
    this.hasRecoverableWal = config.hasRecoverableWal;
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
   *     failure and the next tick retries.
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
    // The unmatched-batch reconciler (`onUnmatchedBatchCreated`) is
    // the durable path that drains the WAL after a restart, but the
    // callback being installed is NOT the right gate — `DKGAgent`
    // wires it unconditionally for every node, so testing
    // `!!this.onUnmatchedBatchCreated` would force every brand-new
    // node with an empty journal to scan from genesis
    // (and refuse to seed near tip — see the `headKnown` block below).
    //
    // The honest gate is "is there actually any recoverable WAL right
    // now?". When `hasRecoverableWal` is provided we use its return
    // value; when omitted (legacy callers without the accessor) we
    // fall back to the "callback installed" check so existing tests
    // continue to exercise the WAL-recovery code path.
    const walRecoveryActive =
      !!this.onUnmatchedBatchCreated &&
      (this.hasRecoverableWal ? this.hasRecoverableWal() : true);
    // The previous gate
    // tested `!!this.onUnmatchedBatchCreated`, but `DKGAgent` now wires
    // that callback unconditionally for every node, so the flag was
    // effectively `true` everywhere and the early-return at the bottom
    // of this block never fired. Fresh nodes with an empty WAL therefore
    // continued to poll `KnowledgeBatchCreated` / `KCCreated` every
    // tick, which is exactly the idle RPC churn the `hasRecoverableWal`
    // gate was added to avoid (a future publish or WAL append flips
    // `walRecoveryActive` true on the very next tick anyway, because
    // both paths schedule a re-poll, so we lose nothing by skipping the
    // current tick when the WAL is empty).
    //
    // We keep the looser `!!this.onUnmatchedBatchCreated` test for
    // exactly one purpose: legacy callers that don't yet implement
    // `hasRecoverableWal` ⇒ `walRecoveryActive` falls through to the
    // permissive `true` branch above, which preserves their existing
    // behaviour. Modern callers (the production `DKGAgent`) DO supply
    // `hasRecoverableWal`, so they get the stricter, idle-friendly gate
    // without a code change at the call site.
    if (
      !hasPending
      && !watchContextGraphs
      && !watchUpdates
      && !watchAllowList
      && !watchProfiles
      && !walRecoveryActive
    ) return;

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
    //
    // WAL recovery is ALSO a reason
    // not to seed near the tip: on restart the in-memory pending map is
    // empty by construction, but the unmatched-batch reconciler
    // (`onUnmatchedBatchCreated`, installed by the agent for WAL drain)
    // is what actually resurrects pre-crash publishes from the
    // write-ahead log. If the surviving WAL entry is older than 500
    // blocks the near-tip seed would silently skip its on-chain
    // confirmation event forever, and the WAL would never drain.
    //
    // When the callback is present we therefore refuse to seed —
    // `lastBlock = 0` means "scan from genesis" (bounded per-poll by
    // `MAX_RANGE = 9000`, so even a long-running testnet drains in
    // finite ticks). An operator whose cursor persistence layer
    // already has a valid checkpoint still benefits: `this.lastBlock`
    // is populated from persistence BEFORE the first `poll()` call in
    // `start()`, so the `this.lastBlock === 0` gate below does NOT
    // fire and no scanning is wasted.
    if (head != null && !this.headKnown) {
      this.headKnown = true;
      if (this.lastBlock === 0 && !hasPending && !walRecoveryActive) {
        this.lastBlock = Math.max(0, head - 500);
        this.log.info(ctx, `Seeded poller cursor near chain head: ${head} → scanning from ${this.lastBlock}`);
      } else if (this.lastBlock === 0 && walRecoveryActive) {
        this.log.info(
          ctx,
          `WAL recovery active — NOT seeding poller cursor near head; ` +
            `scanning from genesis to drain any pre-crash WAL entries ` +
            `(head=${head}, r25-1 / r30-4)`,
        );
      }
    }

    // Always listen for both V9 and V10 events: even when V10 is deployed,
    // the publisher still falls back to V9 for private publishes and ACK
    // collection failures. Stopping legacy event polling would leave those
    // publishes tentative forever on remote nodes.
    const eventTypes: string[] = ['KnowledgeBatchCreated', 'KCCreated'];
    if (watchContextGraphs) eventTypes.push('NameClaimed');
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
      } else if (event.type === 'NameClaimed' || event.type === 'ParanetCreated') {
        // Accept 'ParanetCreated' for backward compat with adapters that have not renamed the event.
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
      return;
    }

    // in-memory pending map didn't match. After a process
    // restart the map is empty by construction, so the only durable
    // record of "we signed and were about to broadcast this batch"
    // is the WAL. Hand the event off to the unmatched-batch reconciler
    // (DKGAgent wires this to `DKGPublisher.recoverFromWalByMerkleRoot`),
    // which drops the surviving WAL entry once the on-chain confirmation
    // proves the broadcast actually landed. We swallow handler errors so
    // a buggy reconciler can't take down the whole poller — every
    // chain event after the throw would be skipped, which would mask
    // genuine `KCCreated` confirmations and resurrect the original
    // "WAL accumulates forever" bug from a different angle.
    if (this.onUnmatchedBatchCreated) {
      try {
        await this.onUnmatchedBatchCreated({
          merkleRoot,
          publisherAddress,
          startKAId,
          endKAId,
          blockNumber: event.blockNumber,
        });
      } catch (recoverErr) {
        this.log.warn(
          ctx,
          `onUnmatchedBatchCreated callback failed for merkleRoot=${ethers.hexlify(merkleRoot)}: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`,
        );
      }
    }
  }

  private async handleContextGraphCreated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onContextGraphCreated) return;
    const { data } = event;
    const contextGraphId = String(data['contextGraphId'] ?? data['paranetId'] ?? '');
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
