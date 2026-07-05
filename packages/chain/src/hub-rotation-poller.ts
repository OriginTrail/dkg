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
  onContractName: (name: unknown) => void;
}

export class HubRotationPoller {
  private readonly readProvider: HubRotationReadProvider;
  private readonly intervalMs: number;
  private readonly reorgBufferBlocks: number;
  private readonly onContractName: (name: unknown) => void;
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

  async start(hub: Contract): Promise<void> {
    if (this.started) return;

    await this.poll(hub);
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.poll(hub)
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

  async poll(hub: Contract): Promise<void> {
    const topics = this.eventTopics(hub);
    if (topics.length === 0) return;

    const head = await this.readProvider(
      'Hub rotation poll getBlockNumber',
      (provider) => provider.getBlockNumber(),
    );
    const candidateFromBlock = this.lastScannedBlock == null
      ? head - this.reorgBufferBlocks
      : this.lastScannedBlock + 1 - this.reorgBufferBlocks;
    const recentFromBlock = head - this.reorgBufferBlocks;
    const fromBlock = Math.max(0, Math.min(candidateFromBlock, recentFromBlock));
    const hubAddress = await this.contractAddress(hub);
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
      try {
        const parsed = hub.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        this.onContractName(parsed.args?.contractName ?? parsed.args?.[0]);
      } catch {
        // Ignore malformed/unexpected Hub logs. The topic filter should already
        // constrain these, but a parse miss must not wedge the poll cursor.
      }
    }
    this.lastScannedBlock = head;
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

  private async contractAddress(hub: Contract): Promise<string> {
    const target = (hub as unknown as { target?: unknown }).target;
    return typeof target === 'string' ? target : hub.getAddress();
  }
}
