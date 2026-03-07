import type { ChainAdapter, EventFilter, ChainEvent } from '@dkg/chain';
import { Logger, createOperationContext, type OperationContext } from '@dkg/core';
import type { PublishHandler } from './publish-handler.js';
import { ethers } from 'ethers';

/** Callback invoked when a ParanetCreated event is detected on-chain. */
export type OnParanetCreated = (info: {
  paranetId: string;
  creator: string;
  accessPolicy: number;
  blockNumber: number;
}) => Promise<void>;

export interface ChainEventPollerConfig {
  chain: ChainAdapter;
  publishHandler: PublishHandler;
  /** Polling interval in ms. Default: 12000 (roughly 1 L2 block). */
  intervalMs?: number;
  /** Called when a ParanetCreated event is detected on-chain. */
  onParanetCreated?: OnParanetCreated;
}

/**
 * Background poller that watches for on-chain events:
 * - KnowledgeBatchCreated: promotes tentative publishes to confirmed
 * - ParanetCreated: notifies the agent of new on-chain paranets
 *
 * The chain is the single source of truth for finalization and paranet
 * registration ordering.
 */
export class ChainEventPoller {
  private readonly chain: ChainAdapter;
  private readonly publishHandler: PublishHandler;
  private readonly intervalMs: number;
  private readonly onParanetCreated?: OnParanetCreated;
  private readonly log = new Logger('ChainEventPoller');
  private lastBlock = 0;
  private headKnown = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Max blocks to scan per poll — stays within typical RPC range limits. */
  private static readonly MAX_RANGE = 9_000;

  constructor(config: ChainEventPollerConfig) {
    this.chain = config.chain;
    this.publishHandler = config.publishHandler;
    this.intervalMs = config.intervalMs ?? 12_000;
    this.onParanetCreated = config.onParanetCreated;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Starting chain event poller (interval=${this.intervalMs}ms)`);

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        const pollCtx = createOperationContext('system');
        this.log.error(pollCtx, `Poll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.intervalMs);

    // Run first poll immediately
    this.poll().catch(() => {});
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
    const watchParanets = !!this.onParanetCreated;
    if (!hasPending && !watchParanets) return;

    const ctx = createOperationContext('publish');

    // Resolve the actual chain head so we can bound the scan precisely.
    // Without a known head we cannot safely advance the cursor.
    let head: number | undefined;
    if (this.chain.getBlockNumber) {
      try { head = await this.chain.getBlockNumber(); } catch { /* unavailable */ }
    }

    // On first successful head fetch, seed cursor near the tip — but only
    // when there are no pending publishes whose confirmations we might skip.
    // Full-history paranet discovery is handled by discoverParanetsFromChain().
    if (head != null && !this.headKnown) {
      this.headKnown = true;
      if (this.lastBlock === 0 && !hasPending) {
        this.lastBlock = Math.max(0, head - 500);
        this.log.info(ctx, `Seeded poller cursor near chain head: ${head} → scanning from ${this.lastBlock}`);
      }
    }

    const eventTypes = ['KnowledgeBatchCreated'];
    if (watchParanets) eventTypes.push('ParanetCreated');

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
      if (event.type === 'KnowledgeBatchCreated') {
        await this.handleBatchCreated(event, ctx);
      } else if (event.type === 'ParanetCreated') {
        await this.handleParanetCreated(event, ctx);
      }
    }

    // Always advance cursor to upperBound. When head is known, upperBound
    // is capped to it. When head is unknown, upperBound is an estimate — but
    // the RPC successfully returned results (or empty) for this range, so
    // those blocks have been scanned and we must progress past them.
    this.lastBlock = upperBound;
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

  private async handleParanetCreated(event: ChainEvent, ctx: OperationContext): Promise<void> {
    if (!this.onParanetCreated) return;
    const { data } = event;
    const paranetId = String(data['paranetId'] ?? '');
    const creator = String(data['creator'] ?? '');
    const accessPolicy = Number(data['accessPolicy'] ?? 0);

    this.log.info(ctx,
      `Chain event: ParanetCreated block=${event.blockNumber} id=${paranetId.slice(0, 16)}… creator=${creator.slice(0, 10)}…`,
    );

    try {
      await this.onParanetCreated({ paranetId, creator, accessPolicy, blockNumber: event.blockNumber });
    } catch (err) {
      this.log.warn(ctx, `onParanetCreated callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
