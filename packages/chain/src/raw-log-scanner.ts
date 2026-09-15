import { ethers, type JsonRpcProvider } from 'ethers';

import type { ReadOpts } from './rpc-failover-client.js';

export type RawLogScanReadProvider = <T>(
  label: string,
  fn: (provider: JsonRpcProvider) => Promise<T>,
  opts?: ReadOpts,
) => Promise<T>;

export interface RawLogScanFilter {
  readonly address: string;
  readonly topics: readonly string[];
}

export interface RawLogScanConfig {
  readonly readProvider: RawLogScanReadProvider;
  readonly reorgBufferBlocks: number;
  readonly label: string;
}

export interface RawLogScanBatch {
  readonly head: number;
  readonly logs: readonly ethers.Log[];
}

type RawLogWithIdentity = ethers.Log & {
  blockHash?: unknown;
  transactionHash?: unknown;
  index?: unknown;
  logIndex?: unknown;
};

/**
 * Stateful, transactionally committed raw `eth_getLogs` scan mechanics.
 *
 * Callers read a batch and commit it only after their domain-specific dispatch
 * succeeds. This keeps cursor and dedupe state from advancing when a poll is
 * stopped or its domain callback fails between the RPC read and dispatch.
 */
export class RawLogScanner {
  readonly #readProvider: RawLogScanReadProvider;
  readonly #reorgBufferBlocks: number;
  readonly #label: string;
  readonly #seenLogIds = new Map<string, number>();
  #lastScannedBlock: number | undefined;

  constructor(config: RawLogScanConfig) {
    if (!Number.isSafeInteger(config.reorgBufferBlocks) || config.reorgBufferBlocks < 0) {
      throw new TypeError('reorgBufferBlocks must be a non-negative safe integer');
    }
    if (config.label.length < 1 || config.label.length > 256) {
      throw new TypeError('raw log scan label must be 1-256 characters');
    }
    this.#readProvider = config.readProvider;
    this.#reorgBufferBlocks = config.reorgBufferBlocks;
    this.#label = config.label;
  }

  async read(filter: RawLogScanFilter): Promise<RawLogScanBatch> {
    const previousLastScannedBlock = this.#lastScannedBlock;
    const head = await this.readTip(
      `${this.#label} getBlockNumber`,
      (provider) => provider.getBlockNumber(),
      { policy: 'watchdogPointRead' },
    );
    const fromBlock = this.scanFromBlock(previousLastScannedBlock, head);
    const logs = await this.readTip<ethers.Log[]>(
      `${this.#label} getLogs`,
      (provider) => provider.getLogs({
        address: ethers.getAddress(filter.address),
        fromBlock,
        toBlock: head,
        topics: [[...filter.topics]],
      }),
      { policy: 'watchdogWideLogScan' },
    );

    const batchSeen = new Set<string>();
    const unseen = logs.filter((log) => {
      const identity = rawLogIdentity(log);
      if (this.#seenLogIds.has(identity) || batchSeen.has(identity)) return false;
      batchSeen.add(identity);
      return true;
    });
    return Object.freeze({ head, logs: Object.freeze(unseen) });
  }

  async readInitialHead(): Promise<number> {
    return this.readTip(
      `${this.#label} initial getBlockNumber`,
      (provider) => provider.getBlockNumber(),
      { policy: 'watchdogPointRead' },
    );
  }

  commit(batch: RawLogScanBatch): void {
    for (const log of batch.logs) {
      this.#seenLogIds.set(rawLogIdentity(log), log.blockNumber);
    }
    this.#lastScannedBlock = this.#lastScannedBlock == null
      ? batch.head
      : Math.max(this.#lastScannedBlock, batch.head);
    this.pruneSeenLogs(batch.head);
  }

  commitInitialHead(head: number): void {
    this.#lastScannedBlock = this.#lastScannedBlock == null
      ? head
      : Math.max(this.#lastScannedBlock, head);
  }

  private readTip<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    return this.#readProvider(label, fn, { ...opts, skipPreferred: true });
  }

  private scanFromBlock(previousLastScannedBlock: number | undefined, head: number): number {
    if (previousLastScannedBlock == null) {
      return Math.max(0, head - this.#reorgBufferBlocks);
    }
    const candidateFromBlock = previousLastScannedBlock + 1 - this.#reorgBufferBlocks;
    const recentFromBlock = head - this.#reorgBufferBlocks;
    return Math.max(0, Math.min(candidateFromBlock, recentFromBlock));
  }

  private pruneSeenLogs(head: number): void {
    const earliestBufferedBlock = Math.max(0, head - this.#reorgBufferBlocks);
    for (const [identity, blockNumber] of this.#seenLogIds) {
      if (blockNumber < earliestBufferedBlock) this.#seenLogIds.delete(identity);
    }
  }
}

/** Stable identity for one chain log, with a deterministic legacy fallback. */
export function rawLogIdentity(log: ethers.Log): string {
  const maybe = log as RawLogWithIdentity;
  const blockHash = typeof maybe.blockHash === 'string' ? maybe.blockHash : undefined;
  const transactionHash = typeof maybe.transactionHash === 'string'
    ? maybe.transactionHash
    : undefined;
  const index = typeof maybe.index === 'number'
    ? maybe.index
    : typeof maybe.logIndex === 'number'
      ? maybe.logIndex
      : undefined;
  if (blockHash && transactionHash && index != null) {
    return `${blockHash}:${transactionHash}:${index}`;
  }
  return [
    log.blockNumber,
    index ?? 'unknown',
    log.topics.join(','),
    log.data,
  ].join(':');
}
