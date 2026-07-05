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

  constructor(config: HubRotationPollerConfig) {
    this.readProvider = config.readProvider;
    this.intervalMs = config.intervalMs;
    this.reorgBufferBlocks = config.reorgBufferBlocks;
    this.onContractName = config.onContractName;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(hub: Contract, hubAddress: string): Promise<void> {
    if (this.started) return;

    this.bind(hub, hubAddress);
    await this.seed();
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.pollOnce()
        .catch(() => { /* optional poller path */ })
        .finally(() => { this.inFlight = null; });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.started = true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  private bind(hub: Contract, hubAddress: string): void {
    this.binding = {
      hub,
      hubAddress: ethers.getAddress(hubAddress),
      topics: this.eventTopics(hub),
    };
  }

  async pollOnce(): Promise<void> {
    const binding = this.binding;
    if (!binding || binding.topics.length === 0) return;

    const previousLastScannedBlock = this.lastScannedBlock;
    const head = await this.readProvider(
      'Hub rotation poll getBlockNumber',
      (provider) => provider.getBlockNumber(),
    );
    const candidateFromBlock = previousLastScannedBlock == null
      ? head - this.reorgBufferBlocks
      : previousLastScannedBlock + 1 - this.reorgBufferBlocks;
    const recentFromBlock = head - this.reorgBufferBlocks;
    const fromBlock = Math.max(0, Math.min(candidateFromBlock, recentFromBlock));
    const logs = await this.readProvider<ethers.Log[]>(
      'Hub rotation poll getLogs',
      (provider) => provider.getLogs({
        address: binding.hubAddress,
        fromBlock,
        toBlock: head,
        topics: [binding.topics],
      }),
      { policy: 'wideLogScan' },
    );

    for (const log of logs) {
      const identity = this.logIdentity(log);
      if (this.seenLogIds.has(identity)) continue;
      this.rememberLog(identity, log);
      const contractName = this.contractNameFromLog(binding.hub, log);
      if (contractName) this.onContractName(contractName);
    }
    this.lastScannedBlock = previousLastScannedBlock == null
      ? head
      : Math.max(previousLastScannedBlock, head);
    this.pruneSeenLogs(head);
  }

  private async seed(): Promise<void> {
    const binding = this.binding;
    if (!binding || binding.topics.length === 0) return;
    const head = await this.readProvider(
      'Hub rotation seed getBlockNumber',
      (provider) => provider.getBlockNumber(),
    );
    const fromBlock = Math.max(0, head - this.reorgBufferBlocks);
    const logs = await this.readProvider<ethers.Log[]>(
      'Hub rotation seed getLogs',
      (provider) => provider.getLogs({
        address: binding.hubAddress,
        fromBlock,
        toBlock: head,
        topics: [binding.topics],
      }),
      { policy: 'wideLogScan' },
    );
    for (const log of logs) this.rememberLog(this.logIdentity(log), log);
    this.lastScannedBlock = head;
    this.pruneSeenLogs(head);
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
    ].flatMap((eventName) => {
      const event = hub.interface.getEvent(eventName);
      return event?.topicHash ? [event.topicHash] : [];
    });
  }

  private logIdentity(log: ethers.Log): string {
    const maybe = log as ethers.Log & {
      blockHash?: unknown;
      transactionHash?: unknown;
      index?: unknown;
      logIndex?: unknown;
    };
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
