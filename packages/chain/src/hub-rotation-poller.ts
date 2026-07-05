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

export class HubRotationPoller {
  private readonly readProvider: HubRotationReadProvider;
  private readonly intervalMs: number;
  private readonly reorgBufferBlocks: number;
  private readonly onContractName: (name: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastScannedBlock: number | undefined;
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

    await this.seed(hub);
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.poll(hub, hubAddress)
        .catch(() => { /* optional listener path */ })
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

  async poll(hub: Contract, hubAddress: string): Promise<void> {
    const topics = this.eventTopics(hub);
    if (topics.length === 0) return;

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
        address: hubAddress,
        fromBlock,
        toBlock: head,
        topics: [topics],
      }),
      { policy: 'wideLogScan' },
    );

    for (const log of logs) {
      if (previousLastScannedBlock != null && log.blockNumber <= previousLastScannedBlock) continue;
      const contractName = this.contractNameFromLog(hub, log);
      if (contractName) this.onContractName(contractName);
    }
    this.lastScannedBlock = previousLastScannedBlock == null
      ? head
      : Math.max(previousLastScannedBlock, head);
  }

  private async seed(hub: Contract): Promise<void> {
    const topics = this.eventTopics(hub);
    if (topics.length === 0) return;
    this.lastScannedBlock = await this.readProvider(
      'Hub rotation seed getBlockNumber',
      (provider) => provider.getBlockNumber(),
    );
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
}
