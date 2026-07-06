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

type HubRotationScanMode = 'probe' | 'dispatch';

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
  private startInFlight: Promise<void> | null = null;
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

  async start(hub: Contract, hubAddress: string): Promise<void> {
    if (this.started) return;
    if (this.startInFlight) return this.startInFlight;

    this.bind(hub, hubAddress);
    const generation = ++this.generation;
    this.started = true;
    const startPromise = this.seed(generation)
      .catch(() => { /* optional bootstrap path */ })
      .finally(() => {
        if (this.startInFlight === startPromise) this.startInFlight = null;
        if (this.inFlight === startPromise) this.inFlight = null;
      });
    this.startInFlight = startPromise;
    this.inFlight = startPromise;

    this.timer = setInterval(() => {
      if (this.inFlight) return;
      const pollPromise = this.pollOnce(generation)
        .catch(() => { /* optional poller path */ })
        .finally(() => {
          if (this.inFlight === pollPromise) this.inFlight = null;
        });
      this.inFlight = pollPromise;
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    this.generation++;
    this.startInFlight = null;
    this.inFlight = null;
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

  async pollOnce(generation = this.generation): Promise<void> {
    await this.scan(generation, 'dispatch');
  }

  private async seed(generation: number): Promise<void> {
    await this.scan(generation, 'probe');
  }

  private async scan(generation: number, mode: HubRotationScanMode): Promise<void> {
    const binding = this.binding;
    if (!binding || binding.topics.length === 0 || generation !== this.generation) return;

    const label = mode === 'probe' ? 'Hub rotation seed' : 'Hub rotation poll';
    const previousLastScannedBlock = this.lastScannedBlock;
    const head = await this.readProvider(
      `${label} getBlockNumber`,
      (provider) => provider.getBlockNumber(),
    );
    if (generation !== this.generation) return;
    const fromBlock = this.scanFromBlock(mode, previousLastScannedBlock, head);
    const logs = await this.readProvider<ethers.Log[]>(
      `${label} getLogs`,
      (provider) => provider.getLogs({
        address: binding.hubAddress,
        fromBlock,
        toBlock: head,
        topics: [binding.topics],
      }),
      { policy: 'wideLogScan' },
    );
    if (generation !== this.generation) return;

    // Probe mode intentionally does not mark logs as seen; the first buffered
    // dispatch must still process rotations that landed during adapter init.
    if (mode === 'dispatch') this.dispatchLogs(binding.hub, logs);
    this.lastScannedBlock = previousLastScannedBlock == null
      ? head
      : Math.max(previousLastScannedBlock, head);
    this.pruneSeenLogs(head);
  }

  private scanFromBlock(
    mode: HubRotationScanMode,
    previousLastScannedBlock: number | undefined,
    head: number,
  ): number {
    if (mode === 'probe' || previousLastScannedBlock == null) {
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
