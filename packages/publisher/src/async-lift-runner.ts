import type { AsyncLiftPublisher } from './async-lift-publisher.js';

type TransactionReconciliationPublisher = AsyncLiftPublisher & {
  reconcileTransactions?: () => Promise<number>;
};

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
  private recoveryInFlight?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;

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
    this.scheduleTransactionReconciliation();
    this.running = Promise.all(
      this.config.walletIds.map((walletId) => this.walletLoop(walletId)),
    ).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    await this.running;
    await this.recoveryInFlight;
  }

  private async walletLoop(walletId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.config.publisher.processNext(walletId);
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

  private scheduleTransactionReconciliation(): void {
    if (this.stopped || this.recoveryTimer || this.recoveryInFlight) return;
    if (!this.transactionReconciler()) return;
    const now = Date.now();
    const nextAt = Math.max(
      this.lastRecoveryAt + this.recoveryIntervalMs,
      this.lastRecoveryAttemptAt + this.errorBackoffMs,
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.startTransactionReconciliation();
    }, Math.max(1, nextAt - now));
  }

  private startTransactionReconciliation(): void {
    if (this.stopped || this.recoveryInFlight) return;
    const reconcileTransactions = this.transactionReconciler();
    if (!reconcileTransactions) return;
    this.lastRecoveryAttemptAt = Date.now();
    const recovery = reconcileTransactions()
      .then(() => {
        this.lastRecoveryAt = Date.now();
      })
      .catch(async (error) => {
        try {
          await this.onError?.(error);
        } catch {
          // Error reporting must not stop transaction reconciliation.
        }
      })
      .finally(() => {
        if (this.recoveryInFlight === recovery) {
          this.recoveryInFlight = undefined;
        }
        this.scheduleTransactionReconciliation();
      });
    this.recoveryInFlight = recovery;
  }

  private transactionReconciler(): (() => Promise<number>) | undefined {
    const publisher = this.config.publisher as TransactionReconciliationPublisher;
    return publisher.reconcileTransactions?.bind(publisher);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
