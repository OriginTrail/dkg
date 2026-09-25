import { LocalStorageACKTransport } from './local-storage-ack-transport.js';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';

export type RegisteredLocalACKWork = (
  endpoint: StorageACKEndpoint,
  signal: AbortSignal,
  trackPhysicalWork: (work: Promise<Uint8Array>) => void,
) => Promise<Uint8Array>;

export type StorageACKRegistrationOptions = {
  repairWallets?: boolean;
  allowChainReresolution?: boolean;
};

type RegistrationPhase = 'initial' | 'retry' | 'failover';
export interface StorageACKRegistrationLease {
  signerLost(): boolean;
}

export type RegistrationOutcome =
  | { readonly kind: 'registered'; readonly endpoint: StorageACKEndpoint; readonly lease: StorageACKRegistrationLease }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'disabled' };

export interface StorageACKRegistrationPlan {
  attempt: (options: StorageACKRegistrationOptions, phase: RegistrationPhase) => Promise<RegistrationOutcome>;
  retryDelayMs: number;
  isStarted: () => boolean;
  onRetryScheduled: () => void;
  onError: (phase: RegistrationPhase, error: unknown) => void;
}

type RegistrationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'registering'; readonly phase: RegistrationPhase }
  | { readonly kind: 'waiting-retry'; readonly timer: ReturnType<typeof setTimeout> }
  | { readonly kind: 'registered'; readonly endpoint: StorageACKEndpoint; readonly lease: StorageACKRegistrationLease }
  | { readonly kind: 'retired' };

class RetiredRegistrationSession extends Error {}

/** A generation owns the registration state, endpoint, and its local transport. */
export class StorageACKRegistrationSession {
  private state: RegistrationState = { kind: 'idle' };
  private plan: StorageACKRegistrationPlan | undefined;
  private readonly attempts = new Set<Promise<unknown>>();
  private readonly transport = new LocalStorageACKTransport();

  get endpoint(): StorageACKEndpoint | null {
    return this.state.kind === 'registered' ? this.state.endpoint : null;
  }
  isCurrent(): boolean { return this.state.kind !== 'retired'; }

  /** Fence both sides of each asynchronous registration step. */
  async runStep<T>(work: () => Promise<T>): Promise<T> {
    if (!this.isCurrent()) throw new RetiredRegistrationSession();
    const value = await work();
    if (!this.isCurrent()) throw new RetiredRegistrationSession();
    return value;
  }

  createLease(): StorageACKRegistrationLease {
    const lease: StorageACKRegistrationLease = {
      signerLost: () => this.signerLost(lease),
    };
    return lease;
  }

  private track<T>(attempt: Promise<T>): Promise<T> {
    this.attempts.add(attempt);
    void attempt.then(
      () => { this.attempts.delete(attempt); },
      () => { this.attempts.delete(attempt); },
    );
    return attempt;
  }

  /** Direct fixture installation; production installs the attempt result. */
  install(endpoint: StorageACKEndpoint, lease = this.createLease()): boolean {
    if (this.state.kind === 'retired' || this.state.kind === 'registered') {
      endpoint.dispose();
      return false;
    }
    if (this.state.kind === 'waiting-retry') clearTimeout(this.state.timer);
    this.state = { kind: 'registered', endpoint, lease };
    return true;
  }

  private scheduleRetry(options: StorageACKRegistrationOptions): void {
    const plan = this.plan;
    if (!plan || this.state.kind !== 'registering') return;
    const timer = setTimeout(() => {
      if (this.state.kind !== 'waiting-retry' || this.state.timer !== timer) return;
      this.state = { kind: 'idle' };
      if (!plan.isStarted()) return;
      void this.track(Promise.resolve().then(() => this.runAttempt(options, 'retry')));
    }, plan.retryDelayMs);
    timer.unref?.();
    this.state = { kind: 'waiting-retry', timer };
    plan.onRetryScheduled();
  }

