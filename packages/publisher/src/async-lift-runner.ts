import type { AsyncLiftPublisher } from './async-lift-publisher.js';

export interface AsyncLiftRunnerConfig {
  readonly publisher: AsyncLiftPublisher;
  readonly walletIds: readonly string[];
  readonly pollIntervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly recoveryIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly hasIncludedRecoveryResolver?: boolean;
}

export class AsyncLiftRunner {
  private readonly pollIntervalMs: number;
  private readonly errorBackoffMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError?: (error: unknown) => void | Promise<void>;
  private started = false;
  private stopped = false;
  private running?: Promise<void>;
  private lastRecoveryAt = 0;
  private lastRecoveryAttemptAt = 0;

  constructor(private readonly config: AsyncLiftRunnerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.errorBackoffMs = config.errorBackoffMs ?? 1000;
    this.recoveryIntervalMs = config.recoveryIntervalMs ?? 60_000;
    this.sleep = config.sleep ?? defaultSleep;
    this.onError = config.onError;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('AsyncLiftRunner already started');
    }
    if (this.config.walletIds.length === 0) {
      throw new Error('AsyncLiftRunner requires at least one walletId');
    }

    this.stopped = false;
    try {
      await this.config.publisher.recover();
      this.lastRecoveryAt = Date.now();
      if (!this.config.hasIncludedRecoveryResolver) {
        const includedJobs = await this.config.publisher.list({ status: 'included' });
        if (includedJobs.length > 0) {
          throw new Error('AsyncLiftRunner requires included-job recovery support when included jobs remain after startup recovery');
        }
      }
    } catch (error) {
      this.started = false;
      throw error;
    }

    this.started = true;
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.maybeRunRecovery();
        const processed = await this.runCycle();
        if (!processed && !this.stopped) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        try {
          await this.onError?.(error);
        } catch {
          // Error reporting must not stop the runner loop.
        }
        if (!this.stopped) {
          await this.sleep(this.errorBackoffMs);
        }
      }
    }
  }

  private async maybeRunRecovery(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoveryAt < this.recoveryIntervalMs) return;
    // Throttle attempts at errorBackoffMs to avoid hammering during outages,
    // but allow the full interval between *successful* recoveries.
    if (now - this.lastRecoveryAttemptAt < this.errorBackoffMs) return;
    this.lastRecoveryAttemptAt = now;
    await this.config.publisher.recover();
    this.lastRecoveryAt = now;
  }

  private async runCycle(): Promise<boolean> {
    let processedAny = false;
    for (const walletId of this.config.walletIds) {
      if (this.stopped) {
        break;
      }
      const result = await this.config.publisher.processNext(walletId);
      if (result) {
        processedAny = true;
      }
    }
    return processedAny;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
