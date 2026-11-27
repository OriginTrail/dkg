import type { ChainEventLogHubRotationWindow } from './chain-event-log-binding.js';
import { Contract, ethers } from 'ethers';
import {
  RawLogScanner, rawLogIdentity, canonicalLogIdentity,
  type RawLogScanReadProvider,
} from './raw-log-scanner.js';

export type HubRotationReadProvider = RawLogScanReadProvider;

export type HubRotationLogSource = (last: number | undefined, buffer: number) => Promise<ChainEventLogHubRotationWindow | undefined>;

export interface HubRotationPollerConfig {
  readProvider: HubRotationReadProvider;
  intervalMs: number;
  reorgBufferBlocks: number;
  /**
   * MUST be idempotent: the scan commits per batch, so a throw anywhere in a
   * batch re-delivers that whole batch on the next poll (see `RawLogScanner`'s
   * at-least-once contract). After three failures a record is quarantined with
   * a warning to preserve progress. `applyHubRotationEventName` is idempotent.
   */
  onContractName: (name: string) => void;
  logSource?: HubRotationLogSource;
  onDispatchFailure?: (name: string, error: unknown) => void;
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
  private readonly failures = new Map<string, number>();
  private readonly logSource: HubRotationLogSource | undefined;
  private readonly onDispatchFailure: (name: string, error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private binding: HubRotationBinding | undefined;
  private started = false;
  private generation = 0;

  constructor(config: HubRotationPollerConfig) {
    this.intervalMs = config.intervalMs;
    this.logSource = config.logSource;
    this.onDispatchFailure = config.onDispatchFailure ?? ((name, error) => console.warn(
      `Hub rotation callback failed three times for ${name}; quarantining this log so later rotations continue`, error));
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

    if (this.logSource !== undefined && await this.pollOnceFromLog(generation)) return;
    await this.scanner.scan({ address: binding.hubAddress, topics: binding.topics }, {
      isAborted: () => !this.started || generation !== this.generation,
      onLogs: logs => {
        for (const log of logs) {
          const name = this.contractNameFromLog(binding.hub, log);
          if (name) this.dispatchName(rawLogIdentity(log), name);
        }
      },
    });
  }

  private async recordInitialHead(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) return;
    if (this.logSource !== undefined && await this.pollOnceFromLog(generation)) return;
    await this.scanner.seed(() => !this.started || generation !== this.generation);
  }

  private async pollOnceFromLog(generation: number): Promise<boolean> {
    const source = this.logSource;
    if (!source) return false;
    return this.scanner.scanStoredWindow(async (after, buffer) => {
      try {
        const window = await source(after, buffer);
        return window && { head: window.throughBlockNumber, logs: window.rotations };
      } catch { return undefined; } // A cold/broken optional index falls back to live RPC.
    }, log => canonicalLogIdentity(log.blockHash, log.logIndex), {
      isAborted: () => !this.started || generation !== this.generation,
      onLogs: logs => { for (const log of logs) this.dispatchName(canonicalLogIdentity(log.blockHash, log.logIndex), log.contractName); },
    });
  }

  private dispatchName(identity: string, name: string): void {
    try { this.onContractName(name); this.failures.delete(identity); }
    catch (error) {
      const attempts = (this.failures.get(identity) ?? 0) + 1;
      if (attempts < 3) { this.failures.set(identity, attempts); throw error; }
      this.failures.delete(identity);
      this.onDispatchFailure(name, error);
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
      'ContractRemoved',
      'AssetStorageChanged',
      'NewAssetStorage',
      'AssetStorageRemoved',
    ].map((eventName) => {
      const event = hub.interface.getEvent(eventName);
      if (!event?.topicHash) {
        throw new Error(`Hub ABI is missing required rotation event ${eventName}`);
      }
      return event.topicHash;
    });
  }

}