  private async runAttempt(options: StorageACKRegistrationOptions, phase: RegistrationPhase): Promise<void> {
    const plan = this.plan;
    if (!plan || this.state.kind === 'retired' || this.state.kind === 'registered') return;
    this.state = { kind: 'registering', phase };
    try {
      const outcome = await plan.attempt(options, phase);
      if (outcome.kind === 'registered') {
        this.install(outcome.endpoint, outcome.lease);
      } else if (this.state.kind === 'registering' && this.state.phase === phase) {
        if (outcome.kind === 'retryable') {
          this.scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
        } else {
          this.state = { kind: 'idle' };
        }
      }
    } catch (error) {
      if (error instanceof RetiredRegistrationSession || this.state.kind !== 'registering' || this.state.phase !== phase) return;
      plan.onError(phase, error);
      this.scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
    }
  }

  start(plan: StorageACKRegistrationPlan): Promise<void> {
    if (this.plan) throw new Error('StorageACK registration session already started');
    if (!this.isCurrent()) throw new Error('StorageACK registration session retired');
    this.plan = plan;
    return this.track(this.runAttempt({}, 'initial'));
  }

  private signerLost(lease: StorageACKRegistrationLease): boolean {
    if (!this.plan || this.state.kind !== 'registered' || this.state.lease !== lease) return false;
    const endpoint = this.state.endpoint;
    this.state = { kind: 'registering', phase: 'failover' };
    endpoint.dispose();
    void this.track(Promise.resolve().then(() => this.runAttempt({ repairWallets: false }, 'failover')));
    return true;
  }

  stopRetry(): void {
    if (this.state.kind !== 'waiting-retry') return;
    clearTimeout(this.state.timer);
    this.state = { kind: 'idle' };
  }

  retire(): void {
    if (this.state.kind === 'retired') return;
    if (this.state.kind === 'waiting-retry') clearTimeout(this.state.timer);
    if (this.state.kind === 'registered') this.state.endpoint.dispose();
    this.state = { kind: 'retired' };
    this.transport.close();
  }

  sendLocal(
    timeoutMs: number,
    work: RegisteredLocalACKWork,
  ): Promise<Uint8Array> {
    if (this.state.kind === 'retired') throw new Error('Local StorageACK transport is closed for a retired agent lifetime');
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('Local StorageACK handler is not registered');
    return this.transport.send((signal, trackPhysicalWork) =>
      work(endpoint, signal, trackPhysicalWork), timeoutMs);
  }

  async drainAttempts(): Promise<void> { await Promise.allSettled(this.attempts); }
  async drainTransport(): Promise<void> { await this.transport.drain(); }
}

/** Runtime swaps and drains self-contained registration generations. */
export class StorageACKRegistrationRuntime {
  private currentSession: StorageACKRegistrationSession | null = null;
  private readonly retiredSessions = new Set<StorageACKRegistrationSession>();

  get endpoint(): StorageACKEndpoint | null { return this.currentSession?.endpoint ?? null; }
  get registered(): boolean { return this.endpoint !== null; }

  begin(): StorageACKRegistrationSession {
    if (this.currentSession) {
      this.currentSession.retire();
      this.retiredSessions.add(this.currentSession);
    }
    this.currentSession = new StorageACKRegistrationSession();
    return this.currentSession;
  }

  clearRetry(): void { this.currentSession?.stopRetry(); }

  /** A sender captures its generation so stale factories cannot use a replacement endpoint. */
  createLocalSender(): (timeoutMs: number, work: RegisteredLocalACKWork) => Promise<Uint8Array> {
    const session = this.currentSession;
    return (timeoutMs, work) => {
      if (!session || session !== this.currentSession || !session.isCurrent()) {
        throw new Error('Local StorageACK transport is closed for a retired agent lifetime');
      }
      return session.sendLocal(timeoutMs, work);
    };
  }

  /** Fence new work, join registration attempts, then join physical handler work. */
  async closeAndDrain(): Promise<void> {
    if (this.currentSession) {
      this.currentSession.retire();
      this.retiredSessions.add(this.currentSession);
      this.currentSession = null;
    }
    const sessions = [...this.retiredSessions];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(sessions.map((session) => session.drainAttempts())),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('StorageACK registration did not retire within 5000ms; teardown blocked')),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await Promise.all(sessions.map((session) => session.drainTransport()));
    this.retiredSessions.clear();
  }
}
