import { Contract, ethers, type JsonRpcProvider } from 'ethers';
import type { ReadOpts } from './rpc-failover-client.js';

export type HubRotationReadProvider = <T>(
  label: string,
  fn: (provider: JsonRpcProvider) => Promise<T>,
  opts?: ReadOpts,
) => Promise<T>;

export interface HubRotationPollerConfig {
  readProvider: HubRotationReadProvider;
  intervalMs: number;
  reorgBufferBlocks: number;
  onContractName: (name: string) => void;
}

interface HubRotationBinding {
  hub: Contract;
  hubAddress: string;
  topics: string[];
}

type HubRotationLogWithIdentity = ethers.Log & {
  blockHash?: unknown;
  transactionHash?: unknown;
  index?: unknown;
  logIndex?: unknown;
};

export class HubRotationPoller {
  private readonly readProvider: HubRotationReadProvider;
  private readonly intervalMs: number;
  private readonly reorgBufferBlocks: number;
  private readonly onContractName: (name: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastScannedBlock: number | undefined;
  private binding: HubRotationBinding | undefined;
  private readonly seenLogIds = new Map<string, number>();
  private started = false;
  private generation = 0;

  constructor(config: HubRotationPollerConfig) {
    this.readProvider = config.readProvider;
    this.intervalMs = config.intervalMs;
    this.reorgBufferBlocks = config.reorgBufferBlocks;
    this.onContractName = config.onContractName;
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(hub: Contract, hubAddress: string): void {
    if (this.started) return;

    this.bind(hub, hubAddress);
    const generation = ++this.generation;
    this.started = true;

    this.timer = setInterval(() => {
      this.runExclusive(() => this.pollOnce(generation));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    // Best-effort baseline: keep startup non-blocking while preventing the
    // first scheduled poll from replaying historical rotation logs.
    this.runExclusive(() => this.recordInitialHead(generation));
  }

  stop(): void {
    this.generation++;
    this.inFlight = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  private runExclusive(work: () => Promise<void>): void {
    if (this.inFlight) return;
    const pollPromise = work()
      .catch(() => { /* optional poller path */ })
      .finally(() => {
        if (this.inFlight === pollPromise) this.inFlight = null;
      });
    this.inFlight = pollPromise;
  }

  private bind(hub: Contract, hubAddress: string): void {
    this.binding = {
      hub,
      hubAddress: ethers.getAddress(hubAddress),
      topics: this.eventTopics(hub),
    };
  }

  /**
   * Every poller read is a background TIP probe at the ~stickiness-TTL cadence:
   * preference-TRANSPARENT so a poll tick never re-probes/clears the preferred
   * backend the read/write paths rely on, and so head/logs stay canonical-fresh
   * (not a lagging sticky backend's lower tip). Owns the transport-internal
   * `skipPreferred` opt-out ONCE so the call sites below read by INTENT (tip
   * probe), not by the double-negative flag. Mirrors the adapter's `readTipProvider`.
   */
  private readTip<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    return this.readProvider(label, fn, { ...opts, skipPreferred: true });
  }

  async pollOnce(generation = this.generation): Promise<void> {
    const binding = this.binding;
    if (!this.started || !binding || binding.topics.length === 0 || generation !== this.generation) return;

    const previousLastScannedBlock = this.lastScannedBlock;
    const head = await this.readTip(
      'Hub rotation poll getBlockNumber',
      (provider) => provider.getBlockNumber(),
      { policy: 'watchdogPointRead' },
    );
    if (!this.started || generation !== this.generation) return;
    const fromBlock = this.scanFromBlock(previousLastScannedBlock, head);
    const logs = await this.readTip<ethers.Log[]>(
      'Hub rotation poll getLogs',
      (provider) => provider.getLogs({
        address: binding.hubAddress,
        fromBlock,
        toBlock: head,
        topics: [binding.topics],
      }),
      { policy: 'watchdogWideLogScan' },
    );
    if (!this.started || generation !== this.generation) return;

    this.dispatchLogs(binding.hub, logs);
    this.lastScannedBlock = previousLastScannedBlock == null
      ? head
      : Math.max(previousLastScannedBlock, head);
    this.pruneSeenLogs(head);
  }

  private async recordInitialHead(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) return;
    const head = await this.readTip(
      'Hub rotation poll initial getBlockNumber',
      (provider) => provider.getBlockNumber(),
      { policy: 'watchdogPointRead' },
    );
    if (!this.started || generation !== this.generation) return;
    this.lastScannedBlock = this.lastScannedBlock == null
      ? head
      : Math.max(this.lastScannedBlock, head);
  }

  private scanFromBlock(previousLastScannedBlock: number | undefined, head: number): number {
    if (previousLastScannedBlock == null) {
      return Math.max(0, head - this.reorgBufferBlocks);
    }
    const candidateFromBlock = previousLastScannedBlock + 1 - this.reorgBufferBlocks;
    const recentFromBlock = head - this.reorgBufferBlocks;
    return Math.max(0, Math.min(candidateFromBlock, recentFromBlock));
  }

  private dispatchLogs(hub: Contract, logs: ethers.Log[]): void {
    for (const log of logs) {
      const identity = this.logIdentity(log);
      if (this.seenLogIds.has(identity)) continue;
      this.rememberLog(identity, log);
      const contractName = this.contractNameFromLog(hub, log);
      if (contractName) this.onContractName(contractName);
    }
  }

  private contractNameFromLog(hub: Contract, log: ethers.Log): string | undefined {
    try {
      const parsed = hub.interface.parseLog({ topics: [...log.topics], data: log.data });
      const contractName = parsed?.args?.contractName ?? parsed?.args?.[0];
      return typeof contractName === 'string' ? contractName : undefined;
    } catch {
      // Ignore malformed/unexpected Hub logs. The topic filter should already
      // constrain these, but a parse miss must not wedge the poll cursor.
      return undefined;
    }
  }

  private eventTopics(hub: Contract): string[] {
    return [
      'ContractChanged',
      'NewContract',
      'AssetStorageChanged',
      'NewAssetStorage',
    ].map((eventName) => {
      const event = hub.interface.getEvent(eventName);
      if (!event?.topicHash) {
        throw new Error(`Hub ABI is missing required rotation event ${eventName}`);
      }
      return event.topicHash;
    });
  }

  private logIdentity(log: ethers.Log): string {
    const maybe = log as HubRotationLogWithIdentity;
    const blockHash = typeof maybe.blockHash === 'string' ? maybe.blockHash : undefined;
    const transactionHash = typeof maybe.transactionHash === 'string' ? maybe.transactionHash : undefined;
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

  private rememberLog(identity: string, log: ethers.Log): void {
    this.seenLogIds.set(identity, log.blockNumber);
  }

  private pruneSeenLogs(head: number): void {
    const earliestBufferedBlock = Math.max(0, head - this.reorgBufferBlocks);
    for (const [identity, blockNumber] of this.seenLogIds) {
      if (blockNumber < earliestBufferedBlock) this.seenLogIds.delete(identity);
    }
  }
}
