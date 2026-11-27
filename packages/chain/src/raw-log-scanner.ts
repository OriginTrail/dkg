import { ethers, type JsonRpcProvider } from 'ethers';
import type { ReadOpts } from './rpc-failover-client.js';
import { readTip } from './rpc-tip-read.js';
import { RPC_LOG_SCAN_TIMEOUT_MS } from './evm-adapter-constants.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import { withRpcRequestTimeout } from './rpc-request-transport.js';

export type RawLogScanReadProvider = <T>(label: string,
  fn: (provider: JsonRpcProvider) => Promise<T>, opts?: ReadOpts) => Promise<T>;
export interface RawLogScanFilter { readonly address: string; readonly topics: readonly string[] }
export interface RawLogScanConfig {
  readonly readProvider: RawLogScanReadProvider;
  readonly reorgBufferBlocks: number;
  readonly label: string;
}
interface ScanOptions<T> { readonly isAborted?: () => boolean; readonly onLogs: (logs: readonly T[]) => void }
interface LogWindow<T> { readonly head: number; readonly logs: readonly T[] }
type RawLogWithIdentity = ethers.Log & { blockHash?: unknown; index?: unknown; logIndex?: unknown };

/** One owner for read, cancellation, dispatch and cursor commit. A callback failure
 * replays the whole batch, so consumers must be idempotent. A consumer can explicitly
 * quarantine a repeatedly failing record before returning to commit the batch. */
export class RawLogScanner {
  readonly #seenLogIds = new Map<string, number>();
  #lastScannedBlock: number | undefined;
  constructor(private readonly config: RawLogScanConfig) {
    if (!Number.isSafeInteger(config.reorgBufferBlocks) || config.reorgBufferBlocks < 0) {
      throw new TypeError('reorgBufferBlocks must be a non-negative safe integer');
    }
    if (config.label.length < 1 || config.label.length > 256) throw new TypeError('raw log scan label must be 1-256 characters');
  }

  async scan(filter: RawLogScanFilter, options: ScanOptions<ethers.Log>): Promise<void> {
    const previous = this.#lastScannedBlock;
    const head = await readTip(this.config.readProvider, `${this.config.label} getBlockNumber`,
      provider => provider.getBlockNumber(), { policy: 'watchdogPointRead' });
    if (options.isAborted?.()) return;
    const fromBlock = previous === undefined ? this.earliestBufferedBlock(head)
      : Math.min(this.earliestBufferedBlock(previous + 1), this.earliestBufferedBlock(head));
    // Preserve canary's adaptive range fitting and one deadline per physical RPC.
    const logs = await readTip(this.config.readProvider, `${this.config.label} getLogs`,
      provider => readAdaptiveEvmLogRange({ provider, fromBlock, toBlock: head,
        read: (from, to) => withRpcRequestTimeout(RPC_LOG_SCAN_TIMEOUT_MS,
          `${this.config.label} getLogs [${from}, ${to}]`, () => provider.getLogs({
            address: ethers.getAddress(filter.address), fromBlock: from, toBlock: to, topics: [[...filter.topics]],
          })),
      }), { policy: 'durablePagedLogScan' });
    this.dispatch({ head, logs }, rawLogIdentity, options);
  }

  async seed(isAborted: () => boolean): Promise<void> {
    const head = await readTip(this.config.readProvider, `${this.config.label} initial getBlockNumber`,
      provider => provider.getBlockNumber(), { policy: 'watchdogPointRead' });
    if (!isAborted()) this.commit(head, []);
  }

  /** Optional indexed history shares exactly the live scanner's cursor and dedupe.
   * The first covered window establishes a baseline without replaying history. */
  async scanStoredWindow<T extends { readonly blockNumber: number }>(
    source: (after: number | undefined, buffer: number) => Promise<LogWindow<T> | undefined>,
    identity: (log: T) => string, options: ScanOptions<T>,
  ): Promise<boolean> {
    const window = await source(this.#lastScannedBlock, this.config.reorgBufferBlocks);
    if (window === undefined) return false;
    if (options.isAborted?.()) return true;
    if (this.#lastScannedBlock === undefined) this.commit(window.head, []);
    else this.dispatch(window, identity, options);
    return true;
  }

  private dispatch<T extends { readonly blockNumber: number }>(window: LogWindow<T>,
    identity: (log: T) => string, options: ScanOptions<T>): void {
    if (options.isAborted?.()) return;
    const batch = new Map<string, T>();
    for (const log of window.logs) {
      const id = identity(log);
      if (!this.#seenLogIds.has(id) && !batch.has(id)) batch.set(id, log);
    }
    options.onLogs([...batch.values()]);
    if (!options.isAborted?.()) this.commit(window.head, [...batch].map(([id, log]) => [id, log.blockNumber]));
  }

  private commit(head: number, entries: readonly (readonly [string, number])[]): void {
    for (const [id, block] of entries) this.#seenLogIds.set(id, block);
    this.#lastScannedBlock = Math.max(this.#lastScannedBlock ?? head, head);
    const floor = this.earliestBufferedBlock(head);
    for (const [id, block] of this.#seenLogIds) if (block < floor) this.#seenLogIds.delete(id);
  }
  private earliestBufferedBlock(head: number): number { return Math.max(0, head - this.config.reorgBufferBlocks); }
}

export function canonicalLogIdentity(blockHash: string, index: number): string {
  return `${blockHash.toLowerCase()}:${index}`;
}

/** Stable identity for one chain log, with a deterministic legacy fallback. */
export function rawLogIdentity(log: ethers.Log): string {
  const maybe = log as RawLogWithIdentity;
  const blockHash = typeof maybe.blockHash === 'string' ? maybe.blockHash : undefined;
  const index = typeof maybe.index === 'number'
    ? maybe.index
    : typeof maybe.logIndex === 'number'
      ? maybe.logIndex
      : undefined;
  if (blockHash && index != null) {
    return canonicalLogIdentity(blockHash, index);
  }
  return [
    log.blockNumber,
    index ?? 'unknown',
    log.topics.join(','),
    log.data,
  ].join(':');
}
