import { LocalStorageACKTransport } from './local-storage-ack-transport.js';
import type { LocalStorageACKExecution, StorageACKEndpoint } from './storage-ack-endpoint.js';

export type RegisteredLocalACKWork = (
  endpoint: StorageACKEndpoint,
  signal: AbortSignal,
) => LocalStorageACKExecution;

export type StorageACKRegistrationAttempt =
  | { readonly kind: 'initial' }
  | { readonly kind: 'retry-initial' }
  | { readonly kind: 'failover' }
  | { readonly kind: 'retry-failover' };

export function mayReresolveACKIdentity(attempt: StorageACKRegistrationAttempt): boolean {
  return attempt.kind === 'retry-initial';
}

export function shouldRepairACKWallets(attempt: StorageACKRegistrationAttempt): boolean {
  return attempt.kind === 'initial' || attempt.kind === 'retry-initial';
}

type RegistrationPhase = 'initial' | 'retry' | 'failover';
function phaseOf(attempt: StorageACKRegistrationAttempt): RegistrationPhase {
  return attempt.kind === 'initial' ? 'initial' : attempt.kind === 'failover' ? 'failover' : 'retry';
}

function retryAfter(attempt: StorageACKRegistrationAttempt): StorageACKRegistrationAttempt {
  return attempt.kind === 'initial' || attempt.kind === 'retry-initial'
    ? { kind: 'retry-initial' }
    : { kind: 'retry-failover' };
}
interface StorageACKRegistrationLease {
  signerLost(): boolean;
}

/** An attempt can guard awaited dependencies and report loss of its own signer. */
export interface StorageACKRegistrationAttemptContext {
  isActive(): boolean;
  guard<T>(work: () => Promise<T>): Promise<T>;
  signerLost(): boolean;
}

export type RegistrationOutcome =
  | { readonly kind: 'registered'; readonly endpoint: StorageACKEndpoint }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'disabled' };

export interface StorageACKRegistrationPlan {
  attempt: (
    attempt: StorageACKRegistrationAttempt,
    context: StorageACKRegistrationAttemptContext,
  ) => Promise<RegistrationOutcome>;
  retryDelayMs: number;
  isStarted: () => boolean;
  onRetryScheduled: () => void;
  onError: (phase: RegistrationPhase, error: unknown) => void;
}

type RegistrationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'registering'; readonly attempt: StorageACKRegistrationAttempt }
  | { readonly kind: 'waiting-retry'; readonly timer: ReturnType<typeof setTimeout> }
  | { readonly kind: 'registered'; readonly endpoint: StorageACKEndpoint; readonly lease: StorageACKRegistrationLease }
  | { readonly kind: 'retired' };

class RetiredRegistrationSession extends Error {}

/** A generation owns the registration state, endpoint, and its local transport. */
class StorageACKRegistrationSession {
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

  private createLease(): StorageACKRegistrationLease {
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
  install(endpoint: StorageACKEndpoint, lease: StorageACKRegistrationLease): boolean {
    if (this.state.kind === 'retired' || this.state.kind === 'registered') {
      endpoint.dispose();
      return false;
    }
    if (this.state.kind === 'waiting-retry') clearTimeout(this.state.timer);
    this.state = { kind: 'registered', endpoint, lease };
    return true;
  }

  private scheduleRetry(attempt: StorageACKRegistrationAttempt): void {
    const plan = this.plan;
    if (!plan || this.state.kind !== 'registering') return;
    const timer = setTimeout(() => {
      if (this.state.kind !== 'waiting-retry' || this.state.timer !== timer) return;
      this.state = { kind: 'idle' };
      if (!plan.isStarted()) return;
      void this.track(Promise.resolve().then(() => this.runAttempt(retryAfter(attempt))));
    }, plan.retryDelayMs);
    timer.unref?.();
    this.state = { kind: 'waiting-retry', timer };
    plan.onRetryScheduled();
  }

  private async runAttempt(attempt: StorageACKRegistrationAttempt): Promise<void> {
    const plan = this.plan;
    if (!plan || this.state.kind === 'retired' || this.state.kind === 'registered') return;
    this.state = { kind: 'registering', attempt };
    const lease = this.createLease();
    const context: StorageACKRegistrationAttemptContext = {
      isActive: () => this.isCurrent(),
      guard: (work) => this.runStep(work),
      signerLost: () => lease.signerLost(),
    };
    try {
      const outcome = await plan.attempt(attempt, context);
      if (outcome.kind === 'registered') {
        this.install(outcome.endpoint, lease);
      } else if (this.state.kind === 'registering' && this.state.attempt === attempt) {
        if (outcome.kind === 'retryable') {
          this.scheduleRetry(attempt);
        } else {
          this.state = { kind: 'idle' };
        }
      }
    } catch (error) {
      if (error instanceof RetiredRegistrationSession || this.state.kind !== 'registering' || this.state.attempt !== attempt) return;
      plan.onError(phaseOf(attempt), error);
      this.scheduleRetry(attempt);
    }
  }

  start(plan: StorageACKRegistrationPlan): Promise<void> {
    if (this.plan) throw new Error('StorageACK registration session already started');
    if (!this.isCurrent()) throw new Error('StorageACK registration session retired');
    this.plan = plan;
    return this.track(this.runAttempt({ kind: 'initial' }));
  }

  private signerLost(lease: StorageACKRegistrationLease): boolean {
    if (!this.plan || this.state.kind !== 'registered' || this.state.lease !== lease) return false;
    const endpoint = this.state.endpoint;
    this.state = { kind: 'registering', attempt: { kind: 'failover' } };
    endpoint.dispose();
    void this.track(Promise.resolve().then(() => this.runAttempt({ kind: 'failover' })));
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
    return this.transport.send((signal) => work(endpoint, signal), timeoutMs);
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

  private begin(): StorageACKRegistrationSession {
    if (this.currentSession) {
      this.currentSession.retire();
      this.retiredSessions.add(this.currentSession);
    }
    this.currentSession = new StorageACKRegistrationSession();
    return this.currentSession;
  }

  /** Fence a previous lifetime before the agent begins asynchronous startup. */
  retireCurrentGeneration(): void {
    if (!this.currentSession) return;
    this.currentSession.retire();
    this.retiredSessions.add(this.currentSession);
    this.currentSession = null;
  }

  /** Start and own a complete registration generation. */
  startGeneration(plan: StorageACKRegistrationPlan): Promise<void> {
    return this.begin().start(plan);
  }

  /** Test fixtures exercise the same ownership and drain path as production. */
  installFixtureEndpoint(endpoint: StorageACKEndpoint): boolean {
    const session = this.begin();
    return session.install(endpoint, { signerLost: () => false });
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
