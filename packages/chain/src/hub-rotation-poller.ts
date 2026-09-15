import { Contract, ethers } from 'ethers';
import {
  RawLogScanner,
  type RawLogScanReadProvider,
} from './raw-log-scanner.js';

export type HubRotationReadProvider = RawLogScanReadProvider;

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
  private readonly intervalMs: number;
  private readonly onContractName: (name: string) => void;
  private readonly scanner: RawLogScanner;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private binding: HubRotationBinding | undefined;
  private started = false;
  private generation = 0;

  constructor(config: HubRotationPollerConfig) {
    this.intervalMs = config.intervalMs;
    this.onContractName = config.onContractName;
    this.scanner = new RawLogScanner({
      label: 'Hub rotation poll',
      readProvider: config.readProvider,
      reorgBufferBlocks: config.reorgBufferBlocks,
    });
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

  async pollOnce(generation = this.generation): Promise<void> {
    const binding = this.binding;
    if (!this.started || !binding || binding.topics.length === 0 || generation !== this.generation) return;

    const batch = await this.scanner.read({
      address: binding.hubAddress,
      topics: binding.topics,
    });
    if (!this.started || generation !== this.generation) return;

    this.dispatchLogs(binding.hub, batch.logs);
    this.scanner.commit(batch);
  }

  private async recordInitialHead(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) return;
    const head = await this.scanner.readInitialHead();
    if (!this.started || generation !== this.generation) return;
    this.scanner.commitInitialHead(head);
  }

  private dispatchLogs(hub: Contract, logs: readonly ethers.Log[]): void {
    for (const log of logs) {
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
}
